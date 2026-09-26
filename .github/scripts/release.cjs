const assert = require('node:assert/strict')
const fs = require('node:fs')

function releaseChannel(manifest, tag, prerelease) {
  const { version, devDependencies } = manifest
  assert.match(
    version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/,
    'Only stable and numbered RC versions are supported',
  )
  assert.equal(tag, `v${version}`, 'Release tag must match package version')
  const rc = version.includes('-rc.')
  assert.equal(
    prerelease,
    String(rc),
    'GitHub prerelease flag must match version',
  )
  if (!rc && version.startsWith('1.')) {
    for (const dependency of ['prisma', '@prisma/orm-postgres']) {
      assert.match(
        devDependencies?.[dependency] ?? '',
        /^8\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
        `Stable 1.x must wait for verified Prisma 8 stable pins: ${dependency}`,
      )
    }
  }
  return rc ? 'next' : 'latest'
}

module.exports = { releaseChannel }

if (require.main === module) {
  const channel = releaseChannel(
    require('../../package.json'),
    process.env.RELEASE_TAG,
    process.env.RELEASE_PRERELEASE,
  )
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `channel=${channel}\n`)
}
