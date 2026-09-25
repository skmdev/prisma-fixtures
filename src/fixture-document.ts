import fs from 'node:fs'
import path from 'node:path'

import { LineCounter, parseDocument } from 'yaml'
import {
  FixtureError,
  markFixtureErrorTrusted,
  type FixtureErrorContext,
} from './fixture-error'

// Only messages constructed here are safe to display as lint diagnostics.
export class FixtureDocumentError extends FixtureError {
  constructor(
    message: string,
    context: Partial<FixtureErrorContext> = {},
    cause?: unknown,
  ) {
    super(
      'FIXTURE_DOCUMENT_INVALID',
      message,
      { stage: 'reading fixtures', ...context },
      cause,
    )
    this.name = 'FixtureDocumentError'
    markFixtureErrorTrusted(this)
  }
}

export type FixtureDefinition = {
  name: string
  entity: string
  data: Record<string, unknown>
  parameters: Record<string, unknown>
  processor?: string
  locale?: string
  connectedFields?: string[]
  deferredFields?: string[]
}

const fixtureSources = new WeakMap<FixtureDefinition, { file: string }>()

export function fixtureErrorContext(
  fixture: FixtureDefinition | undefined,
  stage: string,
  path?: string,
): FixtureErrorContext {
  if (!fixture) return { stage, path }
  return {
    stage,
    file: fixtureSources.get(fixture)?.file,
    fixtureName: fixture.name,
    entity: fixture.entity,
    ...(path === undefined ? {} : { path }),
  }
}

export function inheritFixtureSource(
  source: FixtureDefinition,
  target: FixtureDefinition,
): void {
  const provenance = fixtureSources.get(source)
  if (provenance) fixtureSources.set(target, provenance)
}

const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 100
export const MAX_FIXTURE_DEFINITIONS = 2000
const MAX_DEPTH = 32
const MAX_NODES = 50_000
export const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/
const RANGE_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*)\{(\d+)\.\.(\d+)\}$/
const CURRENT_PATTERN = /\(\$current(?:([+\-*/])(\d+))?\)/g

export function readFixturePaths(
  targets: string[],
  validateDocument?: (value: unknown, file: string) => void,
): FixtureDefinition[] {
  const definitions = targets.flatMap((target) =>
    readFixtureDocuments(path.resolve(target), validateDocument),
  )
  if (
    new Set(definitions.map(({ name }) => name)).size !== definitions.length
  ) {
    throw new FixtureDocumentError('Duplicate fixture name across paths')
  }
  return definitions
}

export function readFixtureDocuments(
  targetPath: string,
  validateDocument?: (value: unknown, file: string) => void,
): FixtureDefinition[] {
  const definitions: FixtureDefinition[] = []
  for (const file of collectFiles(targetPath)) {
    const document = readDocument(file)
    const normalized = normalizeDocument(
      document,
      file,
      MAX_FIXTURE_DEFINITIONS - definitions.length,
    )
    validateDocument?.(document, file)
    definitions.push(...normalized)
  }

  const names = new Set<string>()
  for (const { name } of definitions) {
    if (names.has(name))
      throw new FixtureDocumentError('Duplicate fixture name', {
        fixtureName: name,
      })
    names.add(name)
  }
  return definitions
}

function collectFiles(targetPath: string) {
  let stat: fs.Stats
  try {
    stat = fs.statSync(targetPath)
  } catch {
    throw new FixtureDocumentError(
      `Fixture path not found: ${JSON.stringify(targetPath)}`,
    )
  }

  if (stat.isFile()) {
    if (!/\.(json|ya?ml)$/i.test(targetPath)) {
      throw new FixtureDocumentError(
        'Fixture file must use .json, .yml or .yaml',
      )
    }
    return [targetPath]
  }
  if (!stat.isDirectory())
    throw new FixtureDocumentError('Fixture path is not a file or directory')

  const files = fs
    .readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(json|ya?ml)$/i.test(entry.name))
    .map((entry) => path.join(targetPath, entry.name))
    .sort()
  if (files.length > MAX_FILES)
    throw new FixtureDocumentError('Too many fixture files')
  return files
}

function readDocument(file: string): unknown {
  if (fs.statSync(file).size > MAX_FILE_BYTES) {
    throw new FixtureDocumentError(
      `Fixture file is too large: ${JSON.stringify(path.basename(file))}`,
    )
  }
  const raw = fs.readFileSync(file, 'utf8')

  try {
    const value: unknown = /\.json$/i.test(file)
      ? parseJson(raw)
      : parseYaml(raw)
    assertSafeFixtureValue(value)
    return value
  } catch (error) {
    const detail =
      error instanceof FixtureDocumentError ? ` (${error.message})` : ''
    throw new FixtureDocumentError(
      `Invalid fixture document: ${JSON.stringify(path.basename(file))}${detail}`,
      { file: path.basename(file) },
      error,
    )
  }
}

function parseJson(raw: string): unknown {
  const value: unknown = JSON.parse(raw)
  // JSON.parse keeps JSON scalar semantics but discards duplicate keys; YAML checks
  // the original key structure without replacing the native JSON result.
  parseYaml(raw)
  return value
}

function parseYaml(raw: string): unknown {
  const lineCounter = new LineCounter()
  const document = parseDocument(raw, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  })
  const issue = document.errors[0] ?? document.warnings[0]
  if (issue) {
    const { line, col } = lineCounter.linePos(issue.pos[0])
    throw new FixtureDocumentError(`${issue.code} at ${line}:${col}`)
  }
  return document.toJS({ maxAliasCount: 0 })
}

function normalizeDocument(
  value: unknown,
  file: string,
  remaining: number,
): FixtureDefinition[] {
  if (!isFixtureRecord(value)) throw invalidDocument(file)
  assertKeys(
    value,
    [
      'entity',
      'locale',
      'parameters',
      'processor',
      'connectedFields',
      'deferredFields',
      'items',
    ],
    file,
  )
  const {
    entity,
    locale,
    parameters = {},
    processor,
    connectedFields,
    deferredFields,
    items,
  } = value
  if (!isFixtureRecord(items)) throw invalidDocument(file)
  assertFixtureMetadata({ ...value, parameters }, file)

  const definitions: FixtureDefinition[] = []
  const fixtureProcessor =
    typeof processor === 'string'
      ? path.resolve(path.dirname(file), processor)
      : undefined
  const fixtureConnectedFields = connectedFields as string[] | undefined
  const fixtureDeferredFields = deferredFields as string[] | undefined
  for (const [rawName, rawData] of Object.entries(items)) {
    if (!isFixtureRecord(rawData)) throw invalidDocument(file)
    const expandedNames = expandName(rawName, file)
    if (expandedNames.length > remaining - definitions.length) {
      throw new FixtureDocumentError('Too many fixture definitions')
    }
    for (const { name, current } of expandedNames) {
      const definition: unknown = {
        name,
        entity,
        data: replaceCurrent(rawData, current, file),
        parameters: structuredClone(parameters),
        ...(fixtureProcessor === undefined
          ? {}
          : { processor: fixtureProcessor }),
        ...(locale === undefined ? {} : { locale }),
        ...(fixtureConnectedFields === undefined
          ? {}
          : { connectedFields: [...fixtureConnectedFields] }),
        ...(fixtureDeferredFields === undefined
          ? {}
          : { deferredFields: [...fixtureDeferredFields] }),
      }
      try {
        assertFixtureDefinition(definition)
      } catch {
        throw invalidDocument(file)
      }
      fixtureSources.set(definition, { file: path.basename(file) })
      definitions.push(definition)
    }
  }
  return definitions
}

function expandName(rawName: string, file: string) {
  const match = rawName.match(RANGE_PATTERN)
  if (!match) {
    if (!NAME_PATTERN.test(rawName) || DANGEROUS_KEYS.has(rawName)) {
      throw invalidDocument(file)
    }
    const suffix = rawName.match(/(\d+)$/)?.[1]
    return [
      {
        name: rawName,
        current: suffix === undefined ? undefined : Number(suffix),
      },
    ]
  }

  const start = Number(match[2])
  const end = Number(match[3])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    end - start + 1 > MAX_FIXTURE_DEFINITIONS
  ) {
    throw invalidDocument(file)
  }
  return Array.from({ length: end - start + 1 }, (_, offset) => ({
    name: `${match[1]}${start + offset}`,
    current: start + offset,
  }))
}

function replaceCurrent(
  value: unknown,
  current: number | undefined,
  file: string,
): unknown {
  if (typeof value === 'string') {
    const replaced = value.replace(
      CURRENT_PATTERN,
      (_token, operator, rawOperand) => {
        if (current === undefined) throw invalidDocument(file)
        const operand =
          rawOperand === undefined ? undefined : Number(rawOperand)
        const result = calculateCurrent(current, operator, operand)
        if (!Number.isFinite(result)) throw invalidDocument(file)
        return String(result)
      },
    )
    if (replaced.includes('($current')) throw invalidDocument(file)
    return replaced
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceCurrent(item, current, file))
  }
  if (isFixtureRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceCurrent(item, current, file),
      ]),
    )
  }
  return value
}

function calculateCurrent(
  current: number,
  operator?: string,
  operand?: number,
) {
  if (!operator || operand === undefined) return current
  if (operator === '+') return current + operand
  if (operator === '-') return current - operand
  if (operator === '*') return current * operand
  if (operator === '/') return current / operand
  throw new Error('Invalid current operation')
}

export function assertFixtureDefinition(
  value: unknown,
): asserts value is FixtureDefinition {
  if (!isFixtureRecord(value)) throw new Error('Invalid fixture definition')
  assertKeys(value, [
    'name',
    'entity',
    'data',
    'parameters',
    'processor',
    'locale',
    'connectedFields',
    'deferredFields',
  ])
  const { name, data, deferredFields } = value
  assertFixtureMetadata(value)
  if (
    typeof name !== 'string' ||
    !NAME_PATTERN.test(name) ||
    DANGEROUS_KEYS.has(name) ||
    !isFixtureRecord(data)
  ) {
    throw new Error('Invalid fixture definition')
  }
  if (
    Array.isArray(deferredFields) &&
    deferredFields.some(
      (field: string) => field === 'id' || !Object.hasOwn(data, field),
    )
  ) {
    throw new Error('Invalid deferred fixture field')
  }
  assertSafeFixtureValue(value)
}

function assertFixtureMetadata(
  metadata: Record<string, unknown>,
  file?: string,
) {
  const {
    entity,
    parameters,
    processor,
    locale,
    connectedFields,
    deferredFields,
  } = metadata
  if (
    typeof entity !== 'string' ||
    !NAME_PATTERN.test(entity) ||
    DANGEROUS_KEYS.has(entity) ||
    !isFixtureRecord(parameters) ||
    (processor !== undefined &&
      (typeof processor !== 'string' || !processor)) ||
    (locale !== undefined && (typeof locale !== 'string' || !locale)) ||
    (connectedFields !== undefined && !isFieldList(connectedFields)) ||
    (deferredFields !== undefined &&
      (!isFieldList(deferredFields) ||
        deferredFields.length === 0 ||
        deferredFields.some(
          (field) =>
            Array.isArray(connectedFields) && connectedFields.includes(field),
        )))
  ) {
    throw file ? invalidDocument(file) : new Error('Invalid fixture definition')
  }
}

function isFieldList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (field) =>
        typeof field === 'string' &&
        FIELD_PATTERN.test(field) &&
        !DANGEROUS_KEYS.has(field),
    ) &&
    new Set(value).size === value.length
  )
}

export function isFixtureRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

export function assertSafeFixtureValue(value: unknown) {
  let nodes = 0
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH)
      throw new Error('Fixture data is too deep')
    if (Array.isArray(current))
      return current.forEach((item) => visit(item, depth + 1))
    if (!isFixtureRecord(current)) return
    for (const [key, item] of Object.entries(current)) {
      if (DANGEROUS_KEYS.has(key)) throw new Error('Unsafe fixture key')
      visit(item, depth + 1)
    }
  }
  visit(value, 0)
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: string[],
  file?: string,
) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw file ? invalidDocument(file) : new Error('Invalid fixture definition')
  }
}

function invalidDocument(file: string) {
  return new FixtureDocumentError(
    `Invalid fixture document: ${JSON.stringify(path.basename(file))}`,
    { file: path.basename(file) },
  )
}
