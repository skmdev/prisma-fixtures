import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaFixtures } from '@skmdev/prisma-fixtures'
import { PrismaClient } from '../src/generated/prisma/client.mts'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is required')

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
})

try {
  const records = await new PrismaFixtures().load(prisma)
  console.log(`Loaded ${Object.keys(records).length} fixtures.`)
} finally {
  await prisma.$disconnect()
}
