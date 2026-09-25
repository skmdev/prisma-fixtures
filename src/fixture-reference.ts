import {
  DANGEROUS_KEYS,
  type FixtureDefinition,
  fixtureErrorContext,
  inheritFixtureSource,
  isFixtureRecord,
} from './fixture-document'
import { appendFixturePath, createFixtureError } from './fixture-error'

type Dependency = { name: string; path: string }

export type PreparedFixture = FixtureDefinition & {
  dependencies: Dependency[]
}

const FIXED_REFERENCE =
  /^@([A-Za-z][A-Za-z0-9_-]{0,127})(?:\.([A-Za-z][A-Za-z0-9_]*))?$/
const WILDCARD_REFERENCE = /^@([A-Za-z][A-Za-z0-9_-]{0,126})\*$/
const RANGE_REFERENCE = /^@([A-Za-z][A-Za-z0-9_-]*)\{(\d+)\.\.(\d+)\}$/
const DYNAMIC_VALUE = /<%|{{|<{/

export function lintFixtureReferences(definitions: FixtureDefinition[]): {
  unresolved: number
} {
  const byName = new Map(definitions.map((fixture) => [fixture.name, fixture]))
  const dependencies = new Map<string, Dependency[]>()
  let unresolved = 0
  for (const fixture of definitions) {
    const found: Dependency[] = []
    unresolved += lintValue(fixture.data, byName, found, fixture, '')
    dependencies.set(fixture.name, found)
  }
  orderFixtures(definitions, dependencies, 'linting references')
  return { unresolved }
}

function lintValue(
  value: unknown,
  definitions: Map<string, FixtureDefinition>,
  dependencies: Dependency[],
  fixture: FixtureDefinition,
  path: string,
): number {
  if (typeof value === 'string') {
    if (DYNAMIC_VALUE.test(value)) return 1
    if (!value.startsWith('@') || value.startsWith('@@')) return 0
    const fixed = value.match(FIXED_REFERENCE)
    if (fixed) {
      const [, name, field] = fixed
      if (!definitions.has(name!)) {
        throw createFixtureError(
          'FIXTURE_REFERENCE_MISSING',
          'Fixture reference target not found',
          fixtureErrorContext(fixture, 'linting references', path),
        )
      }
      if (field && DANGEROUS_KEYS.has(field)) {
        throw createFixtureError(
          'FIXTURE_REFERENCE_INVALID',
          'Unsafe fixture reference field',
          fixtureErrorContext(fixture, 'linting references', path),
        )
      }
      dependencies.push({ name: name!, path })
      return 0
    }
    const candidates = referenceCandidates(
      value,
      definitions,
      fixture,
      path,
      'linting references',
    )
    if (!candidates) {
      throw createFixtureError(
        'FIXTURE_REFERENCE_INVALID',
        'Invalid fixture reference',
        fixtureErrorContext(fixture, 'linting references', path),
      )
    }
    if (candidates.length === 1) {
      dependencies.push({ name: candidates[0]!, path })
      return 0
    }
    return 1
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (count, item, index) =>
        count +
        lintValue(
          item,
          definitions,
          dependencies,
          fixture,
          appendFixturePath(path, index),
        ),
      0,
    )
  }
  if (isFixtureRecord(value)) {
    return Object.entries(value).reduce(
      (count, [key, item]) =>
        count +
        lintValue(
          item,
          definitions,
          dependencies,
          fixture,
          appendFixturePath(path, key),
        ),
      0,
    )
  }
  return 0
}

export function prepareFixtureReferences(
  definitions: FixtureDefinition[],
  random: { next: () => number } = { next: Math.random },
): PreparedFixture[] {
  const byName = new Map(definitions.map((fixture) => [fixture.name, fixture]))
  const prepared = definitions.map((fixture) => {
    const dependencies: Dependency[] = []
    const data = prepareValue(
      fixture.data,
      byName,
      dependencies,
      random,
      fixture,
      '',
    )
    const result = {
      ...fixture,
      data: data as Record<string, unknown>,
      dependencies,
    }
    inheritFixtureSource(fixture, result)
    return result
  })
  return orderFixtures(
    prepared,
    new Map(prepared.map(({ name, dependencies }) => [name, dependencies])),
    'ordering fixtures',
  )
}

function prepareValue(
  value: unknown,
  definitions: Map<string, FixtureDefinition>,
  dependencies: Dependency[],
  random: { next: () => number },
  fixture: FixtureDefinition,
  path: string,
): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith('@') || value.startsWith('@@')) return value
    const selected = selectReference(value, definitions, random, fixture, path)
    const match = selected.match(FIXED_REFERENCE)
    if (!match) {
      throw createFixtureError(
        'FIXTURE_REFERENCE_INVALID',
        'Invalid fixture reference',
        fixtureErrorContext(fixture, 'preparing references', path),
      )
    }
    const [, name, field] = match
    const target = definitions.get(name!)
    if (!target) {
      throw createFixtureError(
        'FIXTURE_REFERENCE_MISSING',
        'Fixture reference target not found',
        fixtureErrorContext(fixture, 'preparing references', path),
      )
    }
    if (field && DANGEROUS_KEYS.has(field)) {
      throw createFixtureError(
        'FIXTURE_REFERENCE_INVALID',
        'Unsafe fixture reference field',
        fixtureErrorContext(fixture, 'preparing references', path),
      )
    }
    if (!dependencies.some((dependency) => dependency.name === name)) {
      dependencies.push({ name: name!, path })
    }
    return selected
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      prepareValue(
        item,
        definitions,
        dependencies,
        random,
        fixture,
        appendFixturePath(path, index),
      ),
    )
  }
  if (isFixtureRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        prepareValue(
          item,
          definitions,
          dependencies,
          random,
          fixture,
          appendFixturePath(path, key),
        ),
      ]),
    )
  }
  return value
}

function selectReference(
  value: string,
  definitions: Map<string, FixtureDefinition>,
  random: { next: () => number },
  fixture: FixtureDefinition,
  path: string,
) {
  const candidates = referenceCandidates(value, definitions, fixture, path)
  return candidates ? `@${pick(candidates, random)}` : value
}

function referenceCandidates(
  value: string,
  definitions: Map<string, FixtureDefinition>,
  fixture: FixtureDefinition,
  path: string,
  stage = 'preparing references',
): string[] | undefined {
  const wildcard = value.match(WILDCARD_REFERENCE)
  if (wildcard) {
    const pattern = new RegExp(`^${wildcard[1]}\\d+$`)
    const candidates = [...definitions.keys()].filter((name) =>
      pattern.test(name),
    )
    if (!candidates.length) {
      throw createFixtureError(
        'FIXTURE_REFERENCE_MISSING',
        'Fixture reference candidates not found',
        fixtureErrorContext(fixture, stage, path),
      )
    }
    return candidates
  }

  const range = value.match(RANGE_REFERENCE)
  if (!range) return undefined
  const start = Number(range[2])
  const end = Number(range[3])
  const length = end - start + 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(length) ||
    start > end
  ) {
    throw createFixtureError(
      'FIXTURE_REFERENCE_INVALID',
      'Invalid fixture reference range',
      fixtureErrorContext(fixture, stage, path),
    )
  }
  if (length > definitions.size) {
    throw createFixtureError(
      'FIXTURE_REFERENCE_MISSING',
      'Fixture reference candidates not found',
      fixtureErrorContext(fixture, stage, path),
    )
  }
  const candidates = Array.from(
    { length },
    (_, offset) => `${range[1]}${start + offset}`,
  )
  if (candidates.some((name) => !definitions.has(name))) {
    throw createFixtureError(
      'FIXTURE_REFERENCE_MISSING',
      'Fixture reference candidates not found',
      fixtureErrorContext(fixture, stage, path),
    )
  }
  return candidates
}

function pick<T>(values: T[], random: { next: () => number }) {
  return values[Math.floor(random.next() * values.length)]!
}

function orderFixtures<T extends FixtureDefinition>(
  fixtures: T[],
  dependencies: Map<string, Dependency[]>,
  stage: string,
): T[] {
  const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]))
  const state = new Map<string, 'visiting' | 'visited'>()
  const ordered: T[] = []
  const stack: string[] = []

  const visit = (fixture: T) => {
    if (state.get(fixture.name) === 'visited') return
    state.set(fixture.name, 'visiting')
    stack.push(fixture.name)
    for (const dependency of dependencies.get(fixture.name) ?? []) {
      if (state.get(dependency.name) === 'visiting') {
        const start = stack.indexOf(dependency.name)
        const cycle = [...stack.slice(start), dependency.name].join(' -> ')
        throw createFixtureError(
          'FIXTURE_DEPENDENCY_CYCLE',
          `Fixture dependency cycle: ${cycle}`,
          fixtureErrorContext(fixture, stage, dependency.path),
        )
      }
      visit(byName.get(dependency.name)!)
    }
    stack.pop()
    state.set(fixture.name, 'visited')
    ordered.push(fixture)
  }
  fixtures.forEach(visit)
  return ordered
}

export function resolveFixtureReferences(
  value: unknown,
  records: Record<string, Record<string, unknown>>,
  fixture?: FixtureDefinition,
  path = '',
): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('@@')) return value.slice(1)
    if (!value.startsWith('@')) return value
    const match = value.match(FIXED_REFERENCE)
    if (!match) {
      throw createFixtureError(
        'FIXTURE_REFERENCE_INVALID',
        'Invalid fixture reference',
        fixtureErrorContext(fixture, 'resolving references', path),
      )
    }
    const [, name, field] = match
    const record = records[name!]
    if (!record) {
      throw createFixtureError(
        'FIXTURE_REFERENCE_MISSING',
        'Fixture reference target was not loaded',
        fixtureErrorContext(fixture, 'resolving references', path),
      )
    }
    if (!field) return record
    if (DANGEROUS_KEYS.has(field)) {
      throw createFixtureError(
        'FIXTURE_REFERENCE_INVALID',
        'Unsafe fixture reference field',
        fixtureErrorContext(fixture, 'resolving references', path),
      )
    }
    if (!Object.hasOwn(record, field) || record[field] === undefined) {
      throw createFixtureError(
        'FIXTURE_REFERENCE_FIELD_MISSING',
        'Referenced fixture field is missing from the loaded record',
        fixtureErrorContext(fixture, 'resolving references', path),
      )
    }
    return record[field]
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      resolveFixtureReferences(
        item,
        records,
        fixture,
        appendFixturePath(path, index),
      ),
    )
  }
  if (isFixtureRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveFixtureReferences(
          item,
          records,
          fixture,
          appendFixturePath(path, key),
        ),
      ]),
    )
  }
  return value
}

export function applyFixtureConnections(
  data: Record<string, unknown>,
  connectedFields: string[] | undefined,
  fixture?: FixtureDefinition,
) {
  if (!connectedFields?.length) return data
  const connected = { ...data }
  for (const field of connectedFields) {
    if (!Object.hasOwn(connected, field) || connected[field] == null) continue
    const value = connected[field]
    const fieldPath = appendFixturePath('', field)
    connected[field] = {
      connect: Array.isArray(value)
        ? value.map((record, index) =>
            connectionId(record, fixture, appendFixturePath(fieldPath, index)),
          )
        : connectionId(value, fixture, fieldPath),
    }
  }
  return connected
}

function connectionId(
  value: unknown,
  fixture: FixtureDefinition | undefined,
  path: string,
) {
  if (
    !isFixtureRecord(value) ||
    !Object.hasOwn(value, 'id') ||
    value.id === undefined
  ) {
    throw createFixtureError(
      'FIXTURE_CONNECTION_FAILED',
      'Fixture connection record is invalid',
      fixtureErrorContext(fixture, 'connecting fixture', path),
    )
  }
  return { id: value.id }
}
