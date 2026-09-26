import postgres from '@prisma/orm-postgres/runtime'
import {
  createPrisma8FixtureClient,
  PrismaFixtures,
} from '@skmdev/prisma-fixtures'
import contractJson from '../src/generated/prisma/contract.json' with { type: 'json' }

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is required')

const client = createPrisma8FixtureClient(
  postgres({ contractJson, url: connectionString }),
)

try {
  const records = await new PrismaFixtures().load(client)
  console.log(`Loaded ${Object.keys(records).length} fixtures.`)
} finally {
  await client.$disconnect()
}
