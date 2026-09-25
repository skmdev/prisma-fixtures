// Installs the tarball into an isolated consumer and owns a disposable database.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-fixtures-consumer-'))
const container = `prisma-fixtures-test-${process.pid}`
let started = false
function run(command, args, cwd = dir, environment = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    env: {
      ...process.env,
      PATH: [
        path.join(cwd, 'node_modules/.bin'),
        path.join(dir, 'node_modules/.bin'),
        process.env.PATH,
      ].join(path.delimiter),
      ...environment,
    },
  }).trim()
}
function write(file, content) {
  fs.writeFileSync(path.join(dir, file), content)
}

async function main() {
  try {
    const packed = JSON.parse(
      run('npm', ['pack', '--json', '--pack-destination', dir], root),
    )[0]
    assert.ok(packed.files.some(({ path: file }) => file === 'dist/index.d.ts'))
    assert.ok(packed.files.some(({ path: file }) => file === 'dist/cli.js'))
    assert.ok(
      packed.files.some(({ path: file }) => file === 'dist/generator.js'),
    )
    assert.ok(
      packed.files.some(
        ({ path: file }) => file === 'schema/fixture.schema.json',
      ),
    )
    assert.ok(
      packed.files.every(({ path: file }) =>
        /^(dist\/|schema\/fixture\.schema\.json$|package.json$|README.md$|LICENSE$|NOTICE$)/.test(
          file,
        ),
      ),
    )
    write(
      'package.json',
      JSON.stringify({
        name: 'fixture-consumer-test',
        private: true,
        type: 'commonjs',
      }),
    )
    run('npm', [
      'install',
      path.join(dir, packed.filename),
      '@prisma/client@7.10.0',
      '@prisma/adapter-pg@7.10.0',
      'prisma@7.10.0',
      'typescript@5.9.3',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
    ])
    console.log('PASS packed file allowlist and clean consumer install')

    run('docker', [
      'run',
      '--rm',
      '--detach',
      '--name',
      container,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_USER=fixture_test',
      '--env',
      'POSTGRES_PASSWORD=fixture_test',
      '--env',
      'POSTGRES_DB=prisma_fixtures_test',
      'postgres:17.9-alpine',
    ])
    started = true
    const port = run('docker', ['port', container, '5432/tcp'])
      .split(':')
      .at(-1)
    const url = `postgresql://fixture_test:fixture_test@127.0.0.1:${port}/prisma_fixtures_test`
    let ready = false
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        run('docker', ['exec', container, 'pg_isready', '-U', 'fixture_test'])
        ready = true
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    assert.ok(ready, 'disposable database is ready')
    fs.copyFileSync(
      path.join(__dirname, 'schema.prisma'),
      path.join(dir, 'schema.prisma'),
    )
    write(
      'prisma.config.ts',
      `export default { schema: './schema.prisma', datasource: { url: ${JSON.stringify(url)} } }`,
    )
    const prisma = path.join(root, 'node_modules/prisma/build/index.js')
    run(process.execPath, [prisma, 'generate'])
    assert.ok(fs.existsSync(path.join(dir, 'fixture-schema/schema.json')))
    run(process.execPath, [prisma, 'db', 'push'])
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          strict: true,
          skipLibCheck: true,
          declaration: true,
          rewriteRelativeImportExtensions: true,
          outDir: 'compiled',
        },
        include: ['generated/**/*.ts'],
      }),
    )
    run(process.execPath, [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      'tsconfig.json',
    ])
    write(
      'client.cjs',
      `const {PrismaClient} = require('./compiled/client.js'); const {PrismaPg} = require('@prisma/adapter-pg'); module.exports = () => new PrismaClient({adapter:new PrismaPg({connectionString:${JSON.stringify(url)}})});`,
    )
    fs.mkdirSync(path.join(dir, 'fixtures'))
    write(
      'fixtures/normalize.cjs',
      `module.exports = class {
      async preProcess(name, data) { return { ...data, name: name + ': ' + data.name } }
    }`,
    )
    write(
      'fixtures/users.yml',
      `entity: User
processor: ./normalize
items:
  user{1..3}:
    email: 'user($current)@example.test'
    name: '{{name.firstName}} {{name.lastName}}'
`,
    )
    write(
      'fixtures/posts.yml',
      `entity: Post
connectedFields: [author]
items:
  post{1..3}:
    title: 'Post ($current)'
    author: '@user($current)'
`,
    )
    write(
      'fixtures/groups.yml',
      `entity: Group
connectedFields: [users]
items:
  group1:
    name: Team
    users: ['@user1', '@user2']
`,
    )
    const fixtureCli = path.join(dir, 'node_modules/.bin/prisma-fixtures')
    const initDirectory = path.join(dir, 'init-smoke')
    fs.mkdirSync(initDirectory)
    assert.match(
      run(fixtureCli, ['init'], initDirectory),
      /Created .prisma-fixtures/,
    )
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(initDirectory, '.prisma-fixtures'), 'utf8'),
      ),
      { fixtures: ['./fixtures'] },
    )
    assert.match(
      run(fixtureCli, [
        './fixtures',
        '--lint',
        '--schema',
        './fixture-schema/schema.json',
      ]),
      /Linted 7 fixtures.*model schema/,
    )
    write(
      'invalid-model.yml',
      'entity: User\nitems:\n  invalid:\n    email: 123\n    name: Example\n',
    )
    assert.throws(
      () =>
        run(fixtureCli, [
          'invalid-model.yml',
          '--lint',
          '--schema',
          './fixture-schema/schema.json',
        ]),
      (error) =>
        error.status === 1 && /email.*string/.test(error.stderr.toString()),
    )
    write(
      'check-schema.cjs',
      `const assert = require('node:assert/strict'); const schema = require('@skmdev/prisma-fixtures/schema.json'); assert.equal(schema.type, 'object'); assert.ok(schema.required.includes('items'));`,
    )
    run(process.execPath, ['check-schema.cjs'])
    write(
      'check.cjs',
      `
      const assert = require('node:assert/strict')
      const {loadFixtures, readFixtureDefinitions} = require('@skmdev/prisma-fixtures')
      const prisma = require('./client.cjs')()
      ;(async () => {
        try {
          const records = await prisma.$transaction(tx => loadFixtures(tx, readFixtureDefinitions('./fixtures')))
          assert.equal(Object.keys(records).length, 7)
          assert.match(records.user1.name, /^user1: /)
          assert.equal(await prisma.post.count(), 3)
          assert.equal((await prisma.group.findFirst({include:{users:true}})).users.length, 2)
          const defs = [{name:'first',entity:'User',parameters:{},data:{email:'rolled-back@example.test',name:'Rollback'}},{name:'conflict',entity:'User',parameters:{},data:{email:'user1@example.test',name:'Conflict'}}]
          await assert.rejects(prisma.$transaction(tx => loadFixtures(tx, defs)))
          assert.equal(await prisma.user.count({where:{email:'rolled-back@example.test'}}), 0)
          const scalar = await loadFixtures(prisma, [{name:'person',entity:'User',parameters:{},data:{email:'scalar@example.test',name:'Scalar'}},{name:'article',entity:'Post',parameters:{},data:{title:'Scalar link',authorId:'@person.id'}}])
          assert.equal(scalar.article.authorId, scalar.person.id)
          console.log('PASS real Prisma 7 create, connections, scalar references and transaction rollback')
        } finally { await prisma.$disconnect() }
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `,
    )
    console.log(run(process.execPath, ['check.cjs']))
    write(
      'check.mjs',
      `import {readFixtureDefinitions,loadFixtures,cleanFixtures,resetFixtures} from '@skmdev/prisma-fixtures'; import assert from 'node:assert/strict'; assert.equal(typeof loadFixtures,'function'); assert.equal(typeof cleanFixtures,'function'); assert.equal(typeof resetFixtures,'function'); assert.equal(readFixtureDefinitions('./fixtures').length,7);`,
    )
    run(process.execPath, ['check.mjs'])
    write(
      'check.cts',
      `import {loadFixtures,readFixtureDefinitions,cleanFixtures,resetFixtures,type FixtureLoadOptions,type FixtureResetOptions,type FixtureProcessor} from '@skmdev/prisma-fixtures'; import {PrismaClient} from './generated/client'; declare const prisma: PrismaClient; const loadOptions:FixtureLoadOptions={seed:0,refDate:'2026-01-01T00:00:00.000Z'}; const resetOptions:FixtureResetOptions={...loadOptions,preserveTables:[]}; void loadFixtures(prisma,readFixtureDefinitions('./fixtures')); void prisma.$transaction(tx => loadFixtures(tx, [], loadOptions)); void prisma.$transaction(tx => cleanFixtures(tx,{preserveTables:['public.Audit']})); const writer=async()=>({}); void prisma.$transaction(tx => loadFixtures(tx, [], loadOptions, writer)); void prisma.$transaction(tx => resetFixtures(tx, [], writer)); void prisma.$transaction(tx => resetFixtures(tx, [], resetOptions, writer)); const processor:FixtureProcessor={preProcess:async (_name,data)=>data}; void processor;`,
    )
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
    write(
      'cli.yml',
      `entity: User\nitems:\n  cliUser:\n    email: cli@example.test\n    name: CLI\n`,
    )
    write(
      '.prisma-fixtures',
      JSON.stringify({
        fixtures: ['./cli.yml'],
        client: './client.cjs',
        schema: './fixture-schema/schema.json',
        preserveTables: ['extra.keep"; DROP TABLE "User"; --'],
      }),
    )
    console.log(run(path.join(dir, 'node_modules/.bin/prisma-fixtures'), []))
    write(
      'cli-rollback.yml',
      `entity: User
items:
  temporary:
    email: cli-rollback@example.test
    name: Rollback
  duplicate:
    email: user1@example.test
    name: Conflict
`,
    )
    assert.throws(
      () =>
        run(path.join(dir, 'node_modules/.bin/prisma-fixtures'), [
          'cli-rollback.yml',
          '--client',
          './client.cjs',
        ]),
      (error) =>
        error.status === 1 &&
        /FIXTURE_WRITE_FAILED/.test(error.stderr.toString()),
    )
    write(
      'count.cjs',
      `const assert=require('node:assert/strict');const prisma=require('./client.cjs')();Promise.all([prisma.user.count({where:{email:'cli@example.test'}}),prisma.user.count({where:{email:'cli-rollback@example.test'}})]).then(counts=>assert.deepEqual(counts,[1,0])).finally(()=>prisma.$disconnect()).catch(()=>{process.exitCode=1});`,
    )
    run(process.execPath, ['count.cjs'])
    console.log(
      'PASS packed CJS, ESM, TypeScript generated-client consumer and CLI commit/rollback',
    )
    write(
      'cleanup.cjs',
      `
      const assert = require('node:assert/strict')
      const { cleanFixtures, resetFixtures, readFixtureDefinitions } = require('@skmdev/prisma-fixtures')
      const prisma = require('./client.cjs')()
      const preserve = { preserveTables: ['extra.keep"; DROP TABLE "User"; --'] }
      const preservedQuery = 'SELECT * FROM "extra"."keep""; DROP TABLE ""User""; --" ORDER BY id'
      ;(async () => {
        try {
          await prisma.$executeRawUnsafe('CREATE TABLE "_prisma_migrations" (id text PRIMARY KEY)')
          await prisma.$executeRawUnsafe('INSERT INTO "_prisma_migrations" VALUES ($1)', 'keep')
          await prisma.$executeRawUnsafe('CREATE SCHEMA "extra"')
          await prisma.$executeRawUnsafe('CREATE TABLE "extra"."odd""table" (id int PRIMARY KEY, user_id int REFERENCES "User"(id))')
          await prisma.$executeRawUnsafe('INSERT INTO "extra"."odd""table" SELECT 1, id FROM "User" LIMIT 1')
          await prisma.$executeRawUnsafe('CREATE TABLE "extra"."keep""; DROP TABLE ""User""; --" (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text)')
          await prisma.$executeRawUnsafe('INSERT INTO "extra"."keep""; DROP TABLE ""User""; --" (note) VALUES ($1)', 'keep')
          await assert.rejects(
            prisma.$transaction(tx => cleanFixtures(tx, {preserveTables:['extra.missing']})),
            /preserve table not found/,
          )
          assert.ok(await prisma.user.count())
          assert.deepEqual(await prisma.$queryRawUnsafe(preservedQuery), [{id:1n,note:'keep'}])
          await prisma.$executeRawUnsafe('CREATE TABLE "preserved_reference" (id int PRIMARY KEY, user_id int REFERENCES "User"(id))')
          await prisma.$executeRawUnsafe('INSERT INTO "preserved_reference" SELECT 1, id FROM "User" LIMIT 1')
          await assert.rejects(
            prisma.$transaction(tx => cleanFixtures(tx, {preserveTables:[...preserve.preserveTables,'public.preserved_reference']})),
          )
          assert.ok(await prisma.user.count())
          assert.equal((await prisma.$queryRawUnsafe('SELECT * FROM "preserved_reference"')).length, 1)
          assert.deepEqual(await prisma.$queryRawUnsafe(preservedQuery), [{id:1n,note:'keep'}])
          await prisma.$executeRawUnsafe('DROP TABLE "preserved_reference"')
          await prisma.$executeRawUnsafe('CREATE TABLE "events" (id int) PARTITION BY RANGE (id)')
          await prisma.$executeRawUnsafe('CREATE TABLE "events_first" PARTITION OF "events" FOR VALUES FROM (0) TO (100)')
          await prisma.$executeRawUnsafe('INSERT INTO "events" VALUES (1)')
          const sentinelUserCount = await prisma.user.count()
          await assert.rejects(
            prisma.$transaction(tx => cleanFixtures(tx, {preserveTables:['public.events']})),
            /excluded descendant tables/,
          )
          assert.equal((await prisma.$queryRawUnsafe('SELECT * FROM ONLY "events_first"')).length, 1)
          assert.equal(await prisma.user.count(), sentinelUserCount)
          assert.deepEqual(await prisma.$queryRawUnsafe(preservedQuery), [{id:1n,note:'keep'}])
          await assert.rejects(
            prisma.$transaction(tx => cleanFixtures(tx, {preserveTables:['public.events_first']})),
            /excluded descendant tables/,
          )
          assert.equal((await prisma.$queryRawUnsafe('SELECT * FROM ONLY "events_first"')).length, 1)
          await prisma.$executeRawUnsafe('CREATE TABLE "inherit_parent" (id int)')
          await prisma.$executeRawUnsafe('CREATE TABLE "inherit_child" (note text) INHERITS ("inherit_parent")')
          await prisma.$executeRawUnsafe('INSERT INTO "inherit_child" VALUES (1, $1)', 'keep-child')
          await assert.rejects(
            prisma.$transaction(tx => cleanFixtures(tx, {preserveTables:['public.inherit_parent']})),
            /excluded descendant tables/,
          )
          assert.deepEqual(
            await prisma.$queryRawUnsafe('SELECT * FROM ONLY "inherit_child"'),
            [{id:1,note:'keep-child'}],
          )
          assert.equal(await prisma.user.count(), sentinelUserCount)
          assert.deepEqual(await prisma.$queryRawUnsafe(preservedQuery), [{id:1n,note:'keep'}])
          await prisma.$executeRawUnsafe('CREATE EXTENSION postgres_fdw')
          await prisma.$executeRawUnsafe('CREATE SERVER fixture_remote FOREIGN DATA WRAPPER postgres_fdw')
          await prisma.$executeRawUnsafe('CREATE FOREIGN TABLE "remote_events" PARTITION OF "events" FOR VALUES FROM (100) TO (200) SERVER fixture_remote')
          await assert.rejects(prisma.$transaction(tx => cleanFixtures(tx)), /excluded descendant tables/)
          assert.equal((await prisma.$queryRawUnsafe('SELECT * FROM ONLY "events_first"')).length, 1)
          assert.ok(await prisma.user.count())
          await prisma.$executeRawUnsafe('DROP FOREIGN TABLE "remote_events"')
          await prisma.$executeRawUnsafe('CREATE TABLE "migration_parent" (id text)')
          await prisma.$executeRawUnsafe('ALTER TABLE "_prisma_migrations" INHERIT "migration_parent"')
          await assert.rejects(prisma.$transaction(tx => cleanFixtures(tx)), /excluded descendant tables/)
          assert.deepEqual(await prisma.$queryRawUnsafe('SELECT * FROM "_prisma_migrations"'), [{id:'keep'}])
          await prisma.$executeRawUnsafe('ALTER TABLE "_prisma_migrations" NO INHERIT "migration_parent"')
          const definitions = readFixtureDefinitions('./fixtures')
          const before = await prisma.user.findMany({orderBy:{id:'asc'}})
          const invalid = [
            {name:'one',entity:'User',parameters:{},data:{email:'same@example.test',name:'One'}},
            {name:'two',entity:'User',parameters:{},data:{email:'same@example.test',name:'Two'}}
          ]
          await assert.rejects(prisma.$transaction(tx => resetFixtures(tx, invalid)))
          assert.deepEqual(await prisma.user.findMany({orderBy:{id:'asc'}}), before)
          assert.equal((await prisma.$queryRawUnsafe('SELECT * FROM "extra"."odd""table"')).length, 1)
          const seededReset = {...preserve, seed:123, refDate:'2026-01-01T00:00:00.000Z'}
          const records = await prisma.$transaction(tx => resetFixtures(tx, definitions, seededReset))
          assert.equal(Object.keys(records).length, 7)
          assert.equal(await prisma.user.count(), 3)
          assert.equal(await prisma.post.count(), 3)
          assert.equal((await prisma.group.findFirst({include:{users:true}})).users.length, 2)
          assert.equal((await prisma.$queryRawUnsafe('SELECT * FROM "extra"."odd""table"')).length, 0)
          assert.equal((await prisma.$queryRawUnsafe('SELECT * FROM "events"')).length, 0)
          assert.ok(records.user1.id > Math.max(...before.map(row => row.id)), 'sequence was not restarted')
          const generated = await prisma.user.findMany({select:{email:true,name:true},orderBy:{email:'asc'}})
          await prisma.$executeRawUnsafe('INSERT INTO "extra"."keep""; DROP TABLE ""User""; --" (note) VALUES ($1)', 'keep-next')
          assert.deepEqual(await prisma.$queryRawUnsafe(preservedQuery), [{id:1n,note:'keep'},{id:2n,note:'keep-next'}])
          await prisma.$transaction(tx => cleanFixtures(tx, preserve))
          await prisma.$transaction(tx => cleanFixtures(tx, preserve))
          assert.deepEqual(await Promise.all([prisma.user.count(), prisma.post.count(), prisma.group.count()]), [0,0,0])
          assert.equal((await prisma.$queryRawUnsafe('SELECT * FROM "_GroupToUser"')).length, 0)
          assert.deepEqual(await prisma.$queryRawUnsafe('SELECT * FROM "_prisma_migrations"'), [{id:'keep'}])
          assert.deepEqual(await prisma.$queryRawUnsafe(preservedQuery), [{id:1n,note:'keep'},{id:2n,note:'keep-next'}])
          await prisma.$transaction(tx => resetFixtures(tx, definitions, seededReset))
          assert.deepEqual(await prisma.user.findMany({select:{email:true,name:true},orderBy:{email:'asc'}}), generated)
          console.log('PASS seeded whole-database cleanup/reset, preserved tables/sequences, FK rollback, partitions, quoted identifiers, schema and migration preservation')
        } finally { await prisma.$disconnect() }
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `,
    )
    console.log(run(process.execPath, ['cleanup.cjs']))
    console.log(run(fixtureCli, ['./fixtures', '--reset']))
    write(
      'reset-failure.yml',
      'entity: User\nitems:\n  one: { email: duplicate@example.test, name: One }\n  two: { email: duplicate@example.test, name: Two }\n',
    )
    assert.throws(
      () => run(fixtureCli, ['reset-failure.yml', '--reset']),
      (error) =>
        error.status === 1 &&
        /FIXTURE_WRITE_FAILED/.test(error.stderr.toString()),
    )
    write(
      'check-reset.cjs',
      `const assert=require('node:assert/strict');const prisma=require('./client.cjs')();Promise.all([prisma.user.count(),prisma.post.count(),prisma.group.count(),prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "extra"."keep""; DROP TABLE ""User""; --"')]).then(results=>assert.deepEqual(results,[3,3,1,[{count:2}]])).finally(()=>prisma.$disconnect()).catch(()=>{process.exitCode=1});`,
    )
    run(process.execPath, ['check-reset.cjs'])
    console.log(run(fixtureCli, ['--clean']))
    write(
      'check-clean.cjs',
      `const assert=require('node:assert/strict');const prisma=require('./client.cjs')();Promise.all([prisma.user.count(),prisma.post.count(),prisma.group.count(),prisma.$queryRawUnsafe('SELECT * FROM "_prisma_migrations"'),prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "extra"."keep""; DROP TABLE ""User""; --"')]).then(results=>assert.deepEqual(results,[0,0,0,[{id:'keep'}],[{count:2}]])).finally(()=>prisma.$disconnect()).catch(()=>{process.exitCode=1});`,
    )
    run(process.execPath, ['check-clean.cjs'])
    console.log(
      'PASS installed CLI database clean/reset and failed-reset rollback',
    )
  } finally {
    if (started) run('docker', ['stop', container])
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}
main().catch((error) => {
  console.error(
    [error.stdout, error.stderr].filter(Boolean).join('\n') || error.message,
  )
  process.exitCode = 1
})
