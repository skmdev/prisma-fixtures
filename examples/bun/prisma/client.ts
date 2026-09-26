import postgres from '@prisma/orm-postgres/runtime'
import type { Contract } from '../src/generated/prisma/contract.d'
import contractJson from '../src/generated/prisma/contract.json' with { type: 'json' }

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is required')

export const db = postgres<Contract>({ contractJson, url: connectionString })
