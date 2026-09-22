const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const cli = path.resolve(__dirname, '../dist/cli.js')
function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
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
  assert.match(result.stderr, /loading fixtures.*P2002/)
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-RECORD-AND-URL/)
  assert.ok(fs.existsSync(path.join(dir, 'disconnected')))
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
