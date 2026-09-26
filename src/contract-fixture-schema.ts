import fs from 'node:fs'
import path from 'node:path'

type JsonSchema = Record<string, unknown>
type FixtureSchema = JsonSchema & {
  properties: Record<string, JsonSchema>
  definitions: Record<string, JsonSchema>
  allOf?: JsonSchema[]
}
type FieldType =
  | { kind: 'scalar'; codecId: string }
  | { kind: 'valueObject'; name: string }
  | { kind: 'union'; members: Exclude<FieldType, { kind: 'union' }>[] }
type Field = {
  nullable: boolean
  many?: true
  dict?: true
  type: FieldType
  valueSet?: {
    plane: 'domain' | 'storage'
    namespaceId: string
    entityKind: 'enum' | 'valueSet'
    entityName: string
  }
}
type Relation = {
  cardinality: '1:1' | 'N:1' | '1:N' | 'N:M'
  nullable?: boolean
  to: { namespace: string; model: string }
  on?: { localFields: string[]; targetFields: string[] }
}
type Model = {
  fields: Record<string, Field>
  relations: Record<string, Relation>
  storage: {
    namespaceId: string
    table: string
    fields: Record<string, { column: string }>
  }
}
type Namespace = {
  models: Record<string, Model>
  valueObjects?: Record<string, { fields: Record<string, Field> }>
  enum?: Record<string, { members: { value: unknown }[] }>
}
type Contract = {
  roots: Record<string, { namespace: string; model: string }>
  execution?: {
    mutations: {
      defaults: {
        ref: { namespace: string; table: string; column: string }
        onCreate?: unknown
      }[]
    }
  }
  domain: { namespaces: Record<string, Namespace> }
  storage: {
    namespaces: Record<
      string,
      {
        entries: {
          table: Record<
            string,
            {
              columns: Record<string, Record<string, unknown>>
              foreignKeys: {
                source: {
                  namespaceId: string
                  tableName: string
                  columns: string[]
                }
                target: {
                  namespaceId: string
                  tableName: string
                  columns: string[]
                }
              }[]
            }
          >
          valueSet?: Record<string, { values: unknown[] }>
        }
      }
    >
  }
}

const baseFixtureSchema = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../schema/fixture.schema.json'),
    'utf8',
  ),
) as FixtureSchema

const dynamicString = (): JsonSchema => ({
  type: 'string',
  pattern: '(?:^@(?!@)|<%|\\{\\{|<\\{|\\(\\$current(?:[+*/-][0-9]+)?\\))',
})
const internalRef = (name: string): JsonSchema => ({
  $ref: `#/definitions/${encodeURIComponent(name.replaceAll('~', '~0').replaceAll('/', '~1'))}`,
})
const invalid = (message: string): never => {
  throw new Error(`Invalid Prisma v8 PostgreSQL contract: ${message}`)
}
const object = (value: unknown, location: string) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid(`${location} must be an object`)
  return value as Record<string, unknown>
}
const text = (value: unknown, location: string): string => {
  if (typeof value !== 'string' || !value)
    invalid(`${location} must be a non-empty string`)
  return value as string
}

export function buildContractFixtureSchema(value: unknown): FixtureSchema {
  const contract = contractMetadata(value)
  const schema = structuredClone(baseFixtureSchema)
  const definitions = schema.definitions
  const aliasOwners = new Map<string, string | null>()

  for (const [namespace, entry] of Object.entries(contract.domain.namespaces)) {
    for (const model of Object.keys(
      object(entry.models, `${namespace}.models`),
    )) {
      const owner = `${namespace}.${model}`
      for (const alias of new Set([
        owner,
        model,
        model[0].toLowerCase() + model.slice(1),
      ])) {
        aliasOwners.set(
          alias,
          aliasOwners.has(alias) && aliasOwners.get(alias) !== owner
            ? null
            : owner,
        )
      }
    }
  }

  const aliases = (namespace: string, model: string) =>
    [...aliasOwners]
      .filter(([, owner]) => owner === `${namespace}.${model}`)
      .map(([alias]) => alias)

  const enumValues = (namespace: string, field: Field) => {
    if (!field.valueSet) return undefined
    const ref = field.valueSet
    const refNamespace =
      ref.namespaceId === '__unbound__' ? namespace : ref.namespaceId
    const values =
      ref.plane === 'domain' && ref.entityKind === 'enum'
        ? contract.domain.namespaces[refNamespace]?.enum?.[
            ref.entityName
          ]?.members.map(({ value }) => value)
        : ref.plane === 'storage' && ref.entityKind === 'valueSet'
          ? contract.storage.namespaces[refNamespace]?.entries.valueSet?.[
              ref.entityName
            ]?.values
          : undefined
    if (!values)
      invalid(`field value set ${refNamespace}.${ref.entityName} is invalid`)
    return values
  }

  const typeSchema = (namespace: string, value: unknown): JsonSchema => {
    const type = object(value, 'field type') as unknown as FieldType
    if (type.kind === 'scalar')
      return scalarSchema(text(type.codecId, 'codecId'))
    if (type.kind === 'valueObject') {
      const name = text(type.name, 'value object name')
      const definitionName = `PrismaContractValueObject_${JSON.stringify([namespace, name])}`
      if (!(definitionName in definitions)) {
        const valueObject =
          contract.domain.namespaces[namespace]?.valueObjects?.[name] ??
          invalid(`value object ${namespace}.${name} does not exist`)
        definitions[definitionName] = {}
        definitions[definitionName] = objectSchema(
          namespace,
          valueObject.fields,
          {},
        )
      }
      return internalRef(definitionName)
    }
    if (
      type.kind === 'union' &&
      Array.isArray(type.members) &&
      type.members.length
    )
      return {
        anyOf: type.members.map((member) => typeSchema(namespace, member)),
      }
    return invalid('field type kind is invalid')
  }

  const fieldSchema = (namespace: string, field: Field): JsonSchema => {
    if (typeof field.nullable !== 'boolean')
      invalid('field nullable must be boolean')
    if (field.many !== undefined && field.many !== true)
      invalid('field many must be true when present')
    if (field.dict) invalid('dictionary fields are not supported')
    const values = enumValues(namespace, field)
    const value = values ? { enum: values } : typeSchema(namespace, field.type)
    let result: JsonSchema = field.many
      ? { type: 'array', items: { anyOf: [value, dynamicString()] } }
      : value
    const acceptsString =
      values === undefined &&
      !field.many &&
      field.type.kind === 'scalar' &&
      (stringCodec(field.type.codecId) || jsonCodec(field.type.codecId))
    if (!acceptsString) result = { anyOf: [result, dynamicString()] }
    if (field.nullable) result = { anyOf: [result, { type: 'null' }] }
    return result
  }

  const connection = (): JsonSchema => ({
    allOf: [
      internalRef('safeObject'),
      {
        minProperties: 1,
        propertyNames: { not: { enum: ['connect', 'create'] } },
      },
    ],
  })
  const ensureModel = (namespace: string, name: string): string => {
    const definitionName = `PrismaContractModel_${JSON.stringify([namespace, name])}`
    if (definitionName in definitions) return definitionName
    const model = contract.domain.namespaces[namespace]?.models[name]
    if (!model) invalid(`relation target ${namespace}.${name} does not exist`)
    definitions[definitionName] = {}
    definitions[definitionName] = objectSchema(
      namespace,
      model.fields,
      model.relations,
      model,
      name,
    )
    return definitionName
  }
  const ensureNestedModel = (
    sourceNamespace: string,
    sourceName: string,
    sourceModel: Model,
    relationName: string,
    relation: Relation,
  ) => {
    const namespace = text(relation.to?.namespace, 'relation namespace')
    const name = text(relation.to?.model, 'relation model')
    const omitted = parentInjectedFields(
      contract,
      sourceNamespace,
      sourceName,
      sourceModel,
      relation,
    )
    if (!omitted.length) return ensureModel(namespace, name)
    const definitionName = `PrismaContractNested_${JSON.stringify([sourceNamespace, sourceName, relationName])}`
    if (definitionName in definitions) return definitionName
    const model = contract.domain.namespaces[namespace]?.models[name]
    if (!model) invalid(`relation target ${namespace}.${name} does not exist`)
    definitions[definitionName] = {}
    definitions[definitionName] = objectSchema(
      namespace,
      model.fields,
      model.relations,
      model,
      name,
      new Set(omitted),
    )
    return definitionName
  }
  const relationSchema = (
    namespace: string,
    modelName: string | undefined,
    model: Model | undefined,
    relationName: string,
    relation: Relation,
  ): JsonSchema => {
    if (!['1:1', 'N:1', '1:N', 'N:M'].includes(relation.cardinality))
      invalid('relation cardinality is invalid')
    const target = internalRef(
      model && modelName
        ? ensureNestedModel(namespace, modelName, model, relationName, relation)
        : ensureModel(
            text(relation.to?.namespace, 'relation namespace'),
            text(relation.to?.model, 'relation model'),
          ),
    )
    const oneOrMany = (item: JsonSchema): JsonSchema => ({
      anyOf: [
        item,
        dynamicString(),
        { type: 'array', items: { anyOf: [item, dynamicString()] } },
      ],
    })
    const selector = connection()
    const alternatives: JsonSchema[] = [
      dynamicString(),
      selector,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          connect: oneOrMany(selector),
          create: oneOrMany(target),
        },
        oneOf: [{ required: ['connect'] }, { required: ['create'] }],
      },
    ]
    if (relation.cardinality === '1:N' || relation.cardinality === 'N:M')
      alternatives.push({
        type: 'array',
        items: { anyOf: [dynamicString(), selector] },
      })
    if (relation.nullable) alternatives.push({ type: 'null' })
    return { anyOf: alternatives }
  }

  function objectSchema(
    namespace: string,
    fields: Record<string, Field>,
    relations: Record<string, Relation>,
    model?: Model,
    modelName?: string,
    omittedRequiredFields = new Set<string>(),
  ): JsonSchema {
    const properties = Object.fromEntries(
      Object.entries(object(fields, `${namespace} fields`)).map(
        ([name, field]) => [name, fieldSchema(namespace, field as Field)],
      ),
    )
    const required = Object.entries(fields)
      .filter(
        ([name, field]) =>
          !field.nullable &&
          !omittedRequiredFields.has(name) &&
          !hasDefault(contract, model, name),
      )
      .map(([name]) => name)
    const relationRequirements: JsonSchema[] = []
    for (const [name, relation] of Object.entries(
      object(relations, `${namespace} relations`) as Record<string, Relation>,
    )) {
      properties[name] = relationSchema(
        namespace,
        modelName,
        model,
        name,
        relation,
      )
      if (
        relation.nullable === false &&
        (relation.cardinality === 'N:1' ||
          (relation.cardinality === '1:1' &&
            ownsForeignKey(contract, model, relation)))
      ) {
        const local = relation.on?.localFields.filter((field) =>
          required.includes(field),
        )
        if (local?.length) {
          for (const field of local) required.splice(required.indexOf(field), 1)
          relationRequirements.push({
            anyOf: [{ required: local }, { required: [name] }],
          })
        }
      }
    }
    return {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
      ...(relationRequirements.length ? { allOf: relationRequirements } : {}),
    }
  }

  const entityNames: string[] = []
  const conditions: JsonSchema[] = []
  for (const [namespace, entry] of Object.entries(contract.domain.namespaces)) {
    for (const [name, model] of Object.entries(entry.models)) {
      const modelAliases = aliases(namespace, name)
      const relations = Object.keys(model.relations)
      const scalars = Object.keys(model.fields)
      entityNames.push(...modelAliases)
      conditions.push({
        if: {
          required: ['entity'],
          properties: { entity: { enum: modelAliases } },
        },
        then: {
          properties: {
            connectedFields: relations.length
              ? { items: { enum: relations } }
              : { maxItems: 0 },
            deferredFields: scalars.length
              ? { items: { enum: scalars } }
              : { maxItems: 0 },
          },
          allOf: [
            {
              if: { not: { required: ['processor'] } },
              then: {
                properties: {
                  items: {
                    additionalProperties: internalRef(
                      ensureModel(namespace, name),
                    ),
                  },
                },
              },
            },
          ],
        },
      })
    }
  }

  schema.properties.entity = entityNames.length
    ? {
        description:
          'Prisma v8 namespace-qualified model or an unambiguous model alias.',
        type: 'string',
        enum: [...new Set(entityNames)],
      }
    : { description: 'No Prisma models are available.', not: {} }
  schema.allOf = [...(schema.allOf ?? []), ...conditions]
  return schema
}

function contractMetadata(value: unknown): Contract {
  const root = object(value, 'contract')
  if (root.schemaVersion !== '1') invalid('schemaVersion must be "1"')
  if (root.targetFamily !== 'sql' || root.target !== 'postgres')
    invalid('contract must target PostgreSQL')
  const domain = object(root.domain, 'domain')
  const storage = object(root.storage, 'storage')
  object(root.roots, 'roots')
  object(domain.namespaces, 'domain.namespaces')
  object(storage.namespaces, 'storage.namespaces')
  return root as unknown as Contract
}

function hasDefault(
  contract: Contract,
  model: Model | undefined,
  name: string,
) {
  if (!model) return false
  const field = model.storage.fields[name]
  if (!field) return false
  const column =
    contract.storage.namespaces[model.storage.namespaceId]?.entries.table[
      model.storage.table
    ]?.columns[field.column]
  return (
    (column !== undefined && 'default' in column) ||
    (contract.execution?.mutations.defaults.some(
      ({ ref, onCreate }) =>
        onCreate !== undefined &&
        ref.namespace === model.storage.namespaceId &&
        ref.table === model.storage.table &&
        ref.column === field.column,
    ) ??
      false)
  )
}

function parentInjectedFields(
  contract: Contract,
  sourceNamespace: string,
  sourceName: string,
  sourceModel: Model,
  relation: Relation,
): string[] {
  if (
    !relation.on ||
    (relation.cardinality !== '1:N' && relation.cardinality !== '1:1')
  )
    return []
  const target =
    contract.domain.namespaces[relation.to.namespace]?.models[relation.to.model]
  if (
    !target ||
    !relation.on.localFields.every((field) => field in sourceModel.fields) ||
    !relation.on.targetFields.every((field) => field in target.fields)
  )
    return []
  const inverse = Object.values(target.relations).find(
    (candidate) =>
      candidate.to.namespace === sourceNamespace &&
      candidate.to.model === sourceName &&
      candidate.on !== undefined &&
      sameFields(candidate.on.localFields, relation.on!.targetFields) &&
      sameFields(candidate.on.targetFields, relation.on!.localFields) &&
      ownsForeignKey(contract, target, candidate),
  )
  return inverse ? relation.on.targetFields : []
}

function sameFields(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((field, index) => field === right[index])
  )
}

function ownsForeignKey(
  contract: Contract,
  model: Model | undefined,
  relation: Relation,
) {
  if (!model || !relation.on) return false
  const sourceColumns = relation.on.localFields.map(
    (field) => model.storage.fields[field]?.column,
  )
  const target =
    contract.domain.namespaces[relation.to.namespace]?.models[relation.to.model]
  const targetColumns = relation.on.targetFields.map(
    (field) => target?.storage.fields[field]?.column,
  )
  if (
    !target ||
    sourceColumns.some((column) => column === undefined) ||
    targetColumns.some((column) => column === undefined)
  )
    return false
  const table =
    contract.storage.namespaces[model.storage.namespaceId]?.entries.table[
      model.storage.table
    ]
  return table?.foreignKeys.some(
    ({ source, target: foreignTarget }) =>
      source.namespaceId === model.storage.namespaceId &&
      source.tableName === model.storage.table &&
      sameFields(source.columns, sourceColumns as string[]) &&
      foreignTarget.namespaceId === target.storage.namespaceId &&
      foreignTarget.tableName === target.storage.table &&
      sameFields(foreignTarget.columns, targetColumns as string[]),
  )
}

const jsonCodec = (codecId: string) =>
  codecId === 'pg/json@1' || codecId === 'pg/jsonb@1'
const stringCodec = (codecId: string) =>
  /^(?:pg\/(?:text|enum|char|varchar|bit|varbit|date-(?:string|temporal)|timestamp-(?:string|temporal)|timestamptz-(?:string|temporal|date)|time-(?:string|temporal)|timetz|interval|bytea|uuid|inet|tsquery)|sql\/(?:char|varchar|text))@1$/.test(
    codecId,
  )
const scalarSchema = (codecId: string): JsonSchema => {
  if (jsonCodec(codecId)) return internalRef('jsonValue')
  if (codecId === 'pg/bool@1') return { type: 'boolean' }
  if (/^(?:pg\/(?:int|int2|int4|int8number)|sql\/int)@1$/.test(codecId))
    return { type: 'integer' }
  if (/^pg\/(?:int8|unboundedint)@1$/.test(codecId))
    return {
      anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^-?[0-9]+$' }],
    }
  if (/^(?:pg\/(?:float|float4|float8)|sql\/float)@1$/.test(codecId))
    return { type: 'number' }
  if (codecId === 'pg/numeric@1')
    return { anyOf: [{ type: 'number' }, { type: 'string' }] }
  if (codecId === 'pg/text-array@1')
    return { type: 'array', items: { type: 'string' } }
  if (stringCodec(codecId)) return { type: 'string' }
  return invalid(`field type codec ${codecId} is not supported`)
}
