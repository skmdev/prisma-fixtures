const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { parse } = require('yaml')

test('release version guard rejects mismatched tags and prerelease versions', (t) => {
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

  for (const [version, tag, status] of [
    ['0.1.0', 'v0.1.0', 0],
    ['0.1.0', 'v0.1.1', 1],
    ['0.1.0', '0.1.0', 1],
    ['0.1.0-beta.1', 'v0.1.0-beta.1', 1],
  ]) {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ version }),
    )
    const result = spawnSync('bash', ['-e', '-c', run], {
      cwd,
      env: { PATH: process.env.PATH, RELEASE_TAG: tag },
      encoding: 'utf8',
    })
    assert.equal(result.status, status, `${version} / ${tag}: ${result.stderr}`)
  }
})
