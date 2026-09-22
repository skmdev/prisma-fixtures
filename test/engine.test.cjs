const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { loadFixtures, readFixtureDefinitions } = require('../dist/index.js')

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
    'export default class { async preProcess(name, data) { await Promise.resolve(); return { ...data, processor: `esm:${name}` } } }',
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
