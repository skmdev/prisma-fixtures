import fs from 'node:fs'
import path from 'node:path'

import type { GeneratorOptions } from '@prisma/generator-helper'

type Dmmf = GeneratorOptions['dmmf']
type InputType = NonNullable<
  Dmmf['schema']['inputObjectTypes']['prisma']
>[number]
type InputTypeRef = InputType['fields'][number]['inputTypes'][number]
type SchemaEnum = Dmmf['schema']['enumTypes']['prisma'][number]
type Namespace = 'model' | 'prisma'
type JsonSchema = Record<string, unknown>
type FixtureSchema = JsonSchema & {
  properties: Record<string, JsonSchema>
  definitions: Record<string, JsonSchema>
  allOf?: JsonSchema[]
}
type InputInfo = { input: InputType; namespace: Namespace }
type EnumInfo = { enumType: SchemaEnum; namespace: Namespace }

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

const pointer = (value: string) =>
  value.replaceAll('~', '~0').replaceAll('/', '~1')

export function buildFixtureSchema(dmmf: Dmmf): FixtureSchema {
  const schema = structuredClone(baseFixtureSchema)
  const definitions = schema.definitions
  const inputs = new Map<string, InputInfo>()
  const inputsByName = new Map<string, InputInfo>()
  const enums = new Map<string, EnumInfo>()
  const enumsByName = new Map<string, EnumInfo>()
  const rootRelations = new Map<string, Map<string, boolean>>()

  const addInputs = (namespace: Namespace, values: readonly InputType[]) => {
    for (const input of values) {
      const info = { input, namespace }
      inputs.set(`${namespace}:${input.name}`, info)
      if (!inputsByName.has(input.name)) inputsByName.set(input.name, info)
    }
  }
  addInputs('model', dmmf.schema.inputObjectTypes.model ?? [])
  addInputs('prisma', dmmf.schema.inputObjectTypes.prisma ?? [])

  const addEnums = (namespace: Namespace, values: readonly SchemaEnum[]) => {
    for (const enumType of values) {
      const info = { enumType, namespace }
      enums.set(`${namespace}:${enumType.name}`, info)
      if (!enumsByName.has(enumType.name)) enumsByName.set(enumType.name, info)
    }
  }
  addEnums('model', dmmf.schema.enumTypes.model ?? [])
  addEnums('prisma', dmmf.schema.enumTypes.prisma)

  for (const model of dmmf.datamodel.models) {
    const fields = new Map(
      model.fields
        .filter((field) => field.kind === 'object')
        .map((field) => [field.name, field.isList] as const),
    )
    rootRelations.set(`${model.name}CreateInput`, fields)
    rootRelations.set(`${model.name}UncheckedCreateInput`, fields)
  }

  const connectionRecord = (): JsonSchema => {
    const name = 'PrismaFixtureConnectionRecord'
    if (!(name in definitions)) {
      definitions[name] = {
        allOf: [
          internalRef('safeObject'),
          {
            type: 'object',
            required: ['id'],
            properties: { id: internalRef('jsonValue') },
          },
        ],
      }
    }
    return internalRef(name)
  }

  const resolveInput = (reference: InputTypeRef) =>
    (reference.namespace
      ? inputs.get(`${reference.namespace}:${reference.type}`)
      : undefined) ?? inputsByName.get(reference.type)
  const resolveEnum = (reference: InputTypeRef) =>
    (reference.namespace
      ? enums.get(`${reference.namespace}:${reference.type}`)
      : undefined) ?? enumsByName.get(reference.type)

  const ensureEnum = (info: EnumInfo) => {
    const name = enumDefinitionName(info)
    if (!(name in definitions)) {
      definitions[name] = { type: 'string', enum: [...info.enumType.values] }
    }
    return name
  }

  const ensureInput = (info: InputInfo): string => {
    const name = inputDefinitionName(info)
    if (name in definitions) return name
    definitions[name] = {}

    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    const relations = rootRelations.get(info.input.name)
    for (const field of info.input.fields) {
      const alternatives = field.inputTypes.map((reference) => {
        let value: JsonSchema
        if (reference.location === 'scalar') {
          value = scalarSchema(reference.type)
        } else if (reference.location === 'inputObjectTypes') {
          const input = resolveInput(reference)
          value = input
            ? internalRef(ensureInput(input))
            : internalRef('jsonValue')
        } else if (reference.location === 'enumTypes') {
          const enumType = resolveEnum(reference)
          value = enumType
            ? internalRef(ensureEnum(enumType))
            : { type: 'string' }
        } else {
          value = internalRef('jsonValue')
        }
        return reference.isList
          ? { type: 'array', items: { anyOf: [value, dynamicString()] } }
          : value
      })
      const relationList = relations?.get(field.name)
      if (relationList !== undefined) {
        const record = connectionRecord()
        alternatives.push(record)
        if (relationList) {
          alternatives.push({
            type: 'array',
            items: { anyOf: [dynamicString(), record] },
          })
        }
      }
      alternatives.push(dynamicString())
      if (field.isNullable) alternatives.push({ type: 'null' })
      properties[field.name] = {
        ...(field.comment ? { description: field.comment } : {}),
        anyOf: alternatives,
      }
      if (field.isRequired) required.push(field.name)
    }

    definitions[name] = {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
    }
    return name
  }

  const entityNames = [
    ...new Set(
      dmmf.datamodel.models.flatMap(({ name }) => [
        name,
        name[0].toLowerCase() + name.slice(1),
      ]),
    ),
  ]
  schema.properties.entity = entityNames.length
    ? {
        description: 'Prisma model or lowercase-first delegate name.',
        allOf: [{ $ref: '#/definitions/entityName' }],
        enum: entityNames,
      }
    : {
        description: 'No Prisma models are available.',
        not: {},
      }

  const modelConditions: JsonSchema[] = []
  for (const model of dmmf.datamodel.models) {
    const aliases = [
      ...new Set([
        model.name,
        model.name[0].toLowerCase() + model.name.slice(1),
      ]),
    ]
    const relationNames = model.fields
      .filter((field) => field.kind === 'object')
      .map((field) => field.name)
    const roots = [
      inputs.get(`prisma:${model.name}CreateInput`) ??
        inputsByName.get(`${model.name}CreateInput`),
      inputs.get(`prisma:${model.name}UncheckedCreateInput`) ??
        inputsByName.get(`${model.name}UncheckedCreateInput`),
    ].filter((value): value is InputInfo => value !== undefined)
    const itemSchemas = roots.map((root) => internalRef(ensureInput(root)))
    const thenSchema: JsonSchema = {
      properties: {
        connectedFields: relationNames.length
          ? { items: { enum: relationNames } }
          : { maxItems: 0 },
      },
    }
    if (itemSchemas.length) {
      thenSchema.allOf = [
        {
          if: { not: { required: ['processor'] } },
          then: {
            properties: {
              items: {
                additionalProperties:
                  itemSchemas.length === 1
                    ? itemSchemas[0]
                    : { anyOf: itemSchemas },
              },
            },
          },
        },
      ]
    }
    modelConditions.push({
      if: {
        required: ['entity'],
        properties: { entity: { enum: aliases } },
      },
      then: thenSchema,
    })
  }
  schema.allOf = [...(schema.allOf ?? []), ...modelConditions]

  return schema
}

const inputDefinitionName = ({ input, namespace }: InputInfo) =>
  `PrismaInput_${namespace}_${input.name}`
const enumDefinitionName = ({ enumType, namespace }: EnumInfo) =>
  `PrismaEnum_${namespace}_${enumType.name}`
const internalRef = (name: string): JsonSchema => ({
  $ref: `#/definitions/${pointer(name)}`,
})
const scalarSchema = (type: string): JsonSchema => {
  if (type === 'Int') return { type: 'integer' }
  if (type === 'Float') return { type: 'number' }
  if (type === 'Decimal') {
    return {
      anyOf: [{ type: 'number' }, { type: 'string' }],
    }
  }
  if (type === 'String' || type === 'DateTime') return { type: 'string' }
  if (type === 'Boolean') return { type: 'boolean' }
  if (type === 'BigInt') {
    return {
      anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^-?[0-9]+$' }],
    }
  }
  if (type === 'Json') return internalRef('jsonValue')
  if (type === 'Null') return { type: 'null' }
  if (type === 'Bytes') {
    return {
      description:
        'Bytes constructors are validated by Prisma at runtime; fixture structure remains permissive.',
    }
  }
  return internalRef('jsonValue')
}
