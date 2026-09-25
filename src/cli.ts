#!/usr/bin/env node
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import Ajv from 'ajv'
import {
  FixtureDocumentError,
  isFixtureRecord,
  MAX_FIXTURE_DEFINITIONS,
} from './fixture-document'
import { type FixtureError, isTrustedFixtureError } from './fixture-error'
import { lintFixtureReferences } from './fixture-reference'
import { normalizeLoadOptions } from './load-options'
import { loadPrismaDefaults } from './prisma-config'
import { readFixtureConfig } from './fixture-config'
import {
  cleanFixtures,
  loadFixtures,
  readFixtureDefinitions,
  resetFixtures,
} from './index'

const help = `Usage: prisma-fixtures [path...] [--client <module>] [options]
       prisma-fixtures init [fixtures-directory]

Load YAML/JSON fixtures using your Prisma client, in one transaction.
Defaults are read from .prisma-fixtures (JSON) and adjacent Prisma config.
A string client exports a client/factory; a config client object names generated Prisma output.
init creates a minimal config without overwriting existing config.

  --config <file>        Read a JSON config instead of .prisma-fixtures
  --client <module>      Path to your client module (.js, .cjs, .mjs, .ts)
  --databaseUrl <url>    Override Prisma config URL or pass to a client factory
  --require <module>    Preload a module; repeat for additional modules
  --timeout <ms>        Transaction timeout (default: 60000)
  --seed <integer>      Reproduce generated values and random references
  --refDate <timestamp> Fix Faker relative dates (canonical UTC timestamp)
  --clean               Clear database data, preserving schema and migrations
  --reset               Clear database data, then load fixtures
  --list                List fixture names/entities without executing code
  --lint                Check fixture syntax/structure without executing code
  --schema <file>       Also validate --lint against a generated JSON Schema
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

type FixtureGuard = {
  fixtureDatabaseUrl: (env: NodeJS.ProcessEnv) => string
  fixtureTransaction: <T>(
    client: CliClient,
    action: (transaction: object) => Promise<T>,
    timeout: number,
  ) => Promise<T>
}

let stage = 'arguments'
let debug = false
let lint = false

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      client: { type: 'string' },
      databaseUrl: { type: 'string' },
      require: { type: 'string', multiple: true },
      timeout: { type: 'string' },
      seed: { type: 'string' },
      refDate: { type: 'string' },
      clean: { type: 'boolean' },
      reset: { type: 'boolean' },
      list: { type: 'boolean' },
      lint: { type: 'boolean' },
      schema: { type: 'string' },
      debug: { type: 'boolean', short: 'd' },
      'no-color': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  debug = values.debug ?? false
  lint = values.lint ?? false
  if (values.help) return void process.stdout.write(help)
  if (values.version) {
    const { version } = require('../package.json') as { version: string }
    return void console.log(version)
  }
  if (positionals[0] === 'init') {
    if (positionals.length > 2 || Object.keys(values).length !== 0) {
      throw new Error('init accepts only an optional fixtures directory')
    }
    stage = 'initializing config'
    if (fs.existsSync('.prisma-fixtures')) {
      console.error('.prisma-fixtures already exists; no changes made.')
      process.exitCode = 1
      return
    }
    const fixtures =
      positionals[1] ??
      (fs.existsSync('prisma/fixtures') ? './prisma/fixtures' : './fixtures')
    if (positionals[1]) {
      if (!fs.existsSync(fixtures) || !fs.statSync(fixtures).isDirectory()) {
        console.error('Fixture directory does not exist; no changes made.')
        process.exitCode = 1
        return
      }
    } else {
      fs.mkdirSync(fixtures, { recursive: true })
    }
    fs.writeFileSync(
      '.prisma-fixtures',
      `${JSON.stringify({ fixtures: [fixtures] }, null, 2)}\n`,
      { flag: 'wx' },
    )
    console.log(`Created .prisma-fixtures using ${fixtures}.`)
    return
  }
  stage = 'reading config'
  const config = readFixtureConfig(values.config)
  const targets = positionals.length ? positionals : (config.fixtures ?? [])
  let clientConfig = values.client ? path.resolve(values.client) : config.client
  stage = 'arguments'
  if (
    (!values.clean && targets.length === 0) ||
    [values.list, lint, values.clean, values.reset].filter(Boolean).length > 1
  ) {
    process.stderr.write(help)
    process.exitCode = 1
    return
  }
  const timeout = Number(values.timeout ?? config.timeout ?? 60000)
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error('Invalid transaction timeout')
  }
  const cliSeed = values.seed
  if (cliSeed !== undefined && !/^\d+$/.test(cliSeed)) {
    throw new Error('Invalid fixture load options')
  }
  const loadOptions = normalizeLoadOptions({
    seed: cliSeed === undefined ? config.seed : Number(cliSeed),
    refDate: values.refDate ?? config.refDate,
  })
  const schemaFile = values.schema ?? config.schema
  let validate: ReturnType<Ajv['compile']> | undefined
  if (lint && schemaFile !== undefined) {
    stage = 'reading schema'
    const raw = fs.readFileSync(path.resolve(schemaFile), 'utf8')
    try {
      validate = new Ajv({ strict: false, validateFormats: false }).compile(
        JSON.parse(raw),
      )
    } catch {
      throw new FixtureDocumentError('Invalid fixture JSON Schema')
    }
  }
  stage = 'reading fixtures'
  const definitions = values.clean
    ? []
    : targets.flatMap((target) =>
        readFixtureDefinitions(path.resolve(target), (document, file) => {
          if (validate && !validate(document)) {
            const error = validate.errors?.[0]
            throw new FixtureDocumentError(
              `Fixture document ${JSON.stringify(path.basename(file))}: ${JSON.stringify(error?.instancePath || '/')} ${error?.message ?? 'does not match the schema'}`,
            )
          }
        }),
      )
  if (
    new Set(definitions.map(({ name }) => name)).size !== definitions.length
  ) {
    throw new FixtureDocumentError('Duplicate fixture name across paths')
  }
  if (lint) {
    if (definitions.length > MAX_FIXTURE_DEFINITIONS) {
      throw new FixtureDocumentError('Too many fixture definitions')
    }
    const { unresolved } = lintFixtureReferences(definitions)
    console.log(
      `Linted ${definitions.length} fixtures (syntax and structure${schemaFile === undefined ? '' : ', model schema'}, static references; ${unresolved} dynamic values or multi-candidate references unresolved).`,
    )
    return
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
  let prismaDefaults: Awaited<ReturnType<typeof loadPrismaDefaults>> | undefined
  if (!clientConfig) {
    stage = 'loading Prisma config'
    prismaDefaults = await loadPrismaDefaults(
      path.dirname(path.resolve(values.config ?? '.prisma-fixtures')),
      requireFromCwd,
      values.databaseUrl,
    )
    const clientExtension = path.extname(prismaDefaults.module)
    if (
      (clientExtension === '.ts' || clientExtension === '.cts') &&
      !require.extensions[clientExtension]
    ) {
      requireFromCwd('ts-node/register')
    }
    clientConfig = { module: prismaDefaults.module, adapter: 'pg' }
    stage = 'loading the client'
  }
  const preserveTables = [
    ...new Set([
      ...(config.preserveTables ?? []),
      ...(prismaDefaults?.preserveTables ?? []),
    ]),
  ]
  let candidate: unknown
  let guard: FixtureGuard | undefined
  if (typeof clientConfig === 'string') {
    const imported: { default?: unknown } = await import(
      pathToFileURL(clientConfig).href
    )
    let exported = imported.default
    if (exported && typeof exported === 'object' && 'default' in exported) {
      exported = exported.default
    }
    if (values.databaseUrl !== undefined && typeof exported !== 'function') {
      throw new Error('--databaseUrl requires a client factory')
    }
    candidate =
      typeof exported === 'function'
        ? await exported({ databaseUrl: values.databaseUrl })
        : exported
  } else {
    if (clientConfig?.guard) {
      const imported: unknown = requireFromCwd(clientConfig.guard)
      if (
        !isFixtureRecord(imported) ||
        typeof imported.fixtureDatabaseUrl !== 'function' ||
        typeof imported.fixtureTransaction !== 'function'
      ) {
        throw new Error('Invalid fixture guard module')
      }
      guard = imported as FixtureGuard
    }
    const environment = {
      ...process.env,
      ...(values.databaseUrl === undefined
        ? {}
        : { DATABASE_URL: values.databaseUrl }),
    }
    const databaseUrl = guard
      ? guard.fixtureDatabaseUrl(environment)
      : (values.databaseUrl ??
        prismaDefaults?.databaseUrl ??
        environment.DATABASE_URL)
    if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
      throw new Error('DATABASE_URL is required')
    }
    const generated: unknown = await importGeneratedClient(
      clientConfig!.module,
      requireFromCwd,
    )
    const exports = isFixtureRecord(generated) ? generated : undefined
    const nested = isFixtureRecord(exports?.default)
      ? exports.default
      : undefined
    const constructor = exports?.PrismaClient ?? nested?.PrismaClient
    const adapter = requireFromCwd('@prisma/adapter-pg') as {
      PrismaPg?: new (options: { connectionString: string }) => unknown
    }
    if (
      typeof constructor !== 'function' ||
      typeof adapter.PrismaPg !== 'function'
    ) {
      throw new Error('Invalid generated Prisma client or pg adapter')
    }
    candidate = new (constructor as new (options: {
      adapter: unknown
    }) => unknown)({
      adapter: new adapter.PrismaPg({ connectionString: databaseUrl }),
    })
  }
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
  let operationError: unknown
  try {
    if (typeof client.$transaction !== 'function') {
      throw new Error('The client must implement $transaction')
    }
    stage = values.clean
      ? 'cleaning fixtures'
      : values.reset
        ? 'resetting fixtures'
        : 'loading fixtures'
    const action = async (transaction: object) => {
      if (values.clean) {
        await cleanFixtures(transaction, {
          preserveTables,
        })
        return
      }
      return values.reset
        ? resetFixtures(transaction, definitions, {
            preserveTables,
            ...loadOptions,
          })
        : loadFixtures(transaction, definitions, loadOptions)
    }
    const records = guard
      ? await guard.fixtureTransaction(client, action, timeout)
      : await client.$transaction(action, { timeout })
    count = records === undefined ? 0 : Object.keys(records).length
  } catch (error) {
    operationError = error
    throw error
  } finally {
    try {
      if (operationError === undefined) stage = 'disconnecting the client'
      await client.$disconnect()
    } catch (error) {
      if (operationError === undefined) throw error
    }
  }
  console.log(
    values.clean
      ? 'Cleaned database data.'
      : `${values.reset ? 'Reset and loaded' : 'Loaded'} ${count} fixtures.`,
  )
}

async function importGeneratedClient(
  modulePath: string,
  requireFromCwd: NodeRequire,
): Promise<unknown> {
  try {
    return requireFromCwd(modulePath)
  } catch (error) {
    if (
      error === null ||
      typeof error !== 'object' ||
      !('code' in error) ||
      !['ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE'].includes(
        String(error.code),
      )
    ) {
      throw error
    }
    return import(pathToFileURL(modulePath).href)
  }
}

main().catch((error: unknown) => {
  if (isTrustedFixtureError(error)) {
    console.error(formatFixtureError(error))
    process.exitCode = 1
    return
  }
  // Prisma and user hooks can put database URLs or record data in messages/stacks.
  const details =
    debug && error instanceof Error
      ? ` (${error.name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60)})`
      : ''
  console.error(`Fixture command failed during ${stage}${details}.`)
  process.exitCode = 1
})

function formatFixtureError(error: FixtureError): string {
  const location = [error.file, error.fixtureName, error.path]
    .filter((value): value is string => value !== undefined)
    .map((value) => JSON.stringify(value))
    .join(' ')
  const output = `Fixture command failed during ${error.stage} [${error.code}]: ${location}${location ? ' ' : ''}${error.message}.`
  const suffix = '… [truncated]'
  return output.length <= 4096
    ? output
    : `${output.slice(0, 4096 - suffix.length)}${suffix}`
}
