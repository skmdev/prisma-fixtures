const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { releaseChannel } = require('./release.cjs')

function prepareRelease(root, version) {
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file)))
  const writeJson = (file, value) =>
    fs.writeFileSync(
      path.join(root, file),
      `${JSON.stringify(value, null, 2)}\n`,
    )
  const manifest = readJson('package.json')
  releaseChannel(
    { ...manifest, version },
    `v${version}`,
    String(version.includes('-rc.')),
  )
  assert.notEqual(version, manifest.version, 'Choose a new release version')
  const lock = readJson('package-lock.json')
  manifest.version = lock.version = lock.packages[''].version = version
  writeJson('package.json', manifest)
  writeJson('package-lock.json', lock)

  const docs = ['README.md', 'CONTRIBUTING.md', 'examples/README.md']
  for (const entry of fs.readdirSync(path.join(root, 'examples'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue
    const file = `examples/${entry.name}/package.json`
    const example = readJson(file)
    example.devDependencies[manifest.name] = version
    writeJson(file, example)
    docs.push(`examples/${entry.name}/README.md`)
  }
  for (const file of docs) {
    const location = path.join(root, file)
    fs.writeFileSync(
      location,
      fs
        .readFileSync(location, 'utf8')
        .replace(
          /skmdev-prisma-fixtures-\d+\.\d+\.\d+(?:-rc\.\d+)?\.tgz/g,
          `skmdev-prisma-fixtures-${version}.tgz`,
        ),
    )
  }
}

module.exports = { prepareRelease }

if (require.main === module) {
  prepareRelease(path.resolve(__dirname, '../..'), process.env.RELEASE_VERSION)
}
