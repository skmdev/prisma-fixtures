import { isFixtureRecord } from './fixture-document'
import { normalizeCleanupOptions } from './cleanup-options'

type Data = Record<string, unknown>
type Model = {
  fields?: Record<
    string,
    { many?: boolean; type: { kind: string; codecId?: string } }
  >
  storage?: {
    namespaceId: string
    table: string
    fields: Record<string, { column: string }>
  }
  relations: Record<string, { to: { namespace: string; model: string } }>
}
type Contract = {
  domain: { namespaces: Record<string, { models: Record<string, Model> }> }
  storage?: {
    namespaces?: Record<
      string,
      { entries?: { table?: Record<string, { control?: string }> } }
    >
  }
}
type Delegate = {
  create(data: Data): Promise<unknown>
  where(where: Data): { update(data: Data): Promise<unknown> }
}
type Runtime = { execute(plan: unknown): Promise<unknown> }
type Transaction = Runtime & { orm: Record<string, Record<string, Delegate>> }
type Database = {
  contract: Contract
  orm: Transaction['orm']
  context: {
    contractCodecs: {
      forColumn(
        namespace: string,
        table: string,
        column: string,
      ): { decodeJson(value: unknown): unknown } | undefined
    }
  }
  raw: {
    sql(strings: TemplateStringsArray): {
      affectedCount(): { build(): unknown }
    }
  }
  runtime(): Runtime
  transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T>
  close(): Promise<void>
}

// Internal cleanup metadata follows the adapted client and each transaction.
export const prisma8PreservedTables = new WeakMap<object, string[]>()

export function contractPreservedTables(value: unknown): string[] {
  const contract = value as Contract
  const names: string[] = []
  for (const [namespace, entry] of Object.entries(
    contract.storage?.namespaces ?? {},
  )) {
    for (const [table, metadata] of Object.entries(
      entry.entries?.table ?? {},
    )) {
      if (metadata.control !== undefined && metadata.control !== 'managed')
        names.push(`${namespace}.${table}`)
    }
  }
  return normalizeCleanupOptions({ preserveTables: names }).preserveTables ?? []
}

/** Bridge a native Prisma 8 PostgreSQL client to the fixture API. Requires PostgreSQL 17+. */
export function createPrisma8FixtureClient(client: object) {
  const db = client as Database
  if (
    !db ||
    !isFixtureRecord(db.contract?.domain?.namespaces) ||
    !isFixtureRecord(db.orm) ||
    typeof db.transaction !== 'function' ||
    typeof db.close !== 'function' ||
    typeof db.runtime !== 'function' ||
    typeof db.raw?.sql !== 'function'
  ) {
    throw new Error('Expected a Prisma 8 PostgreSQL client')
  }
  const namespaces = db.contract.domain.namespaces
  const preserveTables = contractPreservedTables(db.contract)
  const aliases = new Map<string, { namespace: string; name: string } | null>()
  for (const [namespace, entry] of Object.entries(namespaces)) {
    for (const name of Object.keys(entry.models)) {
      for (const alias of new Set([
        `${namespace}.${name}`,
        name,
        name[0].toLowerCase() + name.slice(1),
      ])) {
        aliases.set(alias, aliases.has(alias) ? null : { namespace, name })
      }
    }
  }
  const plan = (sql: string) =>
    db.raw
      .sql(Object.assign([sql], { raw: [sql] }))
      .affectedCount()
      .build()

  function scalarValue(model: Model, field: string, value: unknown): unknown {
    const metadata = model.fields?.[field]
    const codecId = metadata?.type.codecId
    if (
      metadata?.type.kind !== 'scalar' ||
      !codecId ||
      !/^pg\/(?:int8|unboundedint|int8number|numeric|bytea|interval|(?:date|timestamp|timestamptz|time)-temporal|timestamptz-date)@1$/.test(
        codecId,
      )
    )
      return value
    const decode = (item: unknown) => {
      // Native objects returned by processors/references already have the runtime type.
      if (typeof item !== 'string' && typeof item !== 'number') return item
      if (typeof item === 'number') {
        if (codecId === 'pg/int8number@1') return item
        if (!/^pg\/(?:int8|unboundedint|numeric)@1$/.test(codecId)) return item
        if (
          !Number.isFinite(item) ||
          (codecId !== 'pg/numeric@1' && !Number.isSafeInteger(item))
        )
          throw new Error('Invalid numeric fixture value')
        item = String(item)
      }
      const storage = model.storage
      const column = storage?.fields[field]?.column
      const codec =
        storage && column
          ? db.context.contractCodecs.forColumn(
              storage.namespaceId,
              storage.table,
              column,
            )
          : undefined
      if (!codec) throw new Error('Prisma 8 fixture column codec not found')
      return codec.decodeJson(item)
    }
    return metadata.many && Array.isArray(value)
      ? value.map(decode)
      : decode(value)
  }

  function relationData(data: Data, model: Model): Data {
    return Object.fromEntries(
      Object.entries(data).map(([field, value]) => {
        const relation = model.relations[field]
        if (!relation) return [field, scalarValue(model, field, value)]
        if (
          !isFixtureRecord(value) ||
          Object.keys(value).length !== 1 ||
          (!Object.hasOwn(value, 'connect') && !Object.hasOwn(value, 'create'))
        ) {
          throw new Error(
            'Prisma 8 fixture relations require connect or create',
          )
        }
        const target =
          namespaces[relation.to.namespace].models[relation.to.model]
        const operation = Object.hasOwn(value, 'connect') ? 'connect' : 'create'
        const map = (item: unknown) => {
          if (!isFixtureRecord(item))
            throw new Error('Invalid fixture relation data')
          return relationData(item, target)
        }
        const input = value[operation]
        const mapped = Array.isArray(input) ? input.map(map) : map(input)
        return [
          field,
          (mutator: {
            connect(value: unknown): unknown
            create(value: unknown): unknown
          }) => mutator[operation](mapped),
        ]
      }),
    )
  }

  function adapt(orm: Database['orm'], runtime: Runtime, check = () => {}) {
    const delegates: Record<
      string,
      {
        create(args: { data: Data }): Promise<unknown>
        update(args: { where: Data; data: Data }): Promise<unknown>
      }
    > = Object.create(null)
    const byModel = new Map<string, (typeof delegates)[string]>()
    for (const [alias, model] of aliases) {
      if (!model) continue
      const { namespace, name } = model
      const qualified = `${namespace}.${name}`
      let delegate = byModel.get(qualified)
      if (!delegate) {
        const metadata = namespaces[namespace].models[name]
        delegate = {
          async create({ data }) {
            check()
            return orm[namespace][name].create(relationData(data, metadata))
          },
          async update({ where, data }) {
            check()
            return orm[namespace][name]
              .where(relationData(where, metadata))
              .update(relationData(data, metadata))
          },
        }
        byModel.set(qualified, delegate)
      }
      delegates[alias] = delegate
    }
    const adapted = Object.assign(delegates, {
      async $executeRawUnsafe(sql: string) {
        check()
        return runtime.execute(plan(sql))
      },
    })
    prisma8PreservedTables.set(adapted, preserveTables)
    return adapted
  }

  return Object.assign(adapt(db.orm, db.runtime()), {
    $disconnect: () => db.close(),
    async $transaction<T>(
      action: (tx: object) => Promise<T>,
      { timeout = 60_000 } = {},
    ): Promise<T> {
      if (
        !Number.isSafeInteger(timeout) ||
        timeout <= 0 ||
        timeout > 2_147_483_647
      )
        throw new Error('Invalid transaction timeout')
      return db.transaction(async (tx) => {
        // PostgreSQL rejects this setting before any fixtures on versions older than 17.
        // The database deadline also cancels in-flight queries and rolls back idle callbacks.
        await tx.execute(plan(`SET LOCAL transaction_timeout = '${timeout}ms'`))
        const deadline = Date.now() + timeout
        let closed = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const check = () => {
          if (closed || Date.now() >= deadline)
            throw new Error('Fixture transaction closed or timed out')
        }
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => action(adapt(tx.orm, tx, check))),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                closed = true
                reject(new Error('Fixture transaction timed out'))
              }, timeout)
            }),
          ])
          check()
          return result
        } finally {
          closed = true
          clearTimeout(timer)
        }
      })
    },
  })
}
