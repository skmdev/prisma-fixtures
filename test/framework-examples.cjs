const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

async function checkEndpoint(cwd, environment, command) {
  const socket = net.createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const server = spawn('npm', ['run', command], {
    cwd,
    detached: true,
    env: {
      ...process.env,
      ...environment,
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-16000)
    })
  }
  const stopped = once(server, 'close')
  try {
    const deadline = Date.now() + 90000
    let response
    while (Date.now() < deadline && server.exitCode === null) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/users`, {
          signal: AbortSignal.timeout(10000),
        })
        if (response.ok) break
        await response.text()
      } catch {}
      await delay(250)
    }
    assert.ok(response?.ok, `example endpoint did not start:\n${output}`)
    const users = await response.json()
    assert.equal(users.length, 3)
    for (const [index, user] of users.entries()) {
      assert.equal(user.email, `user${index + 1}@example.test`)
      assert.deepEqual(Object.keys(user).sort(), [
        'email',
        'id',
        'name',
        'posts',
      ])
      assert.equal(user.posts.length, 1)
      assert.equal(user.posts[0].authorId, user.id)
      assert.equal(user.posts[0].title, `Post ${index + 1}`)
    }
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    await Promise.race([stopped, delay(5000)])
    // A framework can leave a child running after npm exits.
    try {
      process.kill(-server.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    await stopped
  }
}

module.exports = async function checkExamples({
  root,
  dir,
  run,
  container,
  port,
  tarball,
  names,
}) {
  for (const name of names) {
    console.log(`Checking ${name} example...`)
    const cwd = path.join(dir, 'examples', name)
    fs.cpSync(path.join(root, 'examples', name), cwd, {
      recursive: true,
      filter: (source) =>
        ![
          'node_modules',
          'generated',
          'compiled',
          'dist',
          'build',
          '.next',
          '.nuxt',
          '.output',
          '.astro',
          '.svelte-kit',
          '.tanstack',
          'routeTree.gen.ts',
          'next-env.d.ts',
          'package-lock.json',
          'deno.lock',
        ].includes(path.basename(source)) &&
        !/^(?:\.env)|\.(?:pem|key|tsbuildinfo)$/.test(path.basename(source)),
    })
    run(
      'npm',
      [
        'install',
        tarball,
        '--no-save',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
      ],
      cwd,
    )
    const database = `example_${name.replaceAll('-', '_')}`
    run('docker', [
      'exec',
      container,
      'createdb',
      '-U',
      'fixture_test',
      database,
    ])
    const environment = {
      DATABASE_URL: `postgresql://fixture_test:fixture_test@127.0.0.1:${port}/${database}`,
      NEXT_TELEMETRY_DISABLED: '1',
      ASTRO_TELEMETRY_DISABLED: '1',
      NUXT_TELEMETRY_DISABLED: '1',
    }
    const npm = (...args) => run('npm', ['run', ...args], cwd, environment)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(cwd, '.prisma-fixtures'), 'utf8')),
      {
        fixtures: ['./prisma/fixtures'],
        ...(name === 'nuxt'
          ? {
              client: {
                module: './src/generated/prisma/client.ts',
                adapter: 'pg',
              },
            }
          : {}),
      },
    )
    assert.match(
      npm('lint:fixtures'),
      /Linted 6 fixtures.*model schema.*static references/,
    )
    npm('db:generate')
    if (name === 'nestjs') npm('build')
    npm('db:push')
    assert.match(npm('db:seed'), /Loaded 6 fixtures/)
    const clientPath =
      name === 'nestjs'
        ? './compiled/src/generated/prisma/client.js'
        : `./src/generated/prisma/client.${name === 'nuxt' ? 'ts' : 'mts'}`
    fs.writeFileSync(
      path.join(cwd, 'check-fixtures.mjs'),
      `
      import assert from 'node:assert/strict'
      import { verify } from 'argon2'
      import { PrismaPg } from '@prisma/adapter-pg'
      import { PrismaClient } from '${clientPath}'
      const prisma = new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})})
      try {
        const users = await prisma.user.findMany({include:{posts:true},orderBy:{id:'asc'}})
        assert.equal(users.length, 3)
        for (const [index, user] of users.entries()) {
          assert.equal(user.email, 'user' + (index + 1) + '@example.test')
          assert.equal(user.posts.length, 1)
          assert.equal(user.posts[0].authorId, user.id)
          assert.match(user.password, /^\\$argon2id\\$/)
          assert.equal(await verify(user.password, 'fixture-password'), true)
          assert.equal(await verify(user.password, 'wrong-password'), false)
        }
        console.log(JSON.stringify(users))
      } finally { await prisma.$disconnect() }
    `,
    )
    const check = () =>
      run(process.execPath, ['check-fixtures.mjs'], cwd, environment)
    const beforeRepeat = check()
    assert.throws(
      () => npm('db:seed'),
      (error) =>
        error.status === 1 &&
        /FIXTURE_WRITE_FAILED/.test(error.stdout + error.stderr),
    )
    assert.equal(check(), beforeRepeat, 'failed repeat seed must roll back')
    assert.match(npm('db:reset'), /Reset and loaded 6 fixtures/)
    check()

    if (name === 'hono') {
      run(
        'npx',
        ['--no-install', 'prisma-fixtures', '--clean'],
        cwd,
        environment,
      )
      assert.match(
        run(process.execPath, ['prisma/seed.mjs'], cwd, environment),
        /Loaded 6 fixtures/,
      )
      check()
    }
    if (name === 'nestjs') {
      const config = path.join(cwd, 'prisma.config.ts')
      fs.writeFileSync(
        config,
        fs
          .readFileSync(config, 'utf8')
          .replace(
            '  migrations: {',
            "  experimental: { externalTables: true },\n  tables: { external: ['public.fixture_audit'] },\n  migrations: {",
          ),
      )
      fs.writeFileSync(
        path.join(cwd, 'check-external.mjs'),
        `
        import assert from 'node:assert/strict'
        import { PrismaPg } from '@prisma/adapter-pg'
        import { PrismaClient } from '${clientPath}'
        const prisma = new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})})
        try {
          if (process.argv[2] === 'create') {
            await prisma.$executeRawUnsafe('CREATE TABLE fixture_audit (id int PRIMARY KEY)')
            await prisma.$executeRawUnsafe('INSERT INTO fixture_audit VALUES (1)')
          } else {
            const count = process.argv[2] === 'reset' ? 3 : 0
            assert.equal(await prisma.user.count(), count)
            assert.equal(await prisma.post.count(), count)
            assert.deepEqual(await prisma.$queryRawUnsafe('SELECT id FROM fixture_audit'), [{id:1}])
          }
        } finally { await prisma.$disconnect() }
      `,
      )
      const external = (action) =>
        run(process.execPath, ['check-external.mjs', action], cwd, environment)
      external('create')
      run(
        'npx',
        ['--no-install', 'prisma-fixtures', '--clean'],
        cwd,
        environment,
      )
      external('clean')
      npm('db:reset')
      external('reset')
    }
    const { scripts } = JSON.parse(
      fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    )
    if (scripts.build && name !== 'nestjs') npm('build')
    if (scripts.typecheck) npm('typecheck')
    await checkEndpoint(cwd, environment, scripts.start ? 'start' : 'dev')
    console.log(
      `PASS ${name}: Argon2id, user/post relations, seed rollback/reset and HTTP response`,
    )
  }
}
