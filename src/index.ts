import {
  assertFixtureDefinition,
  type FixtureDefinition,
  isFixtureRecord,
  MAX_FIXTURE_DEFINITIONS,
  readFixtureDocuments,
} from './fixture-document'
import {
  applyFixtureConnections,
  prepareFixtureReferences,
  resolveFixtureReferences,
} from './fixture-reference'
import {
  loadFixtureProcessor,
  type ProcessorConstructor,
  renderFixtureTemplates,
  runFixtureProcessor,
} from './fixture-template'

export type { FixtureDefinition } from './fixture-document'
export type { FixtureProcessor } from './fixture-template'

export const readFixtureDefinitions = readFixtureDocuments

export type FixtureWriter = (
  fixture: FixtureDefinition,
  data: Record<string, unknown>,
) => Promise<unknown>

type CreateDelegate = {
  create: (args: { data: Record<string, unknown> }) => Promise<unknown>
}

type RuntimeFixture = {
  fixture: FixtureDefinition
  delegate?: CreateDelegate
  processor?: ProcessorConstructor
}

export async function loadFixtures(
  client: object,
  definitions: FixtureDefinition[],
  write?: FixtureWriter,
): Promise<Record<string, Record<string, unknown>>> {
  const fixtures = await prepareFixtures(client, definitions, write)
  const records: Record<string, Record<string, unknown>> = Object.create(null)

  for (const { fixture, delegate, processor } of fixtures) {
    const resolved = resolveFixtureReferences(fixture.data, records)
    if (!isFixtureRecord(resolved)) throw new Error('Invalid fixture data')
    const processed = await runFixtureProcessor(processor, fixture, resolved)
    const data = applyFixtureConnections(processed, fixture.connectedFields)
    const saved = write
      ? await write(fixture, data)
      : await delegate!.create({ data })
    if (!isFixtureRecord(saved)) {
      throw new Error('Fixture writer returned an invalid record')
    }
    records[fixture.name] = saved
  }

  return records
}

async function prepareFixtures(
  client: object,
  definitions: FixtureDefinition[],
  write: FixtureWriter | undefined,
): Promise<RuntimeFixture[]> {
  if (
    client === null ||
    (typeof client !== 'object' && typeof client !== 'function') ||
    (write !== undefined && typeof write !== 'function')
  ) {
    throw new Error('Invalid fixture loader arguments')
  }
  if (
    !Array.isArray(definitions) ||
    definitions.length > MAX_FIXTURE_DEFINITIONS
  ) {
    throw new Error('Invalid fixture definitions')
  }

  const names = new Set<string>()
  for (const definition of definitions) {
    assertFixtureDefinition(definition)
    if (names.has(definition.name)) throw new Error('Duplicate fixture name')
    names.add(definition.name)
  }

  const clientRecord = client as Record<string, unknown>
  const runtime = new Map<
    string,
    { delegate?: CreateDelegate; processor?: ProcessorConstructor }
  >()
  for (const fixture of definitions) {
    let delegate: CreateDelegate | undefined
    if (!write) {
      const candidate =
        clientRecord[fixture.entity] ??
        clientRecord[uncapitalize(fixture.entity)]
      if (
        candidate === null ||
        (typeof candidate !== 'object' && typeof candidate !== 'function') ||
        typeof (candidate as { create?: unknown }).create !== 'function'
      ) {
        throw new Error(`Fixture model delegate not found: ${fixture.entity}`)
      }
      delegate = candidate as CreateDelegate
    }

    runtime.set(fixture.name, {
      delegate,
      ...(fixture.processor
        ? { processor: await loadFixtureProcessor(fixture.processor) }
        : {}),
    })
  }

  const rendered: FixtureDefinition[] = []
  for (const fixture of definitions) {
    rendered.push({ ...fixture, data: await renderFixtureTemplates(fixture) })
  }
  return prepareFixtureReferences(rendered).map((fixture) => ({
    fixture,
    ...runtime.get(fixture.name)!,
  }))
}

function uncapitalize(value: string) {
  return value[0]!.toLowerCase() + value.slice(1)
}
