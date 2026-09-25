import {
  assertFixtureDefinition,
  type FixtureDefinition,
  fixtureErrorContext,
  inheritFixtureSource,
  isFixtureRecord,
  MAX_FIXTURE_DEFINITIONS,
  readFixtureDocuments,
  readFixturePaths,
} from './fixture-document'
import {
  applyFixtureConnections,
  prepareFixtureReferences,
  resolveFixtureReferences,
} from './fixture-reference'
import {
  createFixtureRandomizer,
  loadFixtureProcessor,
  type ProcessorConstructor,
  renderFixtureTemplates,
  runFixtureProcessor,
} from './fixture-template'
import {
  type FixtureCleanupOptions,
  normalizeCleanupOptions,
} from './cleanup-options'
import {
  type FixtureLoadOptions,
  type FixtureResetOptions,
  normalizeLoadOptions,
  normalizeResetOptions,
} from './load-options'
import { createFixtureError, wrapFixtureError } from './fixture-error'
import { readFixtureConfig } from './fixture-config'

export type { FixtureDefinition } from './fixture-document'
export { FixtureError } from './fixture-error'
export type { FixtureErrorCode, FixtureErrorContext } from './fixture-error'
export type { FixtureProcessor } from './fixture-template'
export type {
  FixtureCleanupOptions,
  FixturePreservedTable,
} from './cleanup-options'
export type { FixtureLoadOptions, FixtureResetOptions } from './load-options'

export const readFixtureDefinitions = readFixtureDocuments

export class PrismaFixtures {
  async load(client: object): Promise<Record<string, Record<string, unknown>>> {
    const config = readFixtureConfig()
    if (!config.fixtures) {
      throw new Error('Fixture config must define fixtures')
    }
    if (typeof config.client === 'object' && config.client.guard) {
      throw new Error('Guarded fixture config requires the CLI')
    }
    const definitions = readFixturePaths(config.fixtures)
    const transaction = (client as { $transaction?: unknown })?.$transaction
    if (typeof transaction !== 'function') {
      throw new Error('The client must implement $transaction')
    }
    return transaction.call(
      client,
      (tx: object) =>
        loadFixtures(tx, definitions, {
          seed: config.seed,
          refDate: config.refDate,
        }),
      { timeout: config.timeout ?? 60_000 },
    ) as Promise<Record<string, Record<string, unknown>>>
  }
}

export type FixtureWriter = (
  fixture: FixtureDefinition,
  data: Record<string, unknown>,
) => Promise<unknown>

type CreateDelegate = {
  create: (args: { data: Record<string, unknown> }) => Promise<unknown>
  update?: (args: {
    where: { id: unknown }
    data: Record<string, unknown>
  }) => Promise<unknown>
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
): Promise<Record<string, Record<string, unknown>>>
export function loadFixtures(
  client: object,
  definitions: FixtureDefinition[],
  options?: FixtureLoadOptions,
  write?: FixtureWriter,
): Promise<Record<string, Record<string, unknown>>>
export async function loadFixtures(
  client: object,
  definitions: FixtureDefinition[],
  optionsOrWrite?: FixtureLoadOptions | FixtureWriter,
  finalWrite?: FixtureWriter,
): Promise<Record<string, Record<string, unknown>>> {
  if (typeof optionsOrWrite === 'function' && finalWrite !== undefined) {
    throw new Error('Invalid fixture loader arguments')
  }
  const options = normalizeLoadOptions(
    typeof optionsOrWrite === 'function' ? undefined : optionsOrWrite,
  )
  const write =
    typeof optionsOrWrite === 'function' ? optionsOrWrite : finalWrite
  const fixtures = await prepareFixtures(client, definitions, write, options)

  return writeFixtures(fixtures, write)
}

export async function cleanFixtures(
  client: object,
  options?: FixtureCleanupOptions,
): Promise<void> {
  const { preserveTables = [] } = normalizeCleanupOptions(options)
  if (
    client === null ||
    (typeof client !== 'object' && typeof client !== 'function')
  ) {
    throw new Error('Invalid fixture cleaner arguments')
  }
  const execute = (client as { $executeRawUnsafe?: unknown }).$executeRawUnsafe
  if (typeof execute !== 'function') {
    throw new Error('Fixture cleaner requires $executeRawUnsafe')
  }
  const preservedHex = Buffer.from(
    JSON.stringify(
      preserveTables.map((name) => {
        const [schema, table] = name.split('.')
        return { schema, table }
      }),
    ),
  ).toString('hex')

  // PostgreSQL only: config is hex data; catalog identifiers are quoted by PostgreSQL.
  await execute.call(
    client,
    `DO $$
DECLARE
  tables text;
  preserved jsonb := convert_from(decode('${preservedHex}', 'hex'), 'UTF8')::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(preserved) AS requested("schema" text, "table" text)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS candidate
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = candidate.relnamespace
      WHERE namespace.nspname = requested."schema"
        AND candidate.relname = requested."table"
        AND candidate.relkind IN ('r', 'p')
    )
  ) THEN
    RAISE EXCEPTION 'Fixture cleanup preserve table not found';
  END IF;

  -- TRUNCATE follows inheritance; reject every cleanup/exclusion boundary.
  IF EXISTS (
    WITH cleanup_tables AS (
      SELECT candidate.oid
      FROM pg_catalog.pg_class AS candidate
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = candidate.relnamespace
      WHERE candidate.relkind IN ('r', 'p')
        AND namespace.nspname <> 'information_schema'
        AND namespace.nspname !~ '^pg_'
        AND candidate.relname <> '_prisma_migrations'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_to_recordset(preserved) AS requested("schema" text, "table" text)
          WHERE requested."schema" = namespace.nspname
            AND requested."table" = candidate.relname
        )
    )
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE
      EXISTS (
        SELECT 1 FROM cleanup_tables WHERE cleanup_tables.oid = inheritance.inhparent
      ) <>
      EXISTS (
        SELECT 1 FROM cleanup_tables WHERE cleanup_tables.oid = inheritance.inhrelid
      )
  ) THEN
    RAISE EXCEPTION 'Fixture cleanup cannot truncate excluded descendant tables';
  END IF;

  SELECT string_agg(
    format('%I.%I', schemaname, tablename),
    ', ' ORDER BY schemaname, tablename
  )
  INTO tables
  FROM pg_catalog.pg_tables
  WHERE schemaname <> 'information_schema'
    AND schemaname !~ '^pg_'
    AND tablename <> '_prisma_migrations'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(preserved) AS requested("schema" text, "table" text)
      WHERE requested."schema" = schemaname
        AND requested."table" = tablename
    );

  IF tables IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || tables || ' CONTINUE IDENTITY RESTRICT';
  END IF;
END
$$;`,
  )
}

export function resetFixtures(
  client: object,
  definitions: FixtureDefinition[],
  write?: FixtureWriter,
): Promise<Record<string, Record<string, unknown>>>
export function resetFixtures(
  client: object,
  definitions: FixtureDefinition[],
  options?: FixtureResetOptions,
  write?: FixtureWriter,
): Promise<Record<string, Record<string, unknown>>>
export async function resetFixtures(
  client: object,
  definitions: FixtureDefinition[],
  optionsOrWrite?: FixtureResetOptions | FixtureWriter,
  finalWrite?: FixtureWriter,
): Promise<Record<string, Record<string, unknown>>> {
  if (typeof optionsOrWrite === 'function' && finalWrite !== undefined) {
    throw new Error('Invalid fixture loader arguments')
  }
  const options = normalizeResetOptions(
    typeof optionsOrWrite === 'function' ? undefined : optionsOrWrite,
  )
  const write =
    typeof optionsOrWrite === 'function' ? optionsOrWrite : finalWrite
  const fixtures = await prepareFixtures(
    client,
    definitions,
    write,
    options.load,
  )
  await cleanFixtures(client, options.cleanup)
  return writeFixtures(fixtures, write)
}

async function writeFixtures(
  fixtures: RuntimeFixture[],
  write: FixtureWriter | undefined,
) {
  const records: Record<string, Record<string, unknown>> = Object.create(null)
  const deferredUpdates: {
    fixture: FixtureDefinition
    delegate: CreateDelegate
    id: unknown
    data: Record<string, unknown>
  }[] = []

  for (const { fixture, delegate, processor } of fixtures) {
    const resolved = resolveFixtureReferences(fixture.data, records, fixture)
    if (!isFixtureRecord(resolved)) throw new Error('Invalid fixture data')
    const processed = await runFixtureProcessor(processor, fixture, resolved)
    const data = applyFixtureConnections(
      processed,
      fixture.connectedFields,
      fixture,
    )
    const deferred = Object.fromEntries(
      (fixture.deferredFields ?? []).map((field) => [field, data[field]]),
    )
    const createData = { ...data }
    for (const field of fixture.deferredFields ?? []) delete createData[field]
    let saved: unknown
    try {
      saved = write
        ? await write(fixture, data)
        : await delegate!.create({ data: createData })
    } catch (error) {
      throw wrapFixtureError(
        error,
        'FIXTURE_WRITE_FAILED',
        'Fixture persistence failed',
        fixtureErrorContext(fixture, 'writing fixture'),
      )
    }
    if (!isFixtureRecord(saved)) {
      throw createFixtureError(
        'FIXTURE_WRITE_FAILED',
        'Fixture writer returned an invalid record',
        fixtureErrorContext(fixture, 'writing fixture'),
      )
    }
    records[fixture.name] = saved
    if (fixture.deferredFields?.length) {
      if (saved.id === undefined) {
        throw createFixtureError(
          'FIXTURE_WRITE_FAILED',
          'Deferred fixture update requires a saved id',
          fixtureErrorContext(fixture, 'writing fixture'),
        )
      }
      deferredUpdates.push({
        fixture,
        delegate: delegate!,
        id: saved.id,
        data: deferred,
      })
    }
  }

  for (const { fixture, delegate, id, data } of deferredUpdates) {
    try {
      const saved = await delegate.update!({ where: { id }, data })
      if (!isFixtureRecord(saved)) throw new Error('Invalid updated record')
      records[fixture.name] = saved
    } catch (error) {
      throw wrapFixtureError(
        error,
        'FIXTURE_WRITE_FAILED',
        'Fixture persistence failed',
        fixtureErrorContext(fixture, 'updating fixture'),
      )
    }
  }

  return records
}

async function prepareFixtures(
  client: object,
  definitions: FixtureDefinition[],
  write: FixtureWriter | undefined,
  options: FixtureLoadOptions,
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

  const runtime = new Map<string, Omit<RuntimeFixture, 'fixture'>>()
  for (const fixture of definitions) {
    const delegate = write ? undefined : resolveDelegate(client, fixture.entity)
    if (fixture.deferredFields?.length && (write || !delegate?.update)) {
      throw new Error('Deferred fields require a client update delegate')
    }

    let processor: ProcessorConstructor | undefined
    if (fixture.processor) {
      try {
        processor = await loadFixtureProcessor(fixture.processor)
      } catch (error) {
        throw wrapFixtureError(
          error,
          'FIXTURE_PROCESSOR_FAILED',
          'Fixture processor could not be loaded',
          fixtureErrorContext(fixture, 'loading processor'),
        )
      }
    }
    runtime.set(fixture.name, {
      delegate,
      ...(processor ? { processor } : {}),
    })
  }

  const randomizer = await createFixtureRandomizer(options.seed)
  const rendered: FixtureDefinition[] = []
  for (const fixture of definitions) {
    const result = {
      ...fixture,
      data: await renderFixtureTemplates(fixture, randomizer, options.refDate),
    }
    inheritFixtureSource(fixture, result)
    rendered.push(result)
  }
  return prepareFixtureReferences(rendered, randomizer).map((fixture) => ({
    fixture,
    ...runtime.get(fixture.name)!,
  }))
}

function resolveDelegate(client: object, entity: string): CreateDelegate {
  const clientRecord = client as Record<string, unknown>
  const delegateName = entity[0]!.toLowerCase() + entity.slice(1)
  const candidate = clientRecord[entity] ?? clientRecord[delegateName]
  if (
    candidate === null ||
    (typeof candidate !== 'object' && typeof candidate !== 'function') ||
    typeof (candidate as { create?: unknown }).create !== 'function'
  ) {
    throw new Error(`Fixture model delegate not found: ${entity}`)
  }
  return candidate as CreateDelegate
}
