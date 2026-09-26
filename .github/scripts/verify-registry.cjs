const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { setTimeout } = require('node:timers/promises')
const { releaseChannel } = require('./release.cjs')

async function waitForRegistry(
  manifest,
  tag,
  previousLatest,
  {
    readTags = () =>
      JSON.parse(
        execFileSync(
          'npm',
          ['view', manifest.name, 'dist-tags', '--json', '--prefer-online'],
          { encoding: 'utf8' },
        ),
      ),
    wait = setTimeout,
  } = {},
) {
  const { version } = manifest
  const channel = releaseChannel(
    manifest,
    tag,
    String(version.includes('-rc.')),
  )
  if (channel === 'next')
    assert.ok(previousLatest, 'Previous stable version is required')
  for (let attempt = 1; attempt <= 30; attempt++) {
    const tags = readTags()
    if (channel === 'next') {
      assert.equal(
        tags.latest,
        previousLatest,
        'npm stable channel changed during RC publication',
      )
    }
    if (tags[channel] === version) return
    if (attempt < 30) {
      console.log(
        `Waiting for npm ${channel}=${version} (attempt ${attempt}/30)`,
      )
      await wait(10_000)
    }
  }
  throw new Error(`npm ${channel}=${version} was not visible after 30 attempts`)
}

module.exports = { waitForRegistry }

if (require.main === module) {
  waitForRegistry(
    require('../../package.json'),
    process.env.RELEASE_TAG,
    process.env.PREVIOUS_LATEST,
  ).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
