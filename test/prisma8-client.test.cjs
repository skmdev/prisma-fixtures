const assert = require('node:assert/strict')
const test = require('node:test')
const { createPrisma8FixtureClient, loadFixtures } = require('../dist')

test('v8 fixture adapter transforms only contract relations and rejects invalid deadlines', async () => {
  const writes = []
  const models = {
    User: {
      fields: { total: { type: { kind: 'scalar', codecId: 'pg/int8@1' } } },
      storage: {
        namespaceId: 'public',
        table: 'User',
        fields: { total: { column: 'total' } },
      },
      relations: { posts: { to: { namespace: 'public', model: 'Post' } } },
    },
    Post: { relations: {} },
  }
  const db = {
    contract: { domain: { namespaces: { public: { models } } } },
    orm: {
      public: Object.fromEntries(
        Object.keys(models).map((name) => [
          name,
          {
            async create(data) {
              writes.push(data)
              return { id: writes.length, ...data }
            },
          },
        ]),
      ),
    },
    raw: { sql() {} },
    context: {
      contractCodecs: {
        forColumn() {
          return { decodeJson: (value) => BigInt(value) }
        },
      },
    },
    runtime() {},
    async transaction() {
      throw new Error('should validate before connecting')
    },
    async close() {},
  }
  const client = createPrisma8FixtureClient(db)
  await loadFixtures(client, [
    {
      name: 'user',
      entity: 'public.User',
      parameters: {},
      data: {
        name: 'User',
        total: '9007199254740993',
        metadata: { connect: { id: 77 } },
        posts: { create: [{ title: 'nested' }] },
      },
    },
  ])
  assert.deepEqual(writes[0].metadata, { connect: { id: 77 } })
  assert.equal(writes[0].total, 9007199254740993n)
  assert.deepEqual(writes[0].posts({ create: (value) => value }), [
    { title: 'nested' },
  ])
  assert.equal(client.user, client.User)
  await assert.rejects(
    client.User.create({
      data: { posts: { connect: { id: 1 }, create: { title: 'ambiguous' } } },
    }),
    /require connect or create/,
  )
  const ambiguous = createPrisma8FixtureClient({
    ...db,
    contract: {
      domain: {
        namespaces: {
          public: { models },
          audit: { models: { User: models.User } },
        },
      },
    },
  })
  assert.equal(ambiguous.User, undefined)
  assert.equal(ambiguous.user, undefined)
  assert.equal(typeof ambiguous['public.User'].create, 'function')
  assert.equal(typeof ambiguous['audit.User'].create, 'function')
  for (const timeout of [0, -1, 1.5, 2 ** 31, Infinity]) {
    await assert.rejects(
      client.$transaction(async () => {}, { timeout }),
      /timeout/,
    )
  }
})
