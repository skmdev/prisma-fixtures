const assert = require('node:assert/strict')
const { test } = require('node:test')
const Ajv = require('ajv')

const { buildFixtureSchema } = require('../dist/fixture-schema.js')

const ref = (type, location = 'scalar', isList = false, namespace) => ({
  type,
  location,
  isList,
  ...(namespace ? { namespace } : {}),
})
const field = (name, inputTypes, isRequired = false, isNullable = false) => ({
  name,
  inputTypes,
  isRequired,
  isNullable,
})
const input = (name, fields) => ({ name, fields, constraints: {} })

const dmmf = {
  datamodel: {
    models: [
      {
        name: 'User',
        fields: [
          {
            name: 'posts',
            kind: 'object',
            isList: true,
            relationName: 'PostToUser',
          },
        ],
      },
      {
        name: 'Post',
        fields: [
          {
            name: 'author',
            kind: 'object',
            isList: false,
            relationName: 'PostToUser',
          },
        ],
      },
    ],
    enums: [],
  },
  schema: {
    inputObjectTypes: {
      model: [],
      prisma: [
        input('UserCreateInput', [
          field('email', [ref('String')], true),
          field('role', [ref('Role', 'enumTypes', false, 'model')], true),
          field('posts', [
            ref('PostCreateNestedManyWithoutAuthorInput', 'inputObjectTypes'),
          ]),
          field('scores', [ref('Int', 'scalar', true)]),
        ]),
        input('UserUncheckedCreateInput', [
          field('email', [ref('String')], true),
          field('role', [ref('Role', 'enumTypes', false, 'model')], true),
          field('scores', [ref('Int', 'scalar', true)]),
        ]),
        input('PostCreateInput', [
          field('title', [ref('String')], true),
          field('role', [ref('Role', 'enumTypes', false, 'model')], true),
          field(
            'author',
            [ref('UserCreateNestedOneWithoutPostsInput', 'inputObjectTypes')],
            true,
          ),
        ]),
        input('PostUncheckedCreateInput', [
          field('title', [ref('String')], true),
          field('role', [ref('Role', 'enumTypes', false, 'model')], true),
          field('authorId', [ref('Int')], true),
          field('price', [ref('Decimal')]),
          field('published', [ref('Boolean')]),
        ]),
        input('PostCreateNestedManyWithoutAuthorInput', []),
        input('UserCreateNestedOneWithoutPostsInput', [
          field('connect', [ref('UserWhereUniqueInput', 'inputObjectTypes')]),
        ]),
        input('UserWhereUniqueInput', [field('id', [ref('Int')])]),
        input('UnusedInput', [field('secret', [ref('String')])]),
      ],
    },
    enumTypes: {
      model: [{ name: 'Role', values: ['ADMIN', 'USER'] }],
      prisma: [{ name: 'UnusedEnum', values: ['NOPE'] }],
    },
  },
}

const fixture = (entity, data, metadata = {}) => ({
  entity,
  ...metadata,
  items: { fixture1: data },
})

test('builds only reachable model schemas and selects create fields by entity', () => {
  const schema = buildFixtureSchema(dmmf)
  assert.deepEqual(schema.properties.entity.enum, [
    'User',
    'user',
    'Post',
    'post',
  ])
  assert.doesNotMatch(JSON.stringify(schema), /UnusedInput|UnusedEnum/)

  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema)
  for (const document of [
    fixture('Post', {
      title: 'Nested',
      role: 'ADMIN',
      author: { connect: { id: 1 } },
    }),
    fixture('post', { title: 'Foreign key', role: 'USER', authorId: 1 }),
  ]) {
    assert.equal(validate(document), true, JSON.stringify(validate.errors))
  }
  for (const document of [
    fixture('Post', {
      title: 'Unknown',
      role: 'ADMIN',
      authorId: 1,
      extra: true,
    }),
    fixture('Post', { title: 'Enum', role: 'OTHER', authorId: 1 }),
    fixture('Post', { title: null, role: 'ADMIN', authorId: 1 }),
    fixture('Post', {
      title: 'Scalar',
      role: 'ADMIN',
      authorId: 'not-dynamic',
    }),
    fixture(
      'Post',
      { title: 'Missing id', role: 'ADMIN', author: { email: 'missing' } },
      { connectedFields: ['author'] },
    ),
    fixture('User', { title: 'Wrong model', role: 'ADMIN', authorId: 1 }),
  ]) {
    assert.equal(validate(document), false, JSON.stringify(document))
  }
})

test('accepts rendered values, relation shorthand and processor-shaped data', () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(
    buildFixtureSchema(dmmf),
  )
  for (const document of [
    fixture('Post', {
      title: '{{lorem.words}}',
      role: '<{role}>',
      authorId: '@user1.id',
      price: '+.5',
      published: '<%= true %>',
    }),
    fixture('Post', {
      title: 'Current index',
      role: 'ROLE($current)',
      authorId: '($current+1)',
    }),
    fixture(
      'User',
      {
        email: 'user@example.test',
        role: 'ADMIN',
        posts: [
          { id: 'post-1', title: 'Literal record' },
          '@post1',
          '<%= posts[0] %>',
        ],
        scores: ['@post1.score', '{{number.int}}', 3],
      },
      { connectedFields: ['posts'] },
    ),
    fixture(
      'Post',
      {
        title: 'Literal relation',
        role: 'USER',
        author: { id: 1, email: 'user@example.test' },
      },
      { connectedFields: ['author'] },
    ),
    fixture(
      'Post',
      { unknown: { shape: true }, title: null },
      { processor: './processor.js' },
    ),
  ]) {
    assert.equal(validate(document), true, JSON.stringify(validate.errors))
  }

  assert.equal(
    validate(
      fixture(
        'User',
        { email: 'user@example.test', role: 'ADMIN' },
        { connectedFields: ['author'] },
      ),
    ),
    false,
  )
})
