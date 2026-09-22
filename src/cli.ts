#!/usr/bin/env node
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadFixtures, readFixtureDefinitions } from './index'

const help = `Usage: prisma-fixtures <path...> --client <module> [options]

Load YAML/JSON fixtures using your Prisma client, in one transaction.
The client module exports a default client or an async factory(options).

  --client <module>      Path to your client module (.js, .cjs, .mjs, .ts)
  --databaseUrl <url>    Pass databaseUrl to the client factory
  --require <module>    Preload a module; repeat for additional modules
  --timeout <ms>        Transaction timeout (default: 60000)
  --list                List fixture names/entities without executing code
  --debug, -d           Include error type/code, never record data or URLs
  --no-color            Accepted for compatibility; output is always plain
  --version, -v         Print the package version
  --help, -h            Show this help
`

type CliClient = {
  $transaction: <T>(
    action: (transaction: object) => Promise<T>,
    options: { timeout: number },
  ) => Promise<T>
  $disconnect: () => Promise<void>
}

let stage = 'arguments'
let debug = false

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      client: { type: 'string' },
      databaseUrl: { type: 'string' },
      require: { type: 'string', multiple: true },
      timeout: { type: 'string', default: '60000' },
      list: { type: 'boolean' },
      debug: { type: 'boolean', short: 'd' },
      'no-color': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  debug = values.debug ?? false
  if (values.help) return void process.stdout.write(help)
  if (values.version) {
    const { version } = require('../package.json') as { version: string }
    return void console.log(version)
  }
  if (positionals.length === 0 || (!values.list && !values.client)) {
    process.stderr.write(help)
    process.exitCode = 1
    return
  }
  const timeout = Number(values.timeout)
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error('Invalid transaction timeout')
  }
  stage = 'reading fixtures'
  const definitions = positionals.flatMap((target) =>
    readFixtureDefinitions(path.resolve(target)),
  )
  if (
    new Set(definitions.map(({ name }) => name)).size !== definitions.length
  ) {
    throw new Error('Duplicate fixture name across paths')
  }
  if (values.list) {
    console.log(
      JSON.stringify(
        definitions.map(({ name, entity }) => ({ name, entity })),
        null,
        2,
      ),
    )
    return
  }

  stage = 'loading the client'
  const requireFromCwd = createRequire(path.resolve('package.json'))
  for (const preload of values.require ?? []) requireFromCwd(preload)
  const imported: { default?: unknown } = await import(
    pathToFileURL(path.resolve(values.client!)).href
  )
  let exported = imported.default
  if (exported && typeof exported === 'object' && 'default' in exported) {
    exported = exported.default
  }
  if (values.databaseUrl !== undefined && typeof exported !== 'function') {
    throw new Error('--databaseUrl requires a client factory')
  }
  const candidate: unknown =
    typeof exported === 'function'
      ? await exported({ databaseUrl: values.databaseUrl })
      : exported
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('$disconnect' in candidate) ||
    typeof candidate.$disconnect !== 'function'
  ) {
    throw new Error('The client must implement $disconnect')
  }
  const client = candidate as CliClient
  let count: number
  try {
    if (typeof client.$transaction !== 'function') {
      throw new Error('The client must implement $transaction')
    }
    stage = 'loading fixtures'
    const records = await client.$transaction(
      (transaction) => loadFixtures(transaction, definitions),
      { timeout },
    )
    count = Object.keys(records).length
  } finally {
    await client.$disconnect()
  }
  console.log(`Loaded ${count} fixtures.`)
}

main().catch((error: unknown) => {
  // Prisma and user hooks can put database URLs or record data in messages/stacks.
  const details =
    debug && error instanceof Error
      ? ` (${error.name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60)}${
          'code' in error &&
          typeof error.code === 'string' &&
          /^[A-Z0-9_]{1,40}$/.test(error.code)
            ? `: ${error.code}`
            : ''
        })`
      : ''
  console.error(`Fixture command failed during ${stage}${details}.`)
  process.exitCode = 1
})
