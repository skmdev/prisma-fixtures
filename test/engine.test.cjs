const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  cleanFixtures,
  FixtureError,
  loadFixtures,
  readFixtureDefinitions,
  resetFixtures,
} = require('../dist/index.js')

async function rejected(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('Expected operation to reject')
}

test('reads flat YAML and creates fixtures after resolving a scalar reference', async (t) => {
  const directory = fixtureDirectory(t)
  write(
    directory,
    'accounts.yml',
    [
      'entity: Account',
      'items:',
      '  account1:',
      '    email: one@example.test',
      '  account2:',
      '    email: two@example.test',
      '    ownerId: "@account1.id"',
    ].join('\n'),
  )
  const account = createDelegate([], 'account', (data, index) => ({
    id: `id-${index}`,
    ...data,
  }))

  const records = await loadFixtures(
    { account },
    readFixtureDefinitions(directory),
  )

  assert.deepEqual(
    account.calls.map(({ data }) => data),
    [
      { email: 'one@example.test' },
      { email: 'two@example.test', ownerId: 'id-1' },
    ],
  )
  assert.equal(records.account2.id, 'id-2')
})

test('defers cyclic scalar links until after all fixture creates', async (t) => {
  const directory = fixtureDirectory(t)
  write(
    directory,
    'accounts.yml',
    'entity: account\ndeferredFields: [parentId]\nitems:\n  first: { id: first, parentId: second }\n  second: { id: second, parentId: first }',
  )
  const calls = []
  const rows = new Map()
  const account = {
    async create({ data }) {
      calls.push(['create', data.id])
      const row = { ...data }
      rows.set(row.id, row)
      return row
    },
    async update({ where, data }) {
      calls.push(['update', where.id])
      const row = { ...rows.get(where.id), ...data }
      rows.set(where.id, row)
      return row
    },
  }

  const records = await loadFixtures(
    { account },
    readFixtureDefinitions(directory),
  )

  assert.deepEqual(calls, [
    ['create', 'first'],
    ['create', 'second'],
    ['update', 'first'],
    ['update', 'second'],
  ])
  assert.equal(records.first.parentId, 'second')
  assert.equal(records.second.parentId, 'first')
})

test('validates field metadata consistently for documents and direct definitions', async (t) => {
  const directory = fixtureDirectory(t)
  const account = createDelegate([], 'account', (data) => data)
  const definition = {
    name: 'account1',
    entity: 'account',
    parameters: {},
    data: { parentId: 1 },
  }
  for (const metadata of [
    { parameters: null },
    { connectedFields: null },
    { connectedFields: ['parentId', 'parentId'] },
    { connectedFields: ['constructor'] },
    { connectedFields: ['invalid-field'] },
    { deferredFields: null },
    { deferredFields: [] },
    { deferredFields: ['parentId', 'parentId'] },
    { deferredFields: ['constructor'] },
    { deferredFields: ['missing'] },
    { deferredFields: ['id'] },
    { connectedFields: ['parentId'], deferredFields: ['parentId'] },
  ]) {
    write(
      directory,
      'metadata.json',
      JSON.stringify({
        entity: 'account',
        items: { account1: definition.data },
        ...metadata,
      }),
    )
    assert.throws(() => readFixtureDefinitions(directory), /fixture/i)
    await assert.rejects(
      loadFixtures({ account }, [{ ...definition, ...metadata }]),
      /fixture/i,
    )
  }
  assert.equal(account.calls.length, 0)
  const records = await loadFixtures({ account }, [
    { ...definition, connectedFields: [] },
  ])
  assert.deepEqual(records.account1, { parentId: 1 })
})

test('reads sorted YAML and JSON, expands ranges independently and stays inert', (t) => {
  const directory = fixtureDirectory(t)
  write(
    directory,
    'b.json',
    JSON.stringify({
      entity: 'account',
      items: { finalAccount: { email: 'final@example.test' } },
    }),
  )
  write(
    directory,
    'a.yml',
    [
      'entity: Account',
      'locale: fr',
      'processor: ./NeverImported.mjs',
      'items:',
      '  account{1..2}:',
      '    email: account($current)@example.test',
      '    nested:',
      '      multiplied: ($current*10)',
      '      previous: ($current-1)',
      '      divided: ($current/2)',
      '      next: "@account($current+1)"',
      '    template: "{{name.firstName}}"',
    ].join('\n'),
  )

  const definitions = readFixtureDefinitions(directory)

  assert.deepEqual(
    definitions.map(({ name }) => name),
    ['account1', 'account2', 'finalAccount'],
  )
  assert.deepEqual(definitions[0].data, {
    email: 'account1@example.test',
    nested: {
      multiplied: '10',
      previous: '0',
      divided: '0.5',
      next: '@account2',
    },
    template: '{{name.firstName}}',
  })
  assert.notEqual(definitions[0].data, definitions[1].data)
  assert.notEqual(definitions[0].data.nested, definitions[1].data.nested)
  assert.equal(
    definitions[0].processor,
    path.join(directory, 'NeverImported.mjs'),
  )
})

test('orders dependencies and resolves records, escaped values and connections', async (t) => {
  const directory = fixtureDirectory(t)
  write(
    directory,
    '01-company.yml',
    [
      'entity: company',
      'connectedFields: [owner, members, nullableOwner]',
      'parameters:',
      '  refs: { owner: "@account1" }',
      'items:',
      '  company:',
      '    owner: "<{refs.owner}>"',
      '    members: ["@account1", "@account2"]',
      '    nullableOwner: null',
      '    snapshot: "@account1"',
      '    ownerId: "@account1.id"',
      '    escaped: "@@literal"',
    ].join('\n'),
  )
  write(
    directory,
    '02-accounts.yml',
    [
      'entity: Account',
      'items:',
      '  account{1..2}:',
      '    email: account($current)@example.test',
      '    values: [null, true, 42]',
    ].join('\n'),
  )
  const writes = []
  const account = createDelegate(writes, 'account', (data, index) => ({
    id: `user-${index}`,
    ...data,
  }))
  const company = createDelegate(writes, 'company', (data) => ({
    id: 'company-1',
    ...data,
  }))

  const records = await loadFixtures(
    { account, company },
    readFixtureDefinitions(directory),
  )

  assert.deepEqual(writes, ['account', 'account', 'company'])
  assert.deepEqual(company.calls[0].data, {
    owner: { connect: { id: 'user-1' } },
    members: { connect: [{ id: 'user-1' }, { id: 'user-2' }] },
    nullableOwner: null,
    snapshot: {
      id: 'user-1',
      email: 'account1@example.test',
      values: [null, true, 42],
    },
    ownerId: 'user-1',
    escaped: '@literal',
  })
  assert.equal(records.company.id, 'company-1')
})

test('selects wildcard and bounded references only where requested', async (t) => {
  const directory = fixtureDirectory(t)
  write(
    directory,
    'fixtures.yml',
    [
      'entity: account',
      'items:',
      '  account{1..2}: { email: account($current)@example.test }',
      '  selected:',
      '    wildcard: "@account*"',
      '    bounded: "@account{1..2}"',
    ].join('\n'),
  )
  const account = createDelegate([], 'account', (data, index) => ({
    id: `user-${index}`,
    ...data,
  }))

  const records = await loadFixtures(
    { account },
    readFixtureDefinitions(directory),
  )

  assert.ok(
    [records.account1, records.account2].includes(records.selected.wildcard),
  )
  assert.ok(
    [records.account1, records.account2].includes(records.selected.bounded),
  )
  assert.equal(account.calls.length, 3)
})

test('reproduces Faker values, relative dates and random references per operation', async (t) => {
  const definitions = [
    {
      name: 'account1',
      entity: 'AnyEntity',
      locale: 'en',
      parameters: {},
      data: {
        name: '{{person.firstName}}',
        date: '{{date.past}}',
        explicitDate: '{{date.past({"refDate":"2020-01-01T00:00:00.000Z"})}}',
      },
    },
    {
      name: 'account2',
      entity: 'AnyEntity',
      locale: 'fr',
      parameters: {},
      data: { name: '{{person.firstName}}', word: '{{word.sample}}' },
    },
    {
      name: 'selected',
      entity: 'AnyEntity',
      parameters: {},
      data: { account: '@account*' },
    },
  ]
  const writeFixture = async (fixture, data) => ({
    id: fixture.name,
    ...data,
  })
  const run = (seed) =>
    loadFixtures(
      {},
      structuredClone(definitions),
      { seed, refDate: '2026-01-01T00:00:00.000Z' },
      writeFixture,
    )

  await import('@faker-js/faker')
  const originalRandom = Math.random
  Math.random = () => {
    throw new Error('seeded loads must not use global Math.random')
  }
  t.after(() => {
    Math.random = originalRandom
  })

  const [first, concurrent] = await Promise.all([run(123), run(123)])
  const repeated = await run(123)
  const different = await run(456)
  const zero = await run(0)

  assert.deepEqual(first, concurrent)
  assert.deepEqual(first, repeated)
  assert.notDeepEqual(
    [first.account1.name, first.account1.date, first.account2.name],
    [different.account1.name, different.account1.date, different.account2.name],
  )
  assert.ok(first.account1.date instanceof Date)
  assert.ok(first.account1.explicitDate instanceof Date)
  assert.ok(first.account1.date > new Date('2025-01-01T00:00:00.000Z'))
  assert.ok(first.account1.date < new Date('2026-01-01T00:00:00.000Z'))
  assert.ok(first.account1.explicitDate < new Date('2020-01-01T00:00:00.000Z'))
  assert.equal(typeof zero.account1.name, 'string')
  assert.ok(['account1', 'account2'].includes(first.selected.account.id))
})

test('rejects invalid generation options before hooks, cleanup or writes', async () => {
  let cleans = 0
  let writes = 0
  const client = {
    async $executeRawUnsafe() {
      cleans += 1
    },
  }
  const writeFixture = async () => {
    writes += 1
    return {}
  }
  const invalid = [
    null,
    [],
    { extra: true },
    { seed: null },
    { seed: '1' },
    { seed: -1 },
    { seed: 1.5 },
    { seed: 0x1_0000_0000 },
    { refDate: null },
    { refDate: '2026-01-01' },
    { refDate: '2026-02-30T00:00:00.000Z' },
  ]

  for (const options of invalid) {
    await assert.rejects(
      loadFixtures({}, [], options, writeFixture),
      /load options/i,
    )
    await assert.rejects(
      resetFixtures(client, [], options, writeFixture),
      /load options/i,
    )
  }
  assert.equal(cleans, 0)
  assert.equal(writes, 0)
})

test('supports generic entities through the optional writer', async (t) => {
  const directory = fixtureDirectory(t)
  write(
    directory,
    'widget.yml',
    'entity: AnyEntity\nitems:\n  widget: { label: fixture }',
  )
  const calls = []

  const records = await loadFixtures(
    {},
    readFixtureDefinitions(directory),
    async (fixture, data) => {
      calls.push({ fixture, data })
      return { id: `saved-${fixture.name}`, ...data }
    },
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].fixture.entity, 'AnyEntity')
  assert.deepEqual(calls[0].data, { label: 'fixture' })
  assert.deepEqual(records.widget, { id: 'saved-widget', label: 'fixture' })
})

test('cleans PostgreSQL data with one fixed query, preserved tables and the client receiver', async () => {
  const calls = []
  const client = {
    async $executeRawUnsafe(...args) {
      assert.equal(this, client)
      calls.push(args)
    },
  }

  await cleanFixtures(client, {
    preserveTables: ['tenant.audit_log'],
  })

  assert.equal(calls.length, 1)
  const preserved = JSON.parse(
    Buffer.from(
      calls[0][0].split("decode('")[1].split("'")[0],
      'hex',
    ).toString(),
  )
  assert.deepEqual(preserved, [{ schema: 'tenant', table: 'audit_log' }])
  assert.match(calls[0][0], /^DO \$\$/)
  assert.match(
    calls[0][0],
    /format\('%I\.%I', schemaname, tablename\).*ORDER BY schemaname, tablename/s,
  )
  assert.match(calls[0][0], /FROM pg_catalog\.pg_tables/)
  assert.match(calls[0][0], /tablename <> '_prisma_migrations'/)
  assert.match(calls[0][0], /jsonb_to_recordset\(preserved\)/)
  assert.match(calls[0][0], /AS requested\("schema" text, "table" text\)/)
  assert.match(calls[0][0], /CONTINUE IDENTITY RESTRICT/)
  assert.doesNotMatch(calls[0][0], /tenant|audit_log|CASCADE|DROP/)
  await assert.rejects(cleanFixtures({}), /\$executeRawUnsafe/)
})

test('rejects invalid cleanup options before querying the database', async () => {
  let calls = 0
  const client = {
    async $executeRawUnsafe() {
      calls += 1
    },
  }
  const invalid = [
    null,
    [],
    { extra: true },
    { preserveTables: {} },
    { preserveTables: [null] },
    { preserveTables: ['audit_log'] },
    { preserveTables: ['public.'] },
    { preserveTables: ['public.audit.log'] },
    { preserveTables: [{ schema: 'public', table: 'users' }] },
    { preserveTables: [{ schema: 'public' }] },
    { preserveTables: [{ schema: '', table: 'users' }] },
    { preserveTables: [{ schema: 'public', table: 'users', extra: true }] },
    { preserveTables: ['public.users', 'public.users'] },
    { preserveTables: ['public.users', { schema: 'public', table: 'users' }] },
  ]

  for (const options of invalid) {
    await assert.rejects(cleanFixtures(client, options), /cleanup options/i)
  }
  assert.equal(calls, 0)
})

test('resets once-prepared fixtures after cleaning and supports a writer', async () => {
  const events = []
  const client = {
    async $executeRawUnsafe() {
      events.push('clean')
    },
  }
  const definitions = [
    {
      name: 'parent',
      entity: 'AnyEntity',
      parameters: { counter: { value: 1 } },
      data: { label: '<%= parameters.counter.value++ %>' },
    },
    {
      name: 'child',
      entity: 'AnyEntity',
      parameters: {},
      data: { parentId: '@parent.id' },
    },
  ]

  const records = await resetFixtures(
    client,
    definitions,
    async (fixture, data) => {
      events.push(`write:${fixture.name}`)
      return { id: `${fixture.name}-id`, ...data }
    },
  )

  assert.deepEqual(events, ['clean', 'write:parent', 'write:child'])
  assert.equal(definitions[0].parameters.counter.value, 2)
  assert.equal(records.parent.label, '1')
  assert.equal(records.child.parentId, 'parent-id')
})

test('accepts cleanup options before the reset writer', async () => {
  const events = []
  const client = {
    async $executeRawUnsafe(sql) {
      const preserved = Buffer.from(
        sql.split("decode('")[1].split("'")[0],
        'hex',
      ).toString()
      events.push(`clean:${preserved}`)
    },
  }
  const definitions = [
    {
      name: 'record',
      entity: 'AnyEntity',
      parameters: {},
      data: { label: 'fixture' },
    },
  ]

  const records = await resetFixtures(
    client,
    definitions,
    { preserveTables: ['tenant.audit_log'] },
    async (fixture, data) => {
      events.push(`write:${fixture.name}`)
      return { id: 1, ...data }
    },
  )

  assert.deepEqual(events, [
    'clean:[{"schema":"tenant","table":"audit_log"}]',
    'write:record',
  ])
  assert.deepEqual(records.record, { id: 1, label: 'fixture' })
})

test('rejects reset preflight failures before cleaning', async () => {
  let cleans = 0
  const client = {
    async $executeRawUnsafe() {
      cleans += 1
    },
  }
  const writeFixture = async () => ({})

  await assert.rejects(
    resetFixtures(
      client,
      [
        {
          name: 'broken',
          entity: 'AnyEntity',
          parameters: {},
          data: { missing: '@unknown' },
        },
      ],
      writeFixture,
    ),
    /reference/i,
  )
  await assert.rejects(
    resetFixtures(
      client,
      [
        {
          name: 'broken',
          entity: 'AnyEntity',
          parameters: {},
          processor: '/definitely-missing-prisma-fixture-processor.mjs',
          data: {},
        },
      ],
      writeFixture,
    ),
  )
  assert.equal(cleans, 0)
})

test('does not create fixtures when reset cleanup fails', async () => {
  const account = createDelegate([], 'account', (data) => data)
  const client = {
    account,
    async $executeRawUnsafe() {
      throw new Error('cleanup failed')
    },
  }

  await assert.rejects(
    resetFixtures(client, [
      {
        name: 'account',
        entity: 'account',
        parameters: {},
        data: {},
      },
    ]),
    /cleanup failed/,
  )
  assert.equal(account.calls.length, 0)
})

test('renders parameters, environment fallback, Faker legacy names and EJS', async (t) => {
  const directory = fixtureDirectory(t)
  const fallbackName = 'PRISMA_FIXTURES_ENGINE_FALLBACK'
  const overrideName = 'PRISMA_FIXTURES_ENGINE_OVERRIDE'
  process.env[fallbackName] = 'from-environment'
  process.env[overrideName] = 'ignored-environment'
  t.after(() => {
    delete process.env[fallbackName]
    delete process.env[overrideName]
  })
  write(
    directory,
    'templates.yml',
    [
      'entity: account',
      'locale: fr',
      'parameters:',
      '  names: { admin: Admin }',
      '  process:',
      '    env:',
      `      ${overrideName}: explicit`,
      'items:',
      '  templated:',
      '    parameter: "<{names.admin}>"',
      `    environment: "<{process.env.${fallbackName}}>"`,
      `    explicit: "<{process.env.${overrideName}}>"`,
      `    number: '{{random.number({"min": 7, "max": 7})}}'`,
      '    boolean: "{{datatype.boolean}}"',
      '    date: "{{date.past}}"',
      '    title: "{{name.title}}"',
      '    username: "{{internet.userName}}"',
      '    word: "{{random.word}}"',
      '    composed: "Hello {{name.firstName}} {{name.lastName}}"',
      '    rendered: "<%= name.toUpperCase() %>"',
      '    nullable: null',
    ].join('\n'),
  )
  const account = createDelegate([], 'account', (data) => ({
    id: 'user-1',
    ...data,
  }))

  await loadFixtures({ account }, readFixtureDefinitions(directory))

  const data = account.calls[0].data
  assert.equal(data.parameter, 'Admin')
  assert.equal(data.environment, 'from-environment')
  assert.equal(data.explicit, 'explicit')
  assert.equal(data.number, 7)
  assert.equal(typeof data.boolean, 'boolean')
  assert.ok(data.date instanceof Date)
  assert.match(data.title, /\S/)
  assert.match(data.username, /\S/)
  assert.match(data.word, /\S/)
  assert.match(data.composed, /^Hello \S+ \S+/)
  assert.equal(data.rendered, 'TEMPLATED')
  assert.equal(data.nullable, null)
})

test('loads explicit and extensionless ESM, CommonJS and typed processors', async (t) => {
  const directory = fixtureDirectory(t)
  write(
    directory,
    'direct.js',
    'module.exports = class { async preProcess(name, data) { return { ...data, processor: `direct:${name}` } } }',
  )
  write(
    directory,
    'exports.cjs',
    'exports.default = class { preProcess(name, data) { return { ...data, processor: `exports:${name}` } } }',
  )
  write(
    directory,
    'module.mjs',
    'await Promise.resolve(); export default class { async preProcess(name, data) { return { ...data, processor: `esm:${name}` } } }',
  )
  write(
    directory,
    'typed.mts',
    'export default class { preProcess(name: string, data: Record<string, unknown>) { return { ...data, processor: `typed:${name}` } } }',
  )
  for (const [index, processor] of [
    'direct',
    'exports.cjs',
    'module',
    'typed',
  ].entries()) {
    write(
      directory,
      `${index}.yml`,
      `entity: account\nprocessor: ./${processor}\nitems:\n  fixture${index}: { value: ${index} }`,
    )
  }
  const account = createDelegate([], 'account', (data, index) => ({
    id: `user-${index}`,
    ...data,
  }))

  await loadFixtures({ account }, readFixtureDefinitions(directory))

  assert.deepEqual(
    account.calls.map(({ data }) => data.processor),
    ['direct:fixture0', 'exports:fixture1', 'esm:fixture2', 'typed:fixture3'],
  )
})

test('honors a registered CommonJS require hook for TypeScript processors', async (t) => {
  const directory = fixtureDirectory(t)
  const previousHook = require.extensions['.ts']
  require.extensions['.ts'] = (module, filename) => {
    assert.equal(fs.readFileSync(filename, 'utf8'), 'compile-through-hook')
    module._compile(
      'module.exports = class { preProcess(name, data) { return { ...data, processor: `hooked:${name}` } } }',
      filename,
    )
  }
  t.after(() => {
    if (previousHook) require.extensions['.ts'] = previousHook
    else delete require.extensions['.ts']
  })
  write(directory, 'hooked.ts', 'compile-through-hook')
  write(
    directory,
    'fixture.yml',
    'entity: account\nprocessor: ./hooked\nitems:\n  fixture: { value: 1 }',
  )
  const account = createDelegate([], 'account', (data) => ({
    id: 'one',
    ...data,
  }))

  await loadFixtures({ account }, readFixtureDefinitions(directory))

  assert.equal(account.calls[0].data.processor, 'hooked:fixture')
})

test('rejects duplicate JSON keys and malformed JSON', (t) => {
  const directory = fixtureDirectory(t)
  const invalidDocuments = [
    '{"entity":"account","items":{"same":{},"same":{}}}',
    '{"entity":"account","items":{"one":{"value":1,"value":2}}}',
    '{"entity":"account","items":{"one":{},}}',
  ]

  for (const [index, contents] of invalidDocuments.entries()) {
    const file = path.join(directory, `${index}.json`)
    fs.writeFileSync(file, contents)
    assert.throws(() => readFixtureDefinitions(file), /fixture/i)
  }
})

test('validates delegates, templates, processors, references and cycles before writes', async (t) => {
  const directory = fixtureDirectory(t)
  const account = createDelegate([], 'account', (data) => data)

  write(
    directory,
    'missing.yml',
    'entity: account\nitems:\n  first: { ref: "@none" }',
  )
  await assert.rejects(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
    /reference/i,
  )
  assert.equal(account.calls.length, 0)
  fs.rmSync(path.join(directory, 'missing.yml'))

  write(
    directory,
    'cycle.yml',
    'entity: account\nitems:\n  first: { ref: "@second" }\n  second: { ref: "@first" }',
  )
  await assert.rejects(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
    /cycle/i,
  )
  assert.equal(account.calls.length, 0)
  fs.rmSync(path.join(directory, 'cycle.yml'))

  write(
    directory,
    'template.yml',
    'entity: account\nitems:\n  valid: {}\n  invalid: { value: "<{missing}>" }',
  )
  await assert.rejects(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
    /parameter/i,
  )
  assert.equal(account.calls.length, 0)
  fs.rmSync(path.join(directory, 'template.yml'))

  write(
    directory,
    'processor.yml',
    'entity: account\nprocessor: ./missing.mjs\nitems:\n  invalid: {}',
  )
  await assert.rejects(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
  )
  assert.equal(account.calls.length, 0)
  await assert.rejects(
    loadFixtures({}, readFixtureDefinitions(directory)),
    /delegate/i,
  )
})

test('reports safe source, fixture and nested paths for references and cycles', async (t) => {
  const directory = fixtureDirectory(t)
  const account = createDelegate([], 'account', (data) => data)
  write(
    directory,
    'references.yml',
    'entity: account\nitems:\n  broken:\n    nested:\n      owner: "@missing"',
  )

  const missing = await rejected(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
  )
  assert.ok(missing instanceof FixtureError)
  assert.equal(missing.code, 'FIXTURE_REFERENCE_MISSING')
  assert.equal(missing.stage, 'preparing references')
  assert.equal(missing.file, 'references.yml')
  assert.equal(missing.fixtureName, 'broken')
  assert.equal(missing.path, '/nested/owner')
  assert.equal(Object.keys(missing).includes('cause'), false)

  fs.rmSync(path.join(directory, 'references.yml'))
  write(
    directory,
    'cycle.yml',
    'entity: account\nitems:\n  first: { value: "@second" }\n  second: { value: "@first" }',
  )
  const cycle = await rejected(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
  )
  assert.ok(cycle instanceof FixtureError)
  assert.equal(cycle.code, 'FIXTURE_DEPENDENCY_CYCLE')
  assert.equal(cycle.file, 'cycle.yml')
  assert.equal(cycle.path, '/value')
  assert.match(cycle.message, /first.*second.*first/)
})

test('wraps template, processor, connection and writer failures with private causes', async (t) => {
  const directory = fixtureDirectory(t)
  const account = createDelegate([], 'account', (data) => data)
  write(
    directory,
    'template.yml',
    'entity: account\nitems:\n  broken:\n    nested: { value: "{{missing.provider}}" }',
  )
  const template = await rejected(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
  )
  assert.ok(template instanceof FixtureError)
  assert.equal(template.code, 'FIXTURE_TEMPLATE_FAILED')
  assert.equal(template.file, 'template.yml')
  assert.equal(template.fixtureName, 'broken')
  assert.equal(template.path, '/nested/value')
  assert.match(template.cause.message, /provider/i)
  assert.equal(Object.keys(template).includes('cause'), false)

  write(
    directory,
    'template.yml',
    `entity: account
items:
  broken:
    nested:
      value: '{{helpers.arrayElement([{"constructor":"PRIVATE-UNSAFE"}])}}'
`,
  )
  const unsafeTemplate = await rejected(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
  )
  assert.ok(unsafeTemplate instanceof FixtureError)
  assert.equal(unsafeTemplate.code, 'FIXTURE_TEMPLATE_FAILED')
  assert.equal(unsafeTemplate.fixtureName, 'broken')
  assert.equal(unsafeTemplate.path, '/nested/value')
  assert.match(unsafeTemplate.cause.message, /unsafe/i)

  fs.rmSync(path.join(directory, 'template.yml'))
  write(
    directory,
    'processor.cjs',
    "module.exports = class { preProcess() { throw new Error('PRIVATE-PROCESSOR') } }",
  )
  write(
    directory,
    'processor.yml',
    'entity: account\nprocessor: ./processor.cjs\nitems:\n  processed: {}',
  )
  const processor = await rejected(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
  )
  assert.equal(processor.code, 'FIXTURE_PROCESSOR_FAILED')
  assert.equal(processor.fixtureName, 'processed')
  assert.equal(processor.cause.message, 'PRIVATE-PROCESSOR')

  fs.writeFileSync(
    path.join(directory, 'unsafe-processor.cjs'),
    "module.exports = class { preProcess() { return { constructor: 'PRIVATE-UNSAFE' } } }",
  )
  write(
    directory,
    'processor.yml',
    'entity: account\nprocessor: ./unsafe-processor.cjs\nitems:\n  processed: {}',
  )
  const unsafeProcessor = await rejected(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
  )
  assert.ok(unsafeProcessor instanceof FixtureError)
  assert.equal(unsafeProcessor.code, 'FIXTURE_PROCESSOR_FAILED')
  assert.equal(unsafeProcessor.fixtureName, 'processed')
  assert.match(unsafeProcessor.cause.message, /unsafe/i)

  fs.rmSync(path.join(directory, 'processor.yml'))
  write(
    directory,
    'connections.yml',
    'entity: account\nconnectedFields: [owner]\nitems:\n  source: {}\n  target: { owner: "@source" }',
  )
  const connection = await rejected(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
  )
  assert.equal(connection.code, 'FIXTURE_CONNECTION_FAILED')
  assert.equal(connection.fixtureName, 'target')
  assert.equal(connection.path, '/owner')

  const indexedConnection = await rejected(
    loadFixtures(
      {},
      [
        {
          name: 'indexed',
          entity: 'AnyEntity',
          parameters: {},
          connectedFields: ['members'],
          data: { members: [{ id: 1 }, {}] },
        },
      ],
      async () => ({}),
    ),
  )
  assert.equal(indexedConnection.code, 'FIXTURE_CONNECTION_FAILED')
  assert.equal(indexedConnection.path, '/members/1')

  const writeFailure = await rejected(
    loadFixtures(
      {},
      [
        {
          name: 'written',
          entity: 'AnyEntity',
          parameters: {},
          data: {},
        },
      ],
      async () => {
        throw new Error('PRIVATE-WRITER')
      },
    ),
  )
  assert.equal(writeFailure.code, 'FIXTURE_WRITE_FAILED')
  assert.equal(writeFailure.fixtureName, 'written')
  assert.equal(writeFailure.cause.message, 'PRIVATE-WRITER')

  const forged = await rejected(
    loadFixtures(
      {},
      [
        {
          name: 'written',
          entity: 'AnyEntity',
          parameters: {},
          data: {},
        },
      ],
      async () => {
        throw new FixtureError(
          'FIXTURE_WRITE_FAILED',
          'PRIVATE-FORGED-MESSAGE',
          { stage: 'PRIVATE-FORGED-STAGE', fixtureName: 'PRIVATE-FORGED-NAME' },
        )
      },
    ),
  )
  assert.equal(forged.code, 'FIXTURE_WRITE_FAILED')
  assert.equal(forged.message, 'Fixture persistence failed')
  assert.equal(forged.fixtureName, 'written')
  assert.equal(forged.cause.message, 'PRIVATE-FORGED-MESSAGE')
})

test('reference and connection errors retain locations without fixture metadata', () => {
  const {
    resolveFixtureReferences,
    applyFixtureConnections,
  } = require('../dist/fixture-reference.js')

  for (const [reference, code] of [
    ['@invalid.field.extra', 'FIXTURE_REFERENCE_INVALID'],
    ['@missing', 'FIXTURE_REFERENCE_MISSING'],
    ['@source.constructor', 'FIXTURE_REFERENCE_INVALID'],
    ['@source.missing', 'FIXTURE_REFERENCE_FIELD_MISSING'],
  ]) {
    assert.throws(
      () =>
        resolveFixtureReferences(
          { 'owner/name': [reference] },
          { source: { id: 1 } },
        ),
      {
        name: 'FixtureError',
        code,
        stage: 'resolving references',
        path: '/owner~1name/0',
        file: undefined,
        fixtureName: undefined,
        entity: undefined,
      },
    )
  }
  assert.throws(() => applyFixtureConnections({ owners: [{}] }, ['owners']), {
    name: 'FixtureError',
    code: 'FIXTURE_CONNECTION_FAILED',
    stage: 'connecting fixture',
    path: '/owners/0',
    file: undefined,
    fixtureName: undefined,
    entity: undefined,
  })
})

test('checks scalar references against saved own properties and blocks unsafe fields', async (t) => {
  const directory = fixtureDirectory(t)
  const account = createDelegate([], 'account', (data, index) => ({
    ...(index === 1 ? { id: 'user-1' } : {}),
    ...data,
  }))
  write(
    directory,
    'missing-field.yml',
    'entity: account\nitems:\n  source: {}\n  target: { value: "@source.missing" }',
  )
  await assert.rejects(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
    /field.*missing/i,
  )
  assert.equal(account.calls.length, 1)
  fs.rmSync(path.join(directory, 'missing-field.yml'))
  account.calls.length = 0

  write(
    directory,
    'unsafe-field.yml',
    'entity: account\nitems:\n  source: {}\n  target: { value: "@source.constructor" }',
  )
  await assert.rejects(
    loadFixtures({ account }, readFixtureDefinitions(directory)),
    /unsafe/i,
  )
  assert.equal(account.calls.length, 0)
})

for (const [label, contents] of [
  [
    'aliases',
    'entity: account\nitems:\n  first: &item { email: first@example.test }\n  second: *item',
  ],
  [
    'prototype keys',
    'entity: account\nitems:\n  hostile:\n    "__proto__": poisoned',
  ],
  [
    'unknown metadata',
    'entity: account\nprocessorFactory: ./unsafe.js\nitems: {}',
  ],
  [
    'expanded duplicate names',
    'entity: account\nitems:\n  account1: {}\n  account{1..1}: {}',
  ],
]) {
  test(`rejects hostile fixture ${label} without exposing record data`, (t) => {
    const directory = fixtureDirectory(t)
    write(directory, 'hostile.yml', contents)
    assert.throws(() => readFixtureDefinitions(directory), /fixture/i)
    try {
      readFixtureDefinitions(directory)
    } catch (error) {
      assert.doesNotMatch(String(error), /poisoned|unsafe\.js/)
    }
  })
}

function fixtureDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-fixtures-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function write(directory, name, contents) {
  fs.writeFileSync(path.join(directory, name), contents)
}

function createDelegate(writes, label, save) {
  const calls = []
  return {
    calls,
    async create(args) {
      calls.push(args)
      writes.push(label)
      return save(args.data, calls.length)
    },
  }
}
