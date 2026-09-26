const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

module.exports = async function runPrisma8Integration({
  root,
  temporary,
  tarball,
  url,
}) {
  const dir = path.join(temporary, 'prisma8-consumer')
  fs.mkdirSync(dir)
  let nodeOptions

  const run = (command, args, environment = {}) =>
    execFileSync(command, args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      env: {
        ...process.env,
        PATH: [path.join(dir, 'node_modules/.bin'), process.env.PATH].join(
          path.delimiter,
        ),
        PRISMA_DISABLE_TELEMETRY: '1',
        PRISMA_SKILLS_CHECK: '0',
        ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
        ...environment,
      },
    }).trim()
  const write = (file, content) => {
    const target = path.join(dir, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }

  write(
    'package.json',
    JSON.stringify({ name: 'prisma8-fixture-consumer', private: true }),
  )
  run('npm', [
    'install',
    tarball,
    'prisma@8.0.0-rc.17',
    '@prisma/orm-postgres@8.0.0-rc.12',
    'temporal-polyfill@1.0.5',
    'typescript@5.9.3',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
  ])

  nodeOptions = '--require temporal-polyfill/full/global'
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(dir, 'node_modules/prisma/package.json'),
        'utf8',
      ),
    ).version,
    '8.0.0-rc.17',
  )
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(dir, 'node_modules/@prisma/orm-postgres/package.json'),
        'utf8',
      ),
    ).version,
    '8.0.0-rc.12',
  )

  const databaseUrl = new URL(url)
  databaseUrl.pathname = '/fixture_v8'
  const fixtureUrl = databaseUrl.toString()
  const rootRequire = createRequire(path.join(root, 'package.json'))
  const { Client } = rootRequire('pg')
  const admin = new Client({ connectionString: url })
  await admin.connect()
  try {
    await admin.query('CREATE DATABASE fixture_v8')
  } finally {
    await admin.end()
  }

  write(
    'contract.prisma',
    `// use prisma-8

model User {
  id Int @id @default(autoincrement())
  token String @default(uuid())
  happenedAt DateTime?
  total BigInt?
  totals BigInt[] @default([])
  blob Bytes?
  email String @unique
  name String @default("")
  payload Json?
  posts Post[]
  groups Group[]
  @@map("User")
}

model Post {
  id Int @id @default(autoincrement())
  title String
  authorId Int
  author User @relation(fields: [authorId], references: [id])
  @@map("Post")
}

model Group {
  id Int @id @default(autoincrement())
  name String
  users User[]
  @@map("Group")
}

model GroupToUser {
  groupId Int @map("A")
  userId Int @map("B")
  group Group @relation(fields: [groupId], references: [id])
  user User @relation(fields: [userId], references: [id])
  @@id([groupId, userId])
  @@map("_GroupToUser")
}

model Audit {
  id Int @id
  note String
  @@control(external)
  @@map("Audit")
}
`,
  )
  write(
    'prisma.config.ts',
    `import { definePrismaConfig } from 'prisma/config'
import { defineConfig } from '@prisma/orm-postgres/config'

export default definePrismaConfig({
  orm: defineConfig({
    contract: './contract.prisma',
    output: './generated',
    db: { connection: ${JSON.stringify(fixtureUrl)} },
  }),
})
`,
  )
  run('prisma', ['contract', 'emit'])

  const database = new Client({ connectionString: fixtureUrl })
  await database.connect()
  try {
    await database.query(
      'CREATE TABLE public."Audit" (id integer PRIMARY KEY, note text NOT NULL)',
    )
    await database.query(
      'INSERT INTO public."Audit" (id, note) VALUES (1, $1)',
      ['preserve'],
    )
  } finally {
    await database.end()
  }
  run('prisma', ['db', 'init', '--no-interactive'])

  write(
    'fixtures/users.json',
    JSON.stringify({
      entity: 'public.User',
      deferredFields: ['name'],
      items: {
        user1: {
          email: 'one@v8.test',
          name: 'Deferred One',
          happenedAt: '2026-01-02T03:04:05Z',
          total: '9007199254740993',
          totals: ['9007199254740993', 42],
          blob: 'aGVsbG8=',
          payload: { connect: { remains: 'ordinary JSON' } },
        },
        user2: { email: 'two@v8.test', name: 'Deferred Two' },
      },
    }),
  )
  write(
    'fixtures/posts.json',
    JSON.stringify({
      entity: 'Post',
      items: {
        post1: {
          title: 'Nested connect',
          author: { connect: { id: '@user1.id' } },
        },
        post2: {
          title: 'Nested create',
          author: {
            create: {
              email: 'nested@v8.test',
              name: 'Nested author',
              total: '2',
            },
          },
        },
      },
    }),
  )
  write(
    'fixtures/groups.json',
    JSON.stringify({
      entity: 'Group',
      items: {
        group1: {
          name: 'Fixture team',
          users: {
            connect: [{ id: '@user1.id' }, { id: '@user2.id' }],
          },
        },
      },
    }),
  )
  write(
    '.prisma-fixtures',
    JSON.stringify({
      fixtures: ['./fixtures'],
      schema: './fixture-schema/schema.json',
      timeout: 2000,
    }),
  )

  run('prisma-fixtures-generator', [
    './generated/contract.json',
    './fixture-schema',
  ])
  assert.match(
    run('prisma-fixtures', ['--lint']),
    /Linted 5 fixtures.*model schema/,
  )
  assert.match(
    run('prisma-fixtures', ['--reset']),
    /Reset and loaded 5 fixtures/,
  )

  const query = async (text, values = []) => {
    const client = new Client({ connectionString: fixtureUrl })
    await client.connect()
    try {
      return (await client.query(text, values)).rows
    } finally {
      await client.end()
    }
  }
  const markerCount = async () =>
    Number(
      (
        await query('SELECT count(*)::int AS count FROM prisma_contract.marker')
      )[0].count,
    )
  const markerBefore = await markerCount()
  assert.ok(markerBefore > 0)
  assert.deepEqual(
    await query(
      'SELECT (SELECT count(*)::int FROM public."User") AS users, (SELECT count(*)::int FROM public."Post") AS posts, (SELECT count(*)::int FROM public."Group") AS groups, (SELECT count(*)::int FROM public."_GroupToUser") AS memberships',
    ),
    [{ users: 3, posts: 2, groups: 1, memberships: 2 }],
  )
  assert.deepEqual(await query('SELECT note FROM public."Audit"'), [
    { note: 'preserve' },
  ])

  write(
    'exercise.cjs',
    `const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const fs = require('node:fs')
const {
  cleanFixtures,
  createPrisma8FixtureClient,
  loadFixtures,
  readFixtureDefinitions,
  resetFixtures,
} = require('@skmdev/prisma-fixtures')

;(async () => {
  const { default: postgres } = await import('@prisma/orm-postgres/runtime')
  const native = postgres({
    contractJson: JSON.parse(fs.readFileSync('./generated/contract.json', 'utf8')),
    url: ${JSON.stringify(fixtureUrl)},
  })
  const client = createPrisma8FixtureClient(native)
  const definitions = readFixtureDefinitions('./fixtures')
  try {
    const records = await client.$transaction(
      tx => resetFixtures(tx, definitions),
      { timeout: 2000 },
    )
    assert.equal(records.user1.name, 'Deferred One')
    assert.match(records.user1.token, /^[0-9a-f-]{36}$/)
    assert.equal(records.user1.total, 9007199254740993n)
    assert.deepEqual(records.user1.totals, [9007199254740993n, 42n])
    assert.equal(Buffer.from(records.user1.blob).toString(), 'hello')
    assert.equal(records.user1.happenedAt.toString(), '2026-01-02T03:04:05Z')
    assert.equal((await native.orm.public.User.where({email:'nested@v8.test'}).all())[0].total, 2n)
    assert.equal(records.user2.name, 'Deferred Two')
    assert.deepEqual(records.user1.payload, {
      connect: { remains: 'ordinary JSON' },
    })

    await assert.rejects(
      client.$transaction(async tx => {
        await loadFixtures(tx, [{
          name: 'rollback', entity: 'User', parameters: {},
          data: { email: 'rollback@v8.test', name: 'Rollback' },
        }])
        throw new Error('rollback sentinel')
      }, { timeout: 2000 }),
      /rollback sentinel/,
    )

    let escaped
    await assert.rejects(client.$transaction(async tx => {
      escaped = tx
      await loadFixtures(tx, [{
        name: 'timeout', entity: 'User', parameters: {},
        data: { email: 'timeout@v8.test', name: 'Timeout' },
      }])
      await delay(200)
      await loadFixtures(tx, [{
        name: 'tooLate', entity: 'User', parameters: {},
        data: { email: 'late@v8.test', name: 'Late' },
      }])
    }, { timeout: 100 }))
    await assert.rejects(loadFixtures(escaped, [{
      name: 'escaped', entity: 'User', parameters: {},
      data: { email: 'escaped@v8.test', name: 'Escaped' },
    }]))
    await delay(150)

    await assert.rejects(client.$transaction(async tx => {
      await loadFixtures(tx, [{
        name: 'inflight', entity: 'User', parameters: {},
        data: { email: 'inflight@v8.test', name: 'In flight' },
      }])
      await tx.$executeRawUnsafe('DO $$ BEGIN PERFORM pg_sleep(1); END $$;')
    }, { timeout: 100 }))

    const emails = (await native.orm.public.User.all()).map(row => row.email)
    for (const email of [
      'rollback@v8.test',
      'timeout@v8.test',
      'late@v8.test',
      'escaped@v8.test',
      'inflight@v8.test',
    ]) assert.equal(emails.includes(email), false)

    await client.$transaction(tx => cleanFixtures(tx), { timeout: 2000 })
    await client.$transaction(
      tx => resetFixtures(tx, definitions),
      { timeout: 2000 },
    )
    await client.$transaction(tx => cleanFixtures(tx), { timeout: 2000 })
  } finally {
    await client.$disconnect()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
`,
  )
  run(process.execPath, ['exercise.cjs'])
  assert.deepEqual(
    await query(
      `SELECT email FROM public."User" WHERE email IN ('rollback@v8.test', 'timeout@v8.test', 'late@v8.test', 'escaped@v8.test', 'inflight@v8.test')`,
    ),
    [],
  )
  assert.deepEqual(await query('SELECT note FROM public."Audit"'), [
    { note: 'preserve' },
  ])
  assert.equal(await markerCount(), markerBefore)

  write(
    '.prisma-fixtures-explicit',
    JSON.stringify({
      fixtures: ['./fixtures'],
      client: { module: './generated/contract.json', adapter: 'pg' },
      preserveTables: ['public.Audit'],
      timeout: 2000,
    }),
  )
  assert.match(
    run(
      'prisma-fixtures',
      ['--config', '.prisma-fixtures-explicit', '--databaseUrl', fixtureUrl],
      { DATABASE_URL: url },
    ),
    /Loaded 5 fixtures/,
  )
  assert.deepEqual(
    await query('SELECT email FROM public."User" ORDER BY email'),
    [
      { email: 'nested@v8.test' },
      { email: 'one@v8.test' },
      { email: 'two@v8.test' },
    ],
  )
  run(
    'prisma-fixtures',
    [
      '--config',
      '.prisma-fixtures-explicit',
      '--databaseUrl',
      fixtureUrl,
      '--clean',
    ],
    { DATABASE_URL: url },
  )
  assert.deepEqual(await query('SELECT note FROM public."Audit"'), [
    { note: 'preserve' },
  ])
  assert.equal(await markerCount(), markerBefore)

  write(
    'check.cjs',
    `const assert=require('node:assert/strict');const api=require('@skmdev/prisma-fixtures');assert.equal(typeof api.createPrisma8FixtureClient,'function')`,
  )
  write(
    'check.mjs',
    `import assert from 'node:assert/strict';import {createPrisma8FixtureClient} from '@skmdev/prisma-fixtures';assert.equal(typeof createPrisma8FixtureClient,'function')`,
  )
  write(
    'check.cts',
    `import {createPrisma8FixtureClient,loadFixtures,cleanFixtures,resetFixtures} from '@skmdev/prisma-fixtures';declare const db: Parameters<typeof createPrisma8FixtureClient>[0];const client=createPrisma8FixtureClient(db);void client.$transaction(tx=>loadFixtures(tx,[]),{timeout:100});void client.$transaction(tx=>cleanFixtures(tx),{timeout:100});void client.$transaction(tx=>resetFixtures(tx,[]),{timeout:100});void client.$disconnect();`,
  )
  run(process.execPath, ['check.cjs'])
  run(process.execPath, ['check.mjs'])
  run(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--target',
    'ES2022',
    '--module',
    'Node16',
    '--moduleResolution',
    'Node16',
    'check.cts',
  ])

  console.log(
    'PASS Prisma 8 contract schema, PostgreSQL 17 fixtures, relations, deferred updates, rollback, timeout, cleanup, CLI discovery/override and public imports',
  )
}
