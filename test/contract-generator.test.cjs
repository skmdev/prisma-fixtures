const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const Ajv = require('ajv')

const {
  buildContractFixtureSchema,
} = require('../dist/contract-fixture-schema.js')

const model = (fields, relations = {}) => ({
  fields,
  relations,
  storage: {
    namespaceId: 'public',
    table: 'unused',
    fields: Object.fromEntries(
      Object.keys(fields).map((name) => [name, { column: name }]),
    ),
  },
})
const scalar = (codecId, options = {}) => ({
  nullable: false,
  type: { kind: 'scalar', codecId },
  ...options,
})

const post = model(
  {
    id: scalar('pg/int4@1'),
    title: scalar('pg/text@1'),
    role: {
      ...scalar('pg/text@1'),
      valueSet: {
        plane: 'domain',
        namespaceId: 'public',
        entityKind: 'enum',
        entityName: 'Role',
      },
    },
    metadata: scalar('pg/json@1', { nullable: true }),
    tags: scalar('pg/text@1', { many: true }),
    authorId: scalar('pg/int4@1'),
  },
  {
    author: {
      cardinality: 'N:1',
      nullable: false,
      on: { localFields: ['authorId'], targetFields: ['id'] },
      to: { namespace: 'public', model: 'User' },
    },
  },
)
post.storage.table = 'Post'

const publicUser = model(
  {
    id: scalar('pg/int4@1'),
    name: scalar('pg/text@1'),
  },
  {
    posts: {
      cardinality: '1:N',
      on: { localFields: ['id'], targetFields: ['authorId'] },
      to: { namespace: 'public', model: 'Post' },
    },
  },
)
publicUser.storage.table = 'User'

const auditUser = model({ id: scalar('pg/int4@1') })
auditUser.storage.namespaceId = 'audit'
auditUser.storage.table = 'User'

const table = (columns) => ({
  columns,
  uniques: [],
  indexes: [],
  foreignKeys: [],
})
const column = (codecId, options = {}) => ({
  nativeType: 'test',
  codecId,
  nullable: false,
  ...options,
})

const contract = {
  schemaVersion: '1',
  targetFamily: 'sql',
  target: 'postgres',
  roots: {
    Post: { namespace: 'public', model: 'Post' },
    User: { namespace: 'public', model: 'User' },
    AuditUser: { namespace: 'audit', model: 'User' },
  },
  domain: {
    namespaces: {
      public: {
        models: { Post: post, User: publicUser },
        enum: {
          Role: {
            codecId: 'pg/text@1',
            members: [
              { name: 'Admin', value: 'admin' },
              { name: 'User', value: 'user' },
            ],
          },
        },
      },
      audit: { models: { User: auditUser } },
    },
  },
  storage: {
    storageHash: 'test',
    namespaces: {
      public: {
        id: 'public',
        kind: 'postgres-schema',
        entries: {
          table: {
            Post: table({
              id: column('pg/int4@1', {
                default: { kind: 'function', expression: 'autoincrement()' },
              }),
              title: column('pg/text@1'),
              role: column('pg/text@1'),
              metadata: column('pg/json@1', { nullable: true }),
              tags: column('pg/text@1', { many: true }),
              authorId: column('pg/int4@1'),
            }),
            User: table({
              id: column('pg/int4@1', {
                default: { kind: 'function', expression: 'autoincrement()' },
              }),
              name: column('pg/text@1'),
            }),
          },
        },
      },
      audit: {
        id: 'audit',
        kind: 'postgres-schema',
        entries: {
          table: {
            User: table({
              id: column('pg/int4@1', {
                default: { kind: 'function', expression: 'autoincrement()' },
              }),
            }),
          },
        },
      },
    },
  },
}
contract.storage.namespaces.public.entries.table.Post.foreignKeys.push({
  source: {
    namespaceId: 'public',
    tableName: 'Post',
    columns: ['authorId'],
  },
  target: {
    namespaceId: 'public',
    tableName: 'User',
    columns: ['id'],
  },
})

const fixture = (entity, data, metadata = {}) => ({
  entity,
  ...metadata,
  items: { fixture1: data },
})

test('builds a bounded PostgreSQL contract fixture schema', () => {
  const schema = buildContractFixtureSchema(contract)
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema)

  for (const document of [
    fixture(
      'public.Post',
      {
        title: '{{lorem.words}}',
        role: 'admin',
        metadata: { connect: { remains: 'ordinary JSON' } },
        tags: ['one', '@post1.title'],
        author: { connect: { id: '@user1.id' } },
      },
      { connectedFields: ['author'], deferredFields: ['title'] },
    ),
    fixture('Post', {
      title: 'Nested create',
      role: '<{role}>',
      tags: [],
      author: { create: { name: 'Ada' } },
    }),
    fixture('post', {
      title: 'Foreign key',
      role: 'user',
      tags: [],
      authorId: 1,
    }),
    fixture('public.User', {
      name: 'Parent',
      posts: {
        create: [{ title: 'Child', role: 'admin', tags: [] }],
      },
    }),
    fixture('audit.User', {}),
  ]) {
    assert.equal(validate(document), true, JSON.stringify(validate.errors))
  }

  for (const document of [
    fixture('Post', {
      title: 42,
      role: 'admin',
      tags: [],
      authorId: 1,
    }),
    fixture('Post', {
      title: 'Bad enum',
      role: 'owner',
      tags: [],
      authorId: 1,
    }),
    fixture('Post', {
      title: 'Bad relation',
      role: 'admin',
      tags: [],
      author: { connect: 1 },
    }),
    fixture('Post', {
      title: 'Ambiguous relation operation',
      role: 'admin',
      tags: [],
      author: {
        connect: { id: 1 },
        create: { name: 'Ada' },
      },
    }),
    fixture('Post', {
      title: 'Standalone still needs its parent',
      role: 'admin',
      tags: [],
    }),
    fixture(
      'Post',
      { title: 'Bad metadata', role: 'admin', tags: [], authorId: 1 },
      { connectedFields: ['title'] },
    ),
    fixture('User', { name: 'Ambiguous alias' }),
  ]) {
    assert.equal(validate(document), false, JSON.stringify(document))
  }
})

test('nested create omits only the exact foreign key filled by its parent', () => {
  const relatedTwice = structuredClone(contract)
  const relatedPost = relatedTwice.domain.namespaces.public.models.Post
  const relatedUser = relatedTwice.domain.namespaces.public.models.User
  relatedPost.fields.reviewerId = scalar('pg/int4@1')
  relatedPost.storage.fields.reviewerId = { column: 'reviewerId' }
  relatedPost.relations.reviewer = {
    cardinality: 'N:1',
    nullable: false,
    on: { localFields: ['reviewerId'], targetFields: ['id'] },
    to: { namespace: 'public', model: 'User' },
  }
  relatedUser.relations.reviewedPosts = {
    cardinality: '1:N',
    on: { localFields: ['id'], targetFields: ['reviewerId'] },
    to: { namespace: 'public', model: 'Post' },
  }
  const postTable = relatedTwice.storage.namespaces.public.entries.table.Post
  postTable.columns.reviewerId = column('pg/int4@1')
  postTable.foreignKeys.push({
    source: {
      namespaceId: 'public',
      tableName: 'Post',
      columns: ['reviewerId'],
    },
    target: {
      namespaceId: 'public',
      tableName: 'User',
      columns: ['id'],
    },
  })

  const validate = new Ajv({ allErrors: true, strict: false }).compile(
    buildContractFixtureSchema(relatedTwice),
  )
  const nestedPost = {
    title: 'Child',
    role: 'admin',
    tags: [],
  }
  assert.equal(
    validate(
      fixture('public.User', {
        name: 'Parent',
        posts: { create: [{ ...nestedPost, reviewerId: 1 }] },
      }),
    ),
    true,
    JSON.stringify(validate.errors),
  )
  assert.equal(
    validate(
      fixture('public.User', {
        name: 'Parent',
        posts: {
          create: [{ ...nestedPost, authorId: 2, reviewerId: 1 }],
        },
      }),
    ),
    true,
    JSON.stringify(validate.errors),
  )
  assert.equal(
    validate(
      fixture('public.User', {
        name: 'Parent',
        posts: { create: [nestedPost] },
      }),
    ),
    false,
  )
})

test('drops every colliding unqualified model alias', () => {
  const aliasCollision = structuredClone(contract)
  const lowerUser = model({ id: scalar('pg/int4@1') })
  lowerUser.storage.namespaceId = 'audit'
  lowerUser.storage.table = 'user'
  aliasCollision.domain.namespaces.audit.models.user = lowerUser
  aliasCollision.storage.namespaces.audit.entries.table.user = table({
    id: column('pg/int4@1', {
      default: { kind: 'function', expression: 'autoincrement()' },
    }),
  })

  const schema = buildContractFixtureSchema(aliasCollision)
  assert.equal(schema.properties.entity.enum.includes('User'), false)
  assert.equal(schema.properties.entity.enum.includes('user'), false)
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema)
  assert.equal(validate(fixture('audit.user', {})), true)
  assert.equal(validate(fixture('user', {})), false)
})

test('namespace and model names cannot collide in schema definition keys', () => {
  const value = {
    ...contract,
    roots: {
      First: { namespace: 'a_b', model: 'C' },
      Second: { namespace: 'a', model: 'b_C' },
    },
    domain: {
      namespaces: {
        a_b: { models: { C: model({ first: scalar('pg/text@1') }) } },
        a: { models: { b_C: model({ second: scalar('pg/int4@1') }) } },
      },
    },
  }
  const validate = new Ajv({ strict: false }).compile(
    buildContractFixtureSchema(value),
  )
  assert.equal(validate(fixture('a_b.C', { first: 'yes' })), true)
  assert.equal(validate(fixture('a.b_C', { second: 1 })), true)
  assert.equal(validate(fixture('a.b_C', { first: 'wrong' })), false)
})

test('runtime create defaults match the exact storage column', () => {
  const value = structuredClone(contract)
  const user = value.domain.namespaces.public.models.User
  user.fields.generatedId = scalar('pg/text@1')
  user.fields.updatedAt = scalar('pg/timestamp-temporal@1')
  user.storage.fields.generatedId = { column: 'generated_id' }
  user.storage.fields.updatedAt = { column: 'updated_at' }
  value.execution = {
    mutations: {
      defaults: [
        {
          ref: { namespace: 'public', table: 'User', column: 'generated_id' },
          onCreate: { kind: 'generator', id: 'uuidv4' },
        },
        {
          ref: { namespace: 'public', table: 'User', column: 'updated_at' },
          onCreate: { kind: 'generator', id: 'plainDateTimeNow' },
          onUpdate: { kind: 'generator', id: 'plainDateTimeNow' },
        },
        {
          ref: { namespace: 'public', table: 'User', column: 'name' },
          onUpdate: { kind: 'generator', id: 'unused' },
        },
        {
          ref: { namespace: 'audit', table: 'User', column: 'name' },
          onCreate: { kind: 'generator', id: 'unused' },
        },
      ],
    },
  }
  const validate = new Ajv({ strict: false }).compile(
    buildContractFixtureSchema(value),
  )
  assert.equal(
    validate(fixture('public.User', { name: 'with generated defaults' })),
    true,
  )
  assert.equal(validate(fixture('public.User', {})), false)
})

test('rejects malformed or unsupported contract metadata', () => {
  assert.throws(
    () =>
      buildContractFixtureSchema({
        ...contract,
        domain: {
          namespaces: {
            public: {
              models: {
                Broken: model({ value: { nullable: false, type: {} } }),
              },
            },
          },
        },
      }),
    /field type/i,
  )
  assert.throws(
    () => buildContractFixtureSchema({ ...contract, target: 'mysql' }),
    /PostgreSQL/i,
  )
})

test('offline generator writes schema.json to the requested directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixtures-contract-'))
  const contractPath = path.join(directory, 'contract.json')
  const output = path.join(directory, 'fixture-schema')
  const runtimePackage = path.join(
    directory,
    'node_modules/@prisma/orm-postgres',
  )
  fs.mkdirSync(runtimePackage, { recursive: true })
  fs.writeFileSync(
    path.join(runtimePackage, 'package.json'),
    JSON.stringify({
      type: 'module',
      exports: { './target/runtime': './runtime.mjs' },
    }),
  )
  fs.writeFileSync(
    path.join(runtimePackage, 'runtime.mjs'),
    'export class PostgresContractSerializer { deserializeContract(value) { if (value.target !== "postgres") throw new Error("invalid contract") } }',
  )
  fs.writeFileSync(contractPath, JSON.stringify(contract))

  execFileSync(
    process.execPath,
    [path.join(__dirname, '../dist/generator.js'), contractPath, output],
    { cwd: directory },
  )

  assert.equal(fs.existsSync(path.join(output, 'schema.json')), true)
  assert.equal(fs.existsSync(path.join(directory, 'schema.json')), false)
})
