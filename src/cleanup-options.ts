import { isFixtureRecord } from './fixture-document'

export type FixturePreservedTable = string

export type FixtureCleanupOptions = {
  preserveTables?: FixturePreservedTable[]
}

export function normalizeCleanupOptions(
  value: unknown = {},
): FixtureCleanupOptions {
  if (
    !isFixtureRecord(value) ||
    Object.keys(value).some((key) => key !== 'preserveTables')
  ) {
    throw new Error('Invalid fixture cleanup options')
  }
  const preserveTables = value.preserveTables
  if (preserveTables === undefined) return {}
  if (
    !Array.isArray(preserveTables) ||
    preserveTables.some(
      (entry) => typeof entry !== 'string' || !/^[^.]+\.[^.]+$/.test(entry),
    ) ||
    new Set(preserveTables).size !== preserveTables.length
  ) {
    throw new Error('Invalid fixture cleanup options')
  }

  return { preserveTables }
}
