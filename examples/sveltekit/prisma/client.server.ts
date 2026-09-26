import postgres from '@prisma/orm-postgres/runtime'
import type { Contract } from '../src/generated/prisma/contract.d'
import contractJson from '../src/generated/prisma/contract.json' with { type: 'json' }

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is required')

type Db = ReturnType<typeof postgres<Contract>>
const globalForPrisma = globalThis as unknown as { db?: Db }

export const db =
  globalForPrisma.db ??
  postgres<Contract>({ contractJson, url: connectionString })

if (process.env.NODE_ENV !== 'production') globalForPrisma.db = db
