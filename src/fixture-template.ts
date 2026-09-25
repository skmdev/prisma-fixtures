import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import ejs from 'ejs'

import {
  appendFixturePath,
  createFixtureError,
  wrapFixtureError,
} from './fixture-error'
import {
  assertSafeFixtureValue,
  DANGEROUS_KEYS,
  type FixtureDefinition,
  fixtureErrorContext,
  isFixtureRecord,
} from './fixture-document'

export type FixtureProcessor = {
  preProcess?: (
    name: string,
    data: Record<string, unknown>,
  ) => unknown | Promise<unknown>
}

export type ProcessorConstructor = new () => FixtureProcessor

type FakerInstance = Record<string, unknown>
type FixtureRandomizer = {
  next(): number
  seed(value: number | number[]): void
}

const requireProcessor = createRequire(__filename)
const PROCESSOR_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']

export async function renderFixtureTemplates(
  fixture: FixtureDefinition,
  randomizer: FixtureRandomizer,
  refDate?: string,
): Promise<Record<string, unknown>> {
  const fakerModule = await import('@faker-js/faker')
  let locale = fakerModule.en
  if (fixture.locale) {
    if (!Object.hasOwn(fakerModule.allLocales, fixture.locale)) {
      throw createFixtureError(
        'FIXTURE_TEMPLATE_FAILED',
        'Unknown Faker locale',
        fixtureErrorContext(fixture, 'rendering templates'),
      )
    }
    locale =
      fakerModule.allLocales[
        fixture.locale as keyof typeof fakerModule.allLocales
      ]
  }
  const generator = new fakerModule.Faker({
    locale: locale === fakerModule.en ? [locale] : [locale, fakerModule.en],
    randomizer,
  }) as unknown as FakerInstance & {
    setDefaultRefDate(value: string): void
  }
  if (refDate !== undefined) generator.setDefaultRefDate(refDate)

  const data = renderValue(fixture.data, fixture, generator, '')
  if (!isFixtureRecord(data)) {
    throw createFixtureError(
      'FIXTURE_TEMPLATE_FAILED',
      'Fixture template produced invalid data',
      fixtureErrorContext(fixture, 'rendering templates'),
    )
  }
  try {
    assertSafeFixtureValue(data)
  } catch (error) {
    throw wrapFixtureError(
      error,
      'FIXTURE_TEMPLATE_FAILED',
      'Fixture template produced invalid data',
      fixtureErrorContext(fixture, 'rendering templates'),
    )
  }
  return data
}

export async function createFixtureRandomizer(
  seed?: number,
): Promise<FixtureRandomizer> {
  const { generateMersenne53Randomizer } = await import('@faker-js/faker')
  return generateMersenne53Randomizer(seed)
}

function renderValue(
  value: unknown,
  fixture: FixtureDefinition,
  faker: FakerInstance,
  path: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      renderValue(item, fixture, faker, appendFixturePath(path, index)),
    )
  }
  if (isFixtureRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderValue(item, fixture, faker, appendFixturePath(path, key)),
      ]),
    )
  }
  if (typeof value !== 'string') return value

  try {
    const template = value.includes('<%') ? ejs.render(value, fixture) : value
    const providerPattern = /\{\{([\s\S]*?)\}\}/g
    const providers = [...template.matchAll(providerPattern)]
    const singleProvider =
      providers.length === 1 && providers[0]![0].length === template.length
        ? providers[0]
        : undefined
    const generated = singleProvider
      ? fakeValue(singleProvider[1]!, faker)
      : template.replace(providerPattern, (_token, provider: string) =>
          String(fakeValue(provider, faker)),
        )
    if (typeof generated !== 'string') {
      assertSafeFixtureValue(generated)
      return generated
    }
    return generated.replace(/<\{(.*?)\}>/g, (_token, key: string) =>
      String(parameterValue(fixture.parameters, key) ?? ''),
    )
  } catch (error) {
    throw wrapFixtureError(
      error,
      'FIXTURE_TEMPLATE_FAILED',
      'Fixture template failed',
      fixtureErrorContext(fixture, 'rendering templates', path),
    )
  }
}

function fakeValue(expression: string, faker: FakerInstance): unknown {
  const match = expression.trim().match(/^(\w+)\.(\w+)(?:\(([\s\S]*)\))?$/)
  if (!match) throw new Error('Invalid Faker provider')
  let [, group, method] = match
  const argument = match[3]
  ;[group, method] = modernProvider(group!, method!)
  if (DANGEROUS_KEYS.has(group) || DANGEROUS_KEYS.has(method)) {
    throw new Error('Invalid Faker provider')
  }
  const providerGroup = faker[group]
  if (providerGroup === null || typeof providerGroup !== 'object') {
    throw new Error('Unknown Faker provider')
  }
  const provider = (providerGroup as Record<string, unknown>)[method]
  if (typeof provider !== 'function') throw new Error('Unknown Faker provider')
  if (argument === undefined || !argument.trim())
    return provider.call(providerGroup)

  let parameter: unknown = argument
  try {
    parameter = JSON.parse(argument)
  } catch {
    // The upstream syntax accepts a plain string as the single provider argument.
  }
  if (group === 'date' && method === 'past' && typeof parameter === 'number') {
    parameter = { years: parameter }
  }
  return provider.call(providerGroup, parameter)
}

function modernProvider(group: string, method: string): [string, string] {
  if (group === 'name')
    return ['person', method === 'title' ? 'jobTitle' : method]
  if (group === 'address') return ['location', method]
  if (group === 'internet' && method === 'userName') return [group, 'username']
  if (group === 'random' && method === 'number') return ['number', 'int']
  if (group === 'random' && method === 'alphaNumeric')
    return ['string', 'alphanumeric']
  if (group === 'random' && method === 'arrayElement')
    return ['helpers', 'arrayElement']
  if (group === 'random' && method === 'word') return ['word', 'sample']
  if (group === 'datatype' && method === 'number') return ['number', 'int']
  if (group === 'datatype' && method === 'float') return ['number', 'float']
  if (group === 'datatype' && method === 'datetime') return ['date', 'anytime']
  if (group === 'datatype' && method === 'string') return ['string', 'sample']
  return [group, method]
}

function parameterValue(
  parameters: Record<string, unknown>,
  key: string,
): unknown {
  const parts = key.split('.')
  if (parts.some((part) => DANGEROUS_KEYS.has(part))) {
    throw createFixtureError(
      'FIXTURE_TEMPLATE_FAILED',
      'Unknown fixture parameter',
      { stage: 'rendering templates' },
    )
  }
  let value: unknown = parameters
  let found = true
  for (const part of parts) {
    if (!isFixtureRecord(value) || !Object.hasOwn(value, part)) {
      found = false
      break
    }
    value = value[part]
  }
  if (found && value !== undefined) return value

  if (parts.length === 3 && parts[0] === 'process' && parts[1] === 'env') {
    const variable = parts[2]!
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      const environmentValue = process.env[variable]
      if (environmentValue !== undefined) return environmentValue
    }
  }
  throw createFixtureError(
    'FIXTURE_TEMPLATE_FAILED',
    'Unknown fixture parameter',
    { stage: 'rendering templates' },
  )
}

export async function loadFixtureProcessor(
  processorPath: string,
): Promise<ProcessorConstructor> {
  const resolvedPath = resolveProcessorPath(processorPath)
  let loaded: unknown
  try {
    loaded = requireProcessor(resolvedPath)
  } catch (error) {
    if (!requiresNativeImport(error)) throw error
    loaded = await import(pathToFileURL(resolvedPath).href)
  }

  let constructor = loaded
  for (let depth = 0; depth < 2 && isFixtureRecord(constructor); depth += 1) {
    if (!Object.hasOwn(constructor, 'default')) break
    constructor = constructor.default
  }
  if (typeof constructor !== 'function') {
    throw new Error('Fixture processor must export a default class')
  }
  return constructor as ProcessorConstructor
}

function requiresNativeImport(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false
  }
  const code = (error as { code?: unknown }).code
  return code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE'
}

function resolveProcessorPath(processorPath: string): string {
  if (path.extname(processorPath)) return processorPath
  try {
    return requireProcessor.resolve(processorPath)
  } catch {
    for (const extension of PROCESSOR_EXTENSIONS) {
      const candidate = `${processorPath}${extension}`
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // Continue through the bounded extension list.
      }
    }
  }
  throw new Error('Fixture processor module not found')
}

export async function runFixtureProcessor(
  constructor: ProcessorConstructor | undefined,
  fixture: FixtureDefinition,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let result: unknown = data
  try {
    if (constructor) {
      const processor = new constructor()
      if (processor.preProcess !== undefined) {
        if (typeof processor.preProcess !== 'function') {
          throw new Error('Invalid fixture processor hook')
        }
        result = await processor.preProcess(fixture.name, data)
      }
    }
  } catch (error) {
    throw wrapFixtureError(
      error,
      'FIXTURE_PROCESSOR_FAILED',
      'Fixture processor failed',
      fixtureErrorContext(fixture, 'processing fixture'),
    )
  }
  if (!isFixtureRecord(result)) {
    throw createFixtureError(
      'FIXTURE_PROCESSOR_FAILED',
      'Fixture processor returned invalid data',
      fixtureErrorContext(fixture, 'processing fixture'),
    )
  }
  try {
    assertSafeFixtureValue(result)
  } catch (error) {
    throw wrapFixtureError(
      error,
      'FIXTURE_PROCESSOR_FAILED',
      'Fixture processor returned invalid data',
      fixtureErrorContext(fixture, 'processing fixture'),
    )
  }
  return result
}
