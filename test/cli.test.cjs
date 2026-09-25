const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const cli = path.resolve(__dirname, '../dist/cli.js')
function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-fixtures-cli-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    'entity: User\nitems:\n  user1:\n    name: Example\n',
  )
  return dir
}

test('zero-argument PrismaFixtures loads config with a supplied client', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, '.prisma-fixtures'),
    JSON.stringify({ fixtures: ['./users.yml'], timeout: 1234 }),
  )
  const entry = JSON.stringify(path.resolve(__dirname, '../dist/index.js'))
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict')
       const { PrismaFixtures } = require(${entry})
       const events = []
       const client = {
         async $transaction(action, { timeout }) {
           assert.equal(timeout, 1234)
           events.push('transaction')
           return action({ user: { create: async ({ data }) => ({ id: 7, ...data }) } })
         },
         async $disconnect() { events.push('disconnect') },
       }
       ;(async () => {
         const fixtures = new PrismaFixtures()
         const records = await fixtures.load(client)
         assert.equal(records.user1.name, 'Example')
         assert.deepEqual(events, ['transaction'])
         require('node:fs').writeFileSync('.prisma-fixtures', JSON.stringify({
           fixtures: ['./users.yml'],
           client: { module: './client.cjs', adapter: 'pg', guard: './guard.cjs' },
         }))
         await assert.rejects(fixtures.load(client), /Guarded fixture config requires the CLI/)
         assert.deepEqual(events, ['transaction'])
       })().catch((error) => { console.error(error); process.exitCode = 1 })`,
    ],
    { cwd: dir, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
})

test('init creates a minimal config and never overwrites it', (t) => {
  const dir = workspace(t)
  assert.equal(run(['init', '--reset'], dir).status, 1)
  assert.ok(!fs.existsSync(path.join(dir, '.prisma-fixtures')))

  const initialized = run(['init'], dir)
  assert.equal(initialized.status, 0, initialized.stderr)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, '.prisma-fixtures'))),
    {
      fixtures: ['./fixtures'],
    },
  )
  assert.ok(fs.statSync(path.join(dir, 'fixtures')).isDirectory())
  assert.deepEqual(JSON.parse(run(['--list'], dir).stdout), [])

  assert.equal(run(['init'], dir).status, 1)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, '.prisma-fixtures'))),
    {
      fixtures: ['./fixtures'],
    },
  )

  const prismaDir = workspace(t)
  fs.mkdirSync(path.join(prismaDir, 'prisma/fixtures'), { recursive: true })
  assert.equal(run(['init'], prismaDir).status, 0)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(prismaDir, '.prisma-fixtures'))),
    { fixtures: ['./prisma/fixtures'] },
  )

  const sharedDir = workspace(t)
  assert.equal(run(['init', '../missing-fixtures'], sharedDir).status, 1)
  assert.ok(!fs.existsSync(path.join(sharedDir, '.prisma-fixtures')))
  assert.equal(run(['init', './users.yml'], sharedDir).status, 1)
  assert.equal(run(['init', './'], sharedDir).status, 0)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(sharedDir, '.prisma-fixtures'))),
    { fixtures: ['./'] },
  )
})

test('lint uses config and stays inert without a client or database', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, '.prisma-fixtures'),
    JSON.stringify({ fixtures: ['./users.yml'] }),
  )
  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    `entity: User
processor: ./missing.cjs
items:
  user{1..2}:
    name: "<%= (() => { throw new Error('PRIVATE-TEMPLATE') })() %>"
    email: '{{missing.provider}}'
    parameter: '<{process.env.MISSING_FIXTURE_LINT_VARIABLE}>'
    reference: '@<%= name %>'
`,
  )
  const result = run(
    ['--lint', '--client', 'missing.cjs', '--require', './missing.cjs'],
    dir,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Linted 2 fixtures \(syntax and structure/)
  assert.match(
    result.stdout,
    /8 dynamic values or multi-candidate references unresolved/,
  )
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-TEMPLATE/)
  assert.equal(run(['--lint'], dir).status, 0)
  assert.equal(run(['--lint', '--list'], dir).status, 1)
})

test('configured generated Prisma client needs no client wrapper and honors an optional guard', (t) => {
  const dir = workspace(t)
  const adapterDirectory = path.join(dir, 'node_modules/@prisma/adapter-pg')
  fs.mkdirSync(adapterDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(adapterDirectory, 'index.js'),
    `exports.PrismaPg = class { constructor({connectionString}) { if (connectionString !== 'postgresql://fixture-local/test') throw Error('PRIVATE-URL') } }`,
  )
  fs.writeFileSync(
    path.join(dir, 'generated-client.cjs'),
    `const fs=require('node:fs'); exports.PrismaClient=class {
      constructor({adapter}) { if (!adapter) throw Error('PRIVATE-ADAPTER'); fs.appendFileSync('events.txt','client\\n') }
      async $transaction(action,{timeout}) { if(timeout!==1234) throw Error('PRIVATE-TIMEOUT'); fs.appendFileSync('events.txt','transaction\\n'); return action({user:{create:async({data})=>({id:1,...data})}}) }
      async $disconnect() { fs.appendFileSync('events.txt','disconnect\\n') }
    }`,
  )
  fs.writeFileSync(
    path.join(dir, 'guard.cjs'),
    `const fs=require('node:fs'); exports.fixtureDatabaseUrl=(env)=>{ if(env.APP_ENV!=='test') throw Error('PRIVATE-ENV'); fs.appendFileSync('events.txt','guard-url\\n'); return env.DATABASE_URL }; exports.fixtureTransaction=(client,action,timeout)=>{ fs.appendFileSync('events.txt','guard-transaction\\n'); return client.$transaction(action,{timeout}) }`,
  )
  fs.writeFileSync(
    path.join(dir, '.prisma-fixtures'),
    JSON.stringify({
      fixtures: ['./users.yml'],
      client: {
        module: './generated-client.cjs',
        adapter: 'pg',
        guard: './guard.cjs',
      },
      timeout: 1234,
    }),
  )
  const loaded = run([], dir, {
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://fixture-local/test',
  })
  assert.equal(loaded.status, 0, loaded.stderr)
  assert.match(loaded.stdout, /Loaded 1 fixtures/)
  assert.deepEqual(
    fs.readFileSync(path.join(dir, 'events.txt'), 'utf8').trim().split('\n'),
    ['guard-url', 'client', 'guard-transaction', 'transaction', 'disconnect'],
  )
  const rejected = run([], dir, {
    APP_ENV: 'production',
    DATABASE_URL: 'PRIVATE-URL',
  })
  assert.equal(rejected.status, 1)
  assert.doesNotMatch(rejected.stderr, /PRIVATE/)
  assert.equal(
    fs.readFileSync(path.join(dir, 'events.txt'), 'utf8').match(/client/g)
      ?.length,
    1,
  )
  assert.equal(run(['--list'], dir, { APP_ENV: 'production' }).status, 0)
})

test('lint reports YAML locations and safe errors without fixture values', (t) => {
  const dir = workspace(t)
  for (const [contents, diagnostic] of [
    [
      'entity: User\nitems:\n  user1:\n    name: PRIVATE-RECORD\n    name: PRIVATE-RECORD\n',
      /DUPLICATE_KEY at 5:5/,
    ],
    ['entity: User\nitems:\n  user1: { name: [PRIVATE-RECORD }', /at \d+:\d+/],
    [
      'entity: User\nunknown: PRIVATE-RECORD\nitems: {}',
      /Invalid fixture document/,
    ],
    [
      'entity: User\nitems:\n  user1: &record { name: PRIVATE-RECORD }\n  user2: *record',
      /Invalid fixture document/,
    ],
    [
      'entity: User\nitems:\n  user{3..1}: { name: PRIVATE-RECORD }',
      /Invalid fixture document/,
    ],
  ]) {
    fs.writeFileSync(path.join(dir, 'users.yml'), contents)
    const result = run(['users.yml', '--lint', '--debug'], dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /users.yml/)
    assert.match(result.stderr, diagnostic)
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-RECORD/)
  }
})

test('lint uses a config-relative schema, respects overrides and keeps values private', (t) => {
  const dir = workspace(t)
  fs.mkdirSync(path.join(dir, 'config'))
  fs.writeFileSync(
    path.join(dir, 'config/.prisma-fixtures'),
    JSON.stringify({ fixtures: ['../users.yml'], schema: './schema.json' }),
  )
  const schema = {
    type: 'object',
    properties: {
      entity: { enum: ['User'] },
      items: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, age: { type: 'integer' } },
          additionalProperties: false,
        },
      },
    },
  }
  fs.writeFileSync(path.join(dir, 'config/schema.json'), JSON.stringify(schema))
  const args = ['--config', 'config/.prisma-fixtures', '--lint']
  const valid = run(args, dir)
  assert.equal(valid.status, 0, valid.stderr)
  assert.match(valid.stdout, /model schema/)
  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    'entity: User\nitems:\n  user1: { name: Example, age: PRIVATE-VALUE }',
  )
  const invalid = run(args, dir)
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /user1.*age.*integer/)
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /PRIVATE-VALUE/)
  fs.writeFileSync(path.join(dir, 'override.json'), '{}')
  assert.equal(run([...args, '--schema', 'override.json'], dir).status, 0)
  fs.writeFileSync(path.join(dir, 'users.yml'), 'entity: Missing\nitems: {}\n')
  const empty = run(args, dir)
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /entity.*allowed values/)
  fs.writeFileSync(path.join(dir, 'override.json'), '{PRIVATE-SCHEMA')
  const malformed = run([...args, '--schema', 'override.json'], dir)
  assert.equal(malformed.status, 1)
  assert.match(malformed.stderr, /Invalid fixture JSON Schema/)
  assert.doesNotMatch(malformed.stderr, /PRIVATE-SCHEMA/)
  assert.equal(
    run(['users.yml', '--list', '--schema', 'missing.json'], dir).status,
    0,
  )
})

test('lint accepts JSON and rejects duplicates and total record overflow across paths', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'posts.json'),
    JSON.stringify({ entity: 'Post', items: { post1: { author: '@user1' } } }),
  )
  assert.match(
    run(['users.yml', 'posts.json', '--lint'], dir).stdout,
    /Linted 2 fixtures/,
  )
  const duplicate = run(['users.yml', 'users.yml', '--lint'], dir)
  assert.equal(duplicate.status, 1)
  assert.match(duplicate.stderr, /Duplicate fixture name across paths/)
  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    'entity: User\nitems:\n  user{1..2000}: {}',
  )
  const overflow = run(['users.yml', 'posts.json', '--lint'], dir)
  assert.equal(overflow.status, 1)
  assert.match(overflow.stderr, /Too many fixture definitions/)
})

test('lint validates literal references, candidate sets and definite cycles', (t) => {
  const dir = workspace(t)
  const cases = [
    [
      'entity: User\nitems:\n  user1:\n    nested: { author: "@missing" }\n',
      ['FIXTURE_REFERENCE_MISSING', 'users.yml', 'user1', '/nested/author'],
    ],
    [
      'entity: User\nitems:\n  user1: { peer: "@bad.name.more" }\n',
      ['FIXTURE_REFERENCE_INVALID', '/peer'],
    ],
    [
      'entity: User\nitems:\n  user1: { peer: "@missing*" }\n',
      ['during linting references', 'FIXTURE_REFERENCE_MISSING', '/peer'],
    ],
    [
      'entity: User\nitems:\n  user1: {}\n  post1: { peer: "@user{1..2}" }\n',
      ['FIXTURE_REFERENCE_MISSING', 'post1', '/peer'],
    ],
    [
      'entity: User\nitems:\n  user1: { peer: "@user1" }\n',
      ['FIXTURE_DEPENDENCY_CYCLE', 'user1 -> user1'],
    ],
    [
      'entity: User\nitems:\n  user{1..1}: { peer: "@missing($current)" }\n',
      ['FIXTURE_REFERENCE_MISSING', 'user1', '/peer'],
    ],
  ]
  for (const [contents, expected] of cases) {
    fs.writeFileSync(path.join(dir, 'users.yml'), contents)
    const result = run(['users.yml', '--lint'], dir)
    assert.equal(result.status, 1, result.stderr)
    for (const text of expected) assert.match(result.stderr, new RegExp(text))
  }

  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    'entity: User\nitems:\n  user1: { peer: "@post1" }\n',
  )
  fs.writeFileSync(
    path.join(dir, 'posts.yml'),
    'entity: Post\nitems:\n  post1: { author: "@user1" }\n',
  )
  const crossFile = run(['users.yml', 'posts.yml', '--lint'], dir)
  assert.equal(crossFile.status, 1)
  assert.match(crossFile.stderr, /FIXTURE_DEPENDENCY_CYCLE/)
  assert.match(crossFile.stderr, /user1 -> post1 -> user1/)
})

test('lint leaves dynamic and ambiguous references inert and reports partial coverage', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    `entity: User
processor: ./PRIVATE-MISSING-PROCESSOR.cjs
items:
  user1:
    post: '@post1'
    escaped: '@@missing'
    ejs: '@<%= (() => { throw Error("PRIVATE-TEMPLATE") })() %>'
    faker: '{{missing.provider}}'
    parameter: '<{process.env.PRIVATE_ENV}>'
  user2: {}
`,
  )
  fs.writeFileSync(
    path.join(dir, 'posts.yml'),
    'entity: Post\nitems:\n  post1: { author: "@user*" }\n',
  )
  const ambiguous = run(['users.yml', 'posts.yml', '--lint'], dir)
  assert.equal(ambiguous.status, 0, ambiguous.stderr)
  assert.match(
    ambiguous.stdout,
    /4 dynamic values or multi-candidate references unresolved/,
  )
  assert.doesNotMatch(ambiguous.stdout + ambiguous.stderr, /PRIVATE-/)

  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    'entity: User\nitems:\n  user1: { post: "@post1" }\n',
  )
  const definite = run(['users.yml', 'posts.yml', '--lint'], dir)
  assert.equal(definite.status, 1)
  assert.match(definite.stderr, /FIXTURE_DEPENDENCY_CYCLE/)

  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    'entity: User\nitems:\n  user1: { peer: "@missing" }\n',
  )
  assert.equal(run(['users.yml', '--list'], dir).status, 0)
})

test('help, version and list work without a client or executing fixture code', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    `entity: User
processor: ./missing.cjs
items:
  user{1..2}:
    name: "<%= (() => { throw new Error('must not run') })() %>"
`,
  )
  assert.match(run(['--help'], dir).stdout, /--client/)
  assert.equal(run(['--version'], dir).stdout.trim(), '0.1.0')
  const result = run(['users.yml', '--list', '--require', './missing.cjs'], dir)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [
    { name: 'user1', entity: 'User' },
    { name: 'user2', entity: 'User' },
  ])
})

test('factory receives options; preload runs; load commits and always disconnects', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'preload.cjs'),
    'global.fixturePreloaded = true',
  )
  fs.writeFileSync(
    path.join(dir, 'client.mjs'),
    `
    import fs from 'node:fs'
    export default async ({ databaseUrl }) => ({
      async $transaction(action, options) {
        if (!global.fixturePreloaded || databaseUrl !== 'test-only-url' || options.timeout !== 1234) throw Error('bad options')
        const result = await action({ user: { create: async ({data}) => ({ id: 1, ...data }) } })
        fs.writeFileSync('records.json', JSON.stringify(result))
        return result
      },
      async $disconnect() { fs.writeFileSync('disconnected', '') }
    })
  `,
  )
  const result = run(
    [
      'users.yml',
      '--client',
      'client.mjs',
      '--require',
      './preload.cjs',
      '--databaseUrl',
      'test-only-url',
      '--timeout',
      '1234',
    ],
    dir,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Loaded 1 fixtures/)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'records.json'))).user1.name,
    'Example',
  )
  assert.ok(fs.existsSync(path.join(dir, 'disconnected')))
})

test('seed and reference date config are reproducible and CLI values override them', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    `entity: User
items:
  user1:
    name: '{{person.firstName}}'
    username: '{{internet.username}}'
    word: '{{word.sample}}'
    date: '{{date.past}}'
`,
  )
  fs.writeFileSync(
    path.join(dir, '.prisma-fixtures'),
    JSON.stringify({
      fixtures: ['users.yml'],
      client: 'client.cjs',
      seed: 123,
      refDate: '2026-01-01T00:00:00.000Z',
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    `
    const fs = require('node:fs')
    module.exports = {
      async $transaction(action) {
        const result = await action({ user: { create: async ({data}) => data } })
        fs.writeFileSync('seeded-records.json', JSON.stringify(result))
        return result
      },
      async $disconnect() {}
    }
  `,
  )

  assert.equal(run([], dir).status, 0)
  const configured = fs.readFileSync(
    path.join(dir, 'seeded-records.json'),
    'utf8',
  )
  assert.equal(run([], dir).status, 0)
  assert.equal(
    fs.readFileSync(path.join(dir, 'seeded-records.json'), 'utf8'),
    configured,
  )

  const overridden = run(
    ['--seed', '456', '--refDate', '2020-01-01T00:00:00.000Z'],
    dir,
  )
  assert.equal(overridden.status, 0, overridden.stderr)
  const overrideRecords = JSON.parse(
    fs.readFileSync(path.join(dir, 'seeded-records.json'), 'utf8'),
  )
  const configRecords = JSON.parse(configured)
  assert.notDeepEqual(
    [
      overrideRecords.user1.name,
      overrideRecords.user1.username,
      overrideRecords.user1.word,
    ],
    [
      configRecords.user1.name,
      configRecords.user1.username,
      configRecords.user1.word,
    ],
  )
  assert.ok(new Date(configRecords.user1.date) > new Date('2025-01-01'))
  assert.ok(new Date(overrideRecords.user1.date) < new Date('2020-01-01'))
  assert.equal(run(['--seed', '0'], dir).status, 0)
})

test('invalid generation flags fail before preloads and client imports', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'preload.cjs'),
    "require('node:fs').writeFileSync('preload-ran', '')",
  )
  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    "require('node:fs').writeFileSync('client-ran', '')",
  )
  for (const option of [
    ['--seed', '-1'],
    ['--seed', '1.5'],
    ['--seed', '4294967296'],
    ['--seed', 'not-a-number'],
    ['--refDate', '2026-01-01'],
    ['--refDate', '2026-02-30T00:00:00.000Z'],
  ]) {
    const result = run(
      [
        'users.yml',
        '--client',
        'client.cjs',
        '--require',
        './preload.cjs',
        ...option,
      ],
      dir,
    )
    assert.equal(result.status, 1, result.stderr)
    assert.ok(!fs.existsSync(path.join(dir, 'preload-ran')))
    assert.ok(!fs.existsSync(path.join(dir, 'client-ran')))
  }
})

test('failed writes disconnect and never print client error contents, even in debug mode', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    `
    const fs = require('node:fs')
    module.exports = {
      async $transaction(action) {
        return action({ user: { create: async () => { throw Object.assign(new Error('PRIVATE-RECORD-AND-URL'), { code: 'P2002' }) } } })
      },
      async $disconnect() { fs.writeFileSync('disconnected', '') }
    }
  `,
  )
  const result = run(['users.yml', '--client', 'client.cjs', '--debug'], dir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /FIXTURE_WRITE_FAILED.*users\.yml.*user1/)
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-RECORD-AND-URL/)
  assert.ok(fs.existsSync(path.join(dir, 'disconnected')))
})

test('operation diagnostics survive disconnect failures and stay bounded', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    `
    module.exports = {
      async $transaction(action) {
        return action({ user: { create: async () => { throw Object.assign(new Error('PRIVATE-PRIMARY'), { code: 'P2002' }) } } })
      },
      async $disconnect() { throw Object.assign(new Error('PRIVATE-DISCONNECT'), { code: 'EDISCONNECT' }) }
    }
  `,
  )
  const primary = run(['users.yml', '--client', 'client.cjs', '--debug'], dir)
  assert.equal(primary.status, 1)
  assert.match(primary.stderr, /FIXTURE_WRITE_FAILED/)
  assert.doesNotMatch(primary.stderr, /PRIVATE|P2002|EDISCONNECT/)

  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    `
      const { FixtureError } = require(${JSON.stringify(path.resolve(__dirname, '../dist/index.js'))})
      module.exports = {
        async $transaction(action) { return action({ user: { create: async ({data}) => data } }) },
        async $disconnect() {
          throw new FixtureError('FIXTURE_WRITE_FAILED', 'PRIVATE-FORGED-MESSAGE', {
            stage: 'PRIVATE-FORGED-STAGE', file: 'PRIVATE-FORGED-FILE'
          })
        }
      }
    `,
  )
  const forged = run(['users.yml', '--client', 'client.cjs', '--debug'], dir)
  assert.equal(forged.status, 1)
  assert.match(forged.stderr, /disconnecting the client.*FixtureError/)
  assert.doesNotMatch(forged.stderr, /PRIVATE|FIXTURE_WRITE_FAILED/)

  const longFields = Array.from(
    { length: 6 },
    (_, index) => `k${index}${'x'.repeat(898)}:`,
  )
  fs.writeFileSync(
    path.join(dir, 'long.yml'),
    [
      'entity: User',
      'items:',
      '  long:',
      ...longFields.map((field, index) => `${'  '.repeat(index + 2)}${field}`),
      `${'  '.repeat(longFields.length + 2)}value: "@missing"`,
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    `module.exports = {
      async $transaction(action) { return action({ user: { create: async ({data}) => data } }) },
      async $disconnect() {}
    }`,
  )
  const bounded = run(['long.yml', '--client', 'client.cjs', '--debug'], dir)
  assert.equal(bounded.status, 1)
  assert.match(bounded.stderr, /FIXTURE_REFERENCE_MISSING.*truncated/)
  assert.ok(bounded.stderr.length <= 4097, bounded.stderr.length)
  assert.doesNotMatch(bounded.stderr, /@missing/)
})

test('clean and reset use config and a single transaction, then disconnect', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, '.prisma-fixtures'),
    JSON.stringify({
      fixtures: ['users.yml'],
      client: 'client.cjs',
      timeout: 1234,
      preserveTables: ['tenant.audit_log'],
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    `
    const fs = require('node:fs')
    const events = []
    module.exports = {
      async $transaction(action, { timeout }) {
        events.push('begin:' + timeout)
        const result = await action({
          async $executeRawUnsafe(sql) {
            if (!sql.includes('TRUNCATE')) throw Error('expected cleanup')
            const preserved = Buffer.from(sql.split("decode('")[1].split("'")[0], 'hex').toString()
            events.push('preserve:' + preserved)
            events.push('clean')
            return 0
          },
          user: { async create({ data }) { events.push('create'); return { id: 1, ...data } } }
        })
        events.push('commit')
        return result
      },
      async $disconnect() {
        events.push('disconnect')
        fs.writeFileSync('events.json', JSON.stringify(events))
      }
    }
  `,
  )
  const cleaned = run(['--clean'], dir)
  assert.equal(cleaned.status, 0, cleaned.stderr)
  assert.match(cleaned.stdout, /Cleaned database data/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'events.json'))), [
    'begin:1234',
    'preserve:[{"schema":"tenant","table":"audit_log"}]',
    'clean',
    'commit',
    'disconnect',
  ])
  const reset = run(['--reset'], dir)
  assert.equal(reset.status, 0, reset.stderr)
  assert.match(reset.stdout, /Reset and loaded 1 fixtures/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'events.json'))), [
    'begin:1234',
    'preserve:[{"schema":"tenant","table":"audit_log"}]',
    'clean',
    'create',
    'commit',
    'disconnect',
  ])
})

test('clean/reset failures roll back and disconnect without exposing values', (t) => {
  const dir = workspace(t)
  for (const mode of ['clean', 'reset']) {
    fs.writeFileSync(
      path.join(dir, 'client.cjs'),
      `
      const fs = require('node:fs')
      let rows = ['original']
      module.exports = {
        async $transaction(action) {
          const before = [...rows]
          try {
            return await action({
              async $executeRawUnsafe() {
                rows = []
                if (${JSON.stringify(mode)} === 'clean') throw Error('PRIVATE-DELETE')
                return 0
              },
              user: { async create() { rows.push('partial'); throw Error('PRIVATE-CREATE') } }
            })
          } catch (error) { rows = before; throw error }
        },
        async $disconnect() { fs.writeFileSync('rows.json', JSON.stringify(rows)) }
      }
    `,
    )
    const result = run(
      ['users.yml', '--client', 'client.cjs', '--' + mode, '--debug'],
      dir,
    )
    assert.equal(result.status, 1)
    assert.match(
      result.stderr,
      new RegExp(
        mode === 'clean' ? 'cleaning fixtures' : 'FIXTURE_WRITE_FAILED',
      ),
    )
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE/)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'rows.json'))), [
      'original',
    ])
  }
})

test('clean needs only a client and skips even missing or invalid fixtures', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    `module.exports = {
      async $transaction(action) { return action({ async $executeRawUnsafe() { return 0 } }) },
      async $disconnect() {}
    }`,
  )
  for (const paths of [[], ['missing.yml'], ['users.yml']]) {
    fs.writeFileSync(path.join(dir, 'users.yml'), 'invalid: [')
    const result = run([...paths, '--client', 'client.cjs', '--clean'], dir)
    assert.equal(result.status, 0, result.stderr)
  }
})

test('clean/reset reject conflicting modes before importing the client', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    "require('node:fs').writeFileSync('client-ran', '')",
  )
  for (const flags of [
    ['--clean', '--reset'],
    ['--clean', '--list'],
    ['--clean', '--lint'],
    ['--reset', '--list'],
    ['--reset', '--lint'],
  ]) {
    const result = run(['users.yml', '--client', 'client.cjs', ...flags], dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage:/)
    assert.ok(!fs.existsSync(path.join(dir, 'client-ran')))
  }
  assert.equal(run(['users.yml', '--clean'], dir).status, 1)
  assert.equal(run(['users.yml', '--reset'], dir).status, 1)
})

test('invalid arguments do not execute the client', (t) => {
  const dir = workspace(t)
  for (const args of [
    [],
    ['users.yml'],
    ['users.yml', '--client', 'missing.mjs', '--timeout', '-1'],
    ['users.yml', '--unknown'],
  ]) {
    assert.equal(run(args, dir).status, 1)
  }
})

test('multiple paths are combined and duplicate names are rejected', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'posts.json'),
    JSON.stringify({ entity: 'Post', items: { post1: { title: 'Example' } } }),
  )
  const result = run(['users.yml', 'posts.json', '--list'], dir)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).length, 2)
  assert.equal(run(['users.yml', 'users.yml', '--list'], dir).status, 1)
})

test('loads cwd .prisma-fixtures without command-line paths or client', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, '.prisma-fixtures'),
    JSON.stringify({
      fixtures: ['users.yml'],
      client: 'client.cjs',
      preserveTables: ['missing.missing'],
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    `
    const fs = require('node:fs')
    module.exports = {
      async $transaction(action, options) {
        if (options.timeout !== 60000) throw Error('wrong default timeout')
        const result = await action({ user: { create: async ({data}) => ({ id: 1, ...data }) } })
        fs.writeFileSync('config-records.json', JSON.stringify(result))
        return result
      },
      async $disconnect() {}
    }
  `,
  )

  const result = run([], dir)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'config-records.json'))).user1
      .name,
    'Example',
  )
})

test('resolves explicit config values from its directory and CLI overrides from cwd', (t) => {
  const dir = workspace(t)
  const configDir = path.join(dir, 'config')
  fs.mkdirSync(configDir)
  fs.writeFileSync(
    path.join(configDir, 'users.yml'),
    'entity: User\nitems:\n  configured:\n    name: Configured\n',
  )
  fs.writeFileSync(
    path.join(configDir, 'client.cjs'),
    `
    const fs = require('node:fs')
    module.exports = {
      async $transaction(action, options) {
        if (options.timeout !== 111) throw Error('wrong config timeout')
        const result = await action({ user: { create: async ({data}) => data } })
        fs.writeFileSync('configured-records.json', JSON.stringify(result))
        return result
      },
      async $disconnect() {}
    }
  `,
  )
  fs.writeFileSync(
    path.join(configDir, 'fixtures.json'),
    JSON.stringify({
      fixtures: ['users.yml'],
      client: 'client.cjs',
      timeout: 111,
    }),
  )

  const configured = run(['--config', 'config/fixtures.json'], dir)
  assert.equal(configured.status, 0, configured.stderr)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'configured-records.json')))
      .configured.name,
    'Configured',
  )

  fs.rmSync(path.join(dir, 'configured-records.json'))
  fs.writeFileSync(
    path.join(dir, 'cwd-client.cjs'),
    `
    const fs = require('node:fs')
    module.exports = {
      async $transaction(action, options) {
        if (options.timeout !== 222) throw Error('wrong CLI timeout')
        const result = await action({ user: { create: async ({data}) => data } })
        fs.writeFileSync('cwd-records.json', JSON.stringify(result))
        return result
      },
      async $disconnect() {}
    }
  `,
  )
  const overridden = run(
    [
      'users.yml',
      '--config',
      'config/fixtures.json',
      '--client',
      'cwd-client.cjs',
      '--timeout',
      '222',
    ],
    dir,
  )
  assert.equal(overridden.status, 0, overridden.stderr)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, 'cwd-records.json'))).user1.name,
    'Example',
  )
  assert.ok(!fs.existsSync(path.join(dir, 'configured-records.json')))
})

test('config list stays inert and help/version bypass config reads', (t) => {
  const dir = workspace(t)
  fs.writeFileSync(
    path.join(dir, 'users.yml'),
    `entity: User
processor: ./missing.cjs
items:
  user{1..2}:
    name: "<%= (() => { throw new Error('must not run') })() %>"
`,
  )
  fs.writeFileSync(
    path.join(dir, 'client.cjs'),
    "require('node:fs').writeFileSync('client-ran', '')\nthrow Error('must not run')",
  )
  fs.writeFileSync(
    path.join(dir, '.prisma-fixtures'),
    JSON.stringify({ fixtures: ['users.yml'], client: 'client.cjs' }),
  )

  const listed = run(['--list', '--require', './missing.cjs'], dir)
  assert.equal(listed.status, 0, listed.stderr)
  assert.deepEqual(JSON.parse(listed.stdout), [
    { name: 'user1', entity: 'User' },
    { name: 'user2', entity: 'User' },
  ])
  assert.ok(!fs.existsSync(path.join(dir, 'client-ran')))

  fs.writeFileSync(path.join(dir, '.prisma-fixtures'), 'PRIVATE-CONFIG-DATA{')
  const help = run(['--config', 'missing.json', '--help'], dir)
  const version = run(['--version'], dir)
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--config/)
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout.trim(), '0.1.0')
  assert.doesNotMatch(
    help.stdout + help.stderr + version.stdout + version.stderr,
    /PRIVATE/,
  )
})

test('rejects missing or invalid explicit config before executing the client', (t) => {
  const dir = workspace(t)
  const marker = path.join(dir, 'client-ran')
  fs.writeFileSync(
    path.join(dir, 'must-not-run.cjs'),
    `
    const fs = require('node:fs')
    fs.writeFileSync('client-ran', '')
    module.exports = {
      async $transaction(action) {
        return action({ user: { create: async ({data}) => data } })
      },
      async $disconnect() {}
    }
  `,
  )
  const invalid = [
    ['missing.json'],
    ['malformed.json', '{"fixtures":["PRIVATE-CONFIG-DATA"'],
    ['null.json', 'null'],
    ['array.json', '[]'],
    ['unknown.json', JSON.stringify({ private: 'PRIVATE-CONFIG-DATA' })],
    ['fixtures-empty.json', JSON.stringify({ fixtures: [] })],
    ['fixtures-type.json', JSON.stringify({ fixtures: 'users.yml' })],
    ['fixtures-blank.json', JSON.stringify({ fixtures: [' '] })],
    ['client.json', JSON.stringify({ client: ' ' })],
    ['timeout-zero.json', JSON.stringify({ timeout: 0 })],
    ['timeout-fraction.json', JSON.stringify({ timeout: 1.5 })],
    ['seed-negative.json', JSON.stringify({ seed: -1 })],
    ['seed-string.json', JSON.stringify({ seed: '1' })],
    ['seed-fraction.json', JSON.stringify({ seed: 1.5 })],
    ['seed-overflow.json', JSON.stringify({ seed: 0x1_0000_0000 })],
    ['ref-date-null.json', JSON.stringify({ refDate: null })],
    ['ref-date-short.json', JSON.stringify({ refDate: '2026-01-01' })],
    [
      'ref-date-invalid.json',
      JSON.stringify({ refDate: '2026-02-30T00:00:00.000Z' }),
    ],
    ['preserve-type.json', JSON.stringify({ preserveTables: {} })],
    [
      'preserve-entry.json',
      JSON.stringify({ preserveTables: [{ schema: 'public', table: 'User' }] }),
    ],
    [
      'preserve-name.json',
      JSON.stringify({ preserveTables: ['public.User.extra'] }),
    ],
    [
      'timeout-unsafe.json',
      JSON.stringify({ timeout: Number.MAX_SAFE_INTEGER + 1 }),
    ],
  ]

  for (const [file, contents] of invalid) {
    if (contents !== undefined) fs.writeFileSync(path.join(dir, file), contents)
    fs.rmSync(marker, { force: true })
    const result = run(
      [
        'users.yml',
        '--client',
        'must-not-run.cjs',
        '--config',
        file,
        '--debug',
      ],
      dir,
    )
    assert.equal(result.status, 1, `${file}: ${result.stderr}`)
    assert.match(result.stderr, /failed during reading config/i, file)
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /PRIVATE-CONFIG-DATA/,
      file,
    )
    assert.ok(!fs.existsSync(marker), file)
  }
})
