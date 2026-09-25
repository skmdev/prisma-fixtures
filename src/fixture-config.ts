import fs from 'node:fs'
import path from 'node:path'

import {
  type FixtureCleanupOptions,
  normalizeCleanupOptions,
} from './cleanup-options'
import { isFixtureRecord } from './fixture-document'
import { type FixtureLoadOptions, normalizeLoadOptions } from './load-options'

export type ConfiguredPrismaClient = {
  module: string
  adapter: 'pg'
  guard?: string
}

export type FixtureConfig = FixtureCleanupOptions &
  FixtureLoadOptions & {
    fixtures?: string[]
    client?: string | ConfiguredPrismaClient
    timeout?: number
    schema?: string
  }

export function readFixtureConfig(file?: string): FixtureConfig {
  const configFile = path.resolve(file ?? '.prisma-fixtures')
  let raw: string
  try {
    raw = fs.readFileSync(configFile, 'utf8')
  } catch (error) {
    if (
      file === undefined &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return {}
    }
    throw error
  }
  const config: unknown = JSON.parse(raw)
  if (
    !isFixtureRecord(config) ||
    Object.keys(config).some(
      (key) =>
        ![
          'fixtures',
          'client',
          'timeout',
          'schema',
          'preserveTables',
          'seed',
          'refDate',
        ].includes(key),
    )
  ) {
    throw new Error('Invalid fixture CLI config')
  }
  const { fixtures, client, timeout, schema, preserveTables, seed, refDate } =
    config
  if (
    (fixtures !== undefined &&
      (!Array.isArray(fixtures) ||
        !fixtures.length ||
        !fixtures.every(isPath))) ||
    (client !== undefined && !isClientConfig(client)) ||
    (schema !== undefined && !isPath(schema)) ||
    (timeout !== undefined &&
      (typeof timeout !== 'number' ||
        !Number.isSafeInteger(timeout) ||
        timeout <= 0))
  ) {
    throw new Error('Invalid fixture CLI config')
  }
  let cleanup: FixtureCleanupOptions
  let load: FixtureLoadOptions
  try {
    cleanup = normalizeCleanupOptions({ preserveTables })
    load = normalizeLoadOptions({ seed, refDate })
  } catch {
    throw new Error('Invalid fixture CLI config')
  }
  const directory = path.dirname(configFile)
  return {
    fixtures: fixtures?.map((target) => path.resolve(directory, target)),
    client: resolveClientPaths(client, directory),
    timeout,
    schema: schema === undefined ? undefined : path.resolve(directory, schema),
    ...cleanup,
    ...load,
  }
}

function isPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isClientConfig(
  value: unknown,
): value is string | ConfiguredPrismaClient {
  return (
    isPath(value) ||
    (isFixtureRecord(value) &&
      Object.keys(value).every((key) =>
        ['module', 'adapter', 'guard'].includes(key),
      ) &&
      isPath(value.module) &&
      value.adapter === 'pg' &&
      (value.guard === undefined || isPath(value.guard)))
  )
}

function resolveClientPaths(
  client: FixtureConfig['client'],
  directory: string,
): FixtureConfig['client'] {
  if (client === undefined) return undefined
  if (typeof client === 'string') return path.resolve(directory, client)
  return {
    module: path.resolve(directory, client.module),
    adapter: 'pg',
    ...(client.guard === undefined
      ? {}
      : { guard: path.resolve(directory, client.guard) }),
  }
}
