const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const examples = path.join(__dirname, '../examples')
for (const entry of fs.readdirSync(examples, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  execFileSync('npm', ['run', 'lint:fixtures'], {
    cwd: path.join(examples, entry.name),
    stdio: 'inherit',
  })
}
