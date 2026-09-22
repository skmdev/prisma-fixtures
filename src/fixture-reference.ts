import {
  DANGEROUS_KEYS,
  type FixtureDefinition,
  isFixtureRecord,
} from './fixture-document'

export type PreparedFixture = FixtureDefinition & { dependencies: string[] }

const FIXED_REFERENCE =
  /^@([A-Za-z][A-Za-z0-9_-]{0,127})(?:\.([A-Za-z][A-Za-z0-9_]*))?$/
const WILDCARD_REFERENCE = /^@([A-Za-z][A-Za-z0-9_-]{0,126})\*$/
const RANGE_REFERENCE = /^@([A-Za-z][A-Za-z0-9_-]*)\{(\d+)\.\.(\d+)\}$/

export function prepareFixtureReferences(
  definitions: FixtureDefinition[],
): PreparedFixture[] {
  const byName = new Map(definitions.map((fixture) => [fixture.name, fixture]))
  const prepared = definitions.map((fixture) => {
    const dependencies: string[] = []
    const data = prepareValue(fixture.data, byName, dependencies)
    return { ...fixture, data: data as Record<string, unknown>, dependencies }
  })
  return orderFixtures(prepared)
}

function prepareValue(
  value: unknown,
  definitions: Map<string, FixtureDefinition>,
  dependencies: string[],
): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith('@') || value.startsWith('@@')) return value
    const selected = selectReference(value, definitions)
    const match = selected.match(FIXED_REFERENCE)
    if (!match) throw new Error('Invalid fixture reference')
    const [, name, field] = match
    const target = definitions.get(name!)
    if (!target) throw new Error('Fixture reference not found')
    if (field && DANGEROUS_KEYS.has(field))
      throw new Error('Unsafe reference field')
    if (!dependencies.includes(name!)) dependencies.push(name!)
    return selected
  }
  if (Array.isArray(value)) {
    return value.map((item) => prepareValue(item, definitions, dependencies))
  }
  if (isFixtureRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        prepareValue(item, definitions, dependencies),
      ]),
    )
  }
  return value
}

function selectReference(
  value: string,
  definitions: Map<string, FixtureDefinition>,
) {
  const wildcard = value.match(WILDCARD_REFERENCE)
  if (wildcard) {
    const pattern = new RegExp(`^${wildcard[1]}\\d+$`)
    const candidates = [...definitions.keys()].filter((name) =>
      pattern.test(name),
    )
    if (!candidates.length) throw new Error('Fixture reference not found')
    return `@${pick(candidates)}`
  }

  const range = value.match(RANGE_REFERENCE)
  if (!range) return value
  const start = Number(range[2])
  const end = Number(range[3])
  const length = end - start + 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(length) ||
    start > end
  ) {
    throw new Error('Invalid fixture reference range')
  }
  if (length > definitions.size) throw new Error('Fixture reference not found')
  const candidates = Array.from(
    { length },
    (_, offset) => `${range[1]}${start + offset}`,
  )
  if (candidates.some((name) => !definitions.has(name))) {
    throw new Error('Fixture reference not found')
  }
  return `@${pick(candidates)}`
}

function pick<T>(values: T[]) {
  return values[Math.floor(Math.random() * values.length)]!
}

function orderFixtures(fixtures: PreparedFixture[]) {
  const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]))
  const state = new Map<string, 'visiting' | 'visited'>()
  const ordered: PreparedFixture[] = []

  const visit = (fixture: PreparedFixture) => {
    if (state.get(fixture.name) === 'visiting') {
      throw new Error('Fixture dependency cycle')
    }
    if (state.get(fixture.name) === 'visited') return
    state.set(fixture.name, 'visiting')
    fixture.dependencies.forEach((name) => visit(byName.get(name)!))
    state.set(fixture.name, 'visited')
    ordered.push(fixture)
  }
  fixtures.forEach(visit)
  return ordered
}

export function resolveFixtureReferences(
  value: unknown,
  records: Record<string, Record<string, unknown>>,
): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('@@')) return value.slice(1)
    if (!value.startsWith('@')) return value
    const match = value.match(FIXED_REFERENCE)
    if (!match) throw new Error('Invalid fixture reference')
    const [, name, field] = match
    const record = records[name!]
    if (!record) throw new Error('Fixture reference was not loaded')
    if (!field) return record
    if (DANGEROUS_KEYS.has(field)) throw new Error('Unsafe reference field')
    if (!Object.hasOwn(record, field) || record[field] === undefined) {
      throw new Error(
        'Referenced fixture field is missing from the loaded record',
      )
    }
    return record[field]
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveFixtureReferences(item, records))
  }
  if (isFixtureRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveFixtureReferences(item, records),
      ]),
    )
  }
  return value
}

export function applyFixtureConnections(
  data: Record<string, unknown>,
  connectedFields: string[] | undefined,
) {
  if (!connectedFields?.length) return data
  const connected = { ...data }
  for (const field of connectedFields) {
    if (!Object.hasOwn(connected, field) || connected[field] == null) continue
    const value = connected[field]
    connected[field] = {
      connect: Array.isArray(value)
        ? value.map((record) => connectionId(record))
        : connectionId(value),
    }
  }
  return connected
}

function connectionId(value: unknown) {
  if (
    !isFixtureRecord(value) ||
    !Object.hasOwn(value, 'id') ||
    value.id === undefined
  ) {
    throw new Error('Connected fixture record is missing id')
  }
  return { id: value.id }
}
