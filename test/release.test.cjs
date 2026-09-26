const assert = require('node:assert/strict')
const { test } = require('node:test')
const { releaseChannel } = require('../.github/scripts/release.cjs')
const { prepareRelease } = require('../.github/scripts/prepare-release.cjs')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parse } = require('yaml')

const manifest = {
  version: '1.0.0-rc.1',
  devDependencies: {
    prisma: '8.0.0-rc.17',
    '@prisma/orm-postgres': '8.0.0-rc.12',
  },
}

test('built package commands are executable before npm installs or links them', () => {
  const { bin } = require('../package.json')
  for (const target of Object.values(bin)) {
    fs.accessSync(path.join(__dirname, '..', target), fs.constants.X_OK)
  }
})

test('workflow release guard requires matching version, tag and prerelease flag', (t) => {
  const workflow = parse(
    fs.readFileSync(
      path.join(__dirname, '../.github/workflows/publish.yml'),
      'utf8',
    ),
  )
  const { run } = workflow.jobs.publish.steps.find(
    (step) => step.name === 'Check release version',
  )
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-fixtures-release-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  fs.mkdirSync(path.join(cwd, '.github/scripts'), { recursive: true })
  fs.copyFileSync(
    path.join(__dirname, '../.github/scripts/release.cjs'),
    path.join(cwd, '.github/scripts/release.cjs'),
  )
  for (const [version, tag, prerelease, channel] of [
    ['0.1.2', 'v0.1.2', 'false', 'latest'],
    ['0.1.2', 'v0.1.3', 'false', null],
    ['0.1.2', '0.1.2', 'false', null],
    ['0.1.2', 'v0.1.2', 'true', null],
    ['1.0.0-rc.1', 'v1.0.0-rc.1', 'true', 'next'],
    ['1.0.0-rc.1', 'v1.0.0-rc.1', 'false', null],
    ['1.0.0-rc.1', 'v1.0.0-rc.2', 'true', null],
    ['1.0.0-rc.1', 'v1.0.0-rc.1', '', null],
    ['1.0.0-beta.1', 'v1.0.0-beta.1', 'true', null],
    ['01.0.0', 'v01.0.0', 'false', null],
    ['1.0.0-rc.01', 'v1.0.0-rc.01', 'true', null],
  ]) {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ ...manifest, version }),
    )
    const output = path.join(cwd, 'output')
    fs.writeFileSync(output, '')
    const result = spawnSync('bash', ['-e', '-c', run], {
      cwd,
      env: {
        PATH: process.env.PATH,
        RELEASE_TAG: tag,
        RELEASE_PRERELEASE: prerelease,
        GITHUB_OUTPUT: output,
      },
      encoding: 'utf8',
    })
    assert.equal(
      result.status,
      channel ? 0 : 1,
      `${version} / ${tag}: ${result.stderr}`,
    )
    assert.equal(
      fs.readFileSync(output, 'utf8'),
      channel ? `channel=${channel}\n` : '',
    )
  }
})

test('stable 1.x waits for both verified upstream Prisma v8 stable pins', () => {
  const stable = { ...manifest, version: '1.0.0' }
  assert.throws(() => releaseChannel(stable, 'v1.0.0', 'false'), /Prisma 8/)
  stable.devDependencies = {
    prisma: '8.0.0',
    '@prisma/orm-postgres': '8.0.0',
  }
  assert.equal(releaseChannel(stable, 'v1.0.0', 'false'), 'latest')
  for (const dependency of ['prisma', '@prisma/orm-postgres']) {
    for (const version of ['8.0.0-rc.17', '7.10.0', '^8.0.0', undefined]) {
      assert.throws(() =>
        releaseChannel(
          {
            ...stable,
            devDependencies: {
              ...stable.devDependencies,
              [dependency]: version,
            },
          },
          'v1.0.0',
          'false',
        ),
      )
    }
  }
})

test('registry verification waits for propagation but rejects channel drift and timeout', async () => {
  const { waitForRegistry } = require('../.github/scripts/verify-registry.cjs')
  let reads = 0
  const wait = async () => {}
  await waitForRegistry(manifest, 'v1.0.0-rc.1', '0.1.1', {
    readTags: () =>
      ++reads < 3
        ? { latest: '0.1.1' }
        : { latest: '0.1.1', next: '1.0.0-rc.1' },
    wait,
  })
  assert.equal(reads, 3)
  await assert.rejects(
    waitForRegistry(manifest, 'v1.0.0-rc.1', '0.1.1', {
      readTags: () => ({ latest: '1.0.0-rc.1', next: '1.0.0-rc.1' }),
      wait,
    }),
    /stable channel changed/,
  )
  reads = 0
  await assert.rejects(
    waitForRegistry(manifest, 'v1.0.0-rc.1', '0.1.1', {
      readTags: () => {
        reads++
        return { latest: '0.1.1' }
      },
      wait,
    }),
    /30 attempts/,
  )
  assert.equal(reads, 30)
})

test('release preparation updates a coherent package and examples without accepting stable early', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-release-'))
  const write = (file, content) =>
    fs.writeFileSync(path.join(root, file), content)
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file)))
  try {
    fs.mkdirSync(path.join(root, 'examples/hono'), { recursive: true })
    write(
      'package.json',
      JSON.stringify({
        ...manifest,
        name: '@skmdev/prisma-fixtures',
        version: '0.1.1',
      }),
    )
    write(
      'package-lock.json',
      JSON.stringify({
        version: '0.1.1',
        packages: { '': { version: '0.1.1' } },
      }),
    )
    write(
      'examples/hono/package.json',
      JSON.stringify({
        devDependencies: { '@skmdev/prisma-fixtures': '0.1.1' },
      }),
    )
    for (const file of [
      'README.md',
      'CONTRIBUTING.md',
      'examples/README.md',
      'examples/hono/README.md',
    ]) {
      write(file, 'npm install ./skmdev-prisma-fixtures-0.1.1.tgz\n')
    }
    assert.throws(() => prepareRelease(root, '1.0.0'), /Prisma 8/)
    assert.equal(read('package.json').version, '0.1.1')
    prepareRelease(root, '1.0.0-rc.1')
    assert.equal(read('package.json').version, '1.0.0-rc.1')
    assert.equal(read('package-lock.json').version, '1.0.0-rc.1')
    assert.equal(read('package-lock.json').packages[''].version, '1.0.0-rc.1')
    assert.equal(
      read('examples/hono/package.json').devDependencies[
        '@skmdev/prisma-fixtures'
      ],
      '1.0.0-rc.1',
    )
    assert.match(
      fs.readFileSync(path.join(root, 'examples/hono/README.md'), 'utf8'),
      /skmdev-prisma-fixtures-1\.0\.0-rc\.1\.tgz/,
    )
    assert.throws(
      () => prepareRelease(root, '1.0.0-rc.1'),
      /new release version/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
