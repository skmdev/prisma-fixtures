import type { FixtureCleanupOptions } from './cleanup-options'
import { normalizeCleanupOptions } from './cleanup-options'
import { isFixtureRecord } from './fixture-document'
import { createFixtureError, type FixtureError } from './fixture-error'

export type FixtureLoadOptions = {
  seed?: number
  refDate?: string
}

export type FixtureResetOptions = FixtureCleanupOptions & FixtureLoadOptions

export function normalizeLoadOptions(value: unknown = {}): FixtureLoadOptions {
  if (
    !isFixtureRecord(value) ||
    Object.keys(value).some((key) => !['seed', 'refDate'].includes(key))
  ) {
    throw invalidLoadOptions()
  }

  const { seed, refDate } = value
  if (
    (seed !== undefined &&
      (typeof seed !== 'number' ||
        !Number.isInteger(seed) ||
        seed < 0 ||
        seed > 0xffff_ffff)) ||
    (refDate !== undefined && !isCanonicalReferenceDate(refDate))
  ) {
    throw invalidLoadOptions()
  }

  return {
    ...(seed === undefined ? {} : { seed }),
    ...(refDate === undefined ? {} : { refDate }),
  }
}

export function normalizeResetOptions(value: unknown = {}): {
  load: FixtureLoadOptions
  cleanup: FixtureCleanupOptions
} {
  if (
    !isFixtureRecord(value) ||
    Object.keys(value).some(
      (key) => !['seed', 'refDate', 'preserveTables'].includes(key),
    )
  ) {
    throw invalidLoadOptions()
  }

  return {
    load: normalizeLoadOptions({ seed: value.seed, refDate: value.refDate }),
    cleanup: normalizeCleanupOptions(
      value.preserveTables === undefined
        ? {}
        : { preserveTables: value.preserveTables },
    ),
  }
}

function isCanonicalReferenceDate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false
  }
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}

function invalidLoadOptions(): FixtureError {
  return createFixtureError(
    'FIXTURE_OPTIONS_INVALID',
    'Invalid fixture load options',
    { stage: 'validating options' },
  )
}
