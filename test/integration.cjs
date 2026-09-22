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
function run(command, args, cwd = dir) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
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
      packed.files.every(({ path: file }) =>
        /^(dist\/|package.json$|README.md$|LICENSE$|NOTICE$)/.test(file),
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
      `import {readFixtureDefinitions,loadFixtures} from '@skmdev/prisma-fixtures'; import assert from 'node:assert/strict'; assert.equal(typeof loadFixtures,'function'); assert.equal(readFixtureDefinitions('./fixtures').length,7);`,
    )
    run(process.execPath, ['check.mjs'])
    write(
      'check.cts',
      `import {loadFixtures,readFixtureDefinitions,type FixtureProcessor} from '@skmdev/prisma-fixtures'; import {PrismaClient} from './generated/client'; declare const prisma: PrismaClient; void loadFixtures(prisma,readFixtureDefinitions('./fixtures')); void prisma.$transaction(tx => loadFixtures(tx, [])); const processor:FixtureProcessor={preProcess:async (_name,data)=>data}; void processor;`,
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
    console.log(
      run(path.join(dir, 'node_modules/.bin/prisma-fixtures'), [
        'cli.yml',
        '--client',
        './client.cjs',
      ]),
    )
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
        error.status === 1 && /loading fixtures/.test(error.stderr.toString()),
    )
    write(
      'count.cjs',
      `const assert=require('node:assert/strict');const prisma=require('./client.cjs')();Promise.all([prisma.user.count({where:{email:'cli@example.test'}}),prisma.user.count({where:{email:'cli-rollback@example.test'}})]).then(counts=>assert.deepEqual(counts,[1,0])).finally(()=>prisma.$disconnect()).catch(()=>{process.exitCode=1});`,
    )
    run(process.execPath, ['count.cjs'])
    console.log(
      'PASS packed CJS, ESM, TypeScript generated-client consumer and CLI commit/rollback',
    )
  } finally {
    if (started) run('docker', ['stop', container])
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error.stderr?.toString() || error.message)
  process.exitCode = 1
})
