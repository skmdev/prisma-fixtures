const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { loadPrismaDefaults } = require('../dist/prisma-config.js')

test('Prisma 8 config discovers contract output, URL override and unmanaged tables', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma8-config-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.symlinkSync(
    path.resolve(__dirname, '../node_modules'),
    path.join(root, 'node_modules'),
    'dir',
  )
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(
    path.join(root, 'prisma.config.ts'),
    `
    import { definePrismaConfig } from 'prisma/config'
    import { defineConfig } from '@prisma/orm-postgres/config'
    export default definePrismaConfig({ orm: defineConfig({
      contract: './contract.prisma', output: './emitted',
      db: { connection: process.env.DATABASE_URL },
    }) })
  `,
  )
  fs.mkdirSync(path.join(root, 'emitted'))
  fs.writeFileSync(
    path.join(root, 'emitted/contract.json'),
    JSON.stringify({
      storage: {
        namespaces: {
          public: {
            entries: {
              table: {
                users: {},
                audit: { control: 'external' },
                reporting: { control: 'observed' },
              },
            },
          },
        },
      },
    }),
  )
  const previous = process.env.DATABASE_URL
  const result = await loadPrismaDefaults(
    root,
    createRequire(path.join(root, 'package.json')),
    'postgresql://fixture-local/test',
  )
  assert.deepEqual(result, {
    module: path.join(root, 'emitted/contract.json'),
    databaseUrl: 'postgresql://fixture-local/test',
    preserveTables: ['public.audit', 'public.reporting'],
  })
  assert.equal(process.env.DATABASE_URL, previous)
})
