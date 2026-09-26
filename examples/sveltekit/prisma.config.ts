import { defineConfig, prisma7Schema } from '@prisma/orm-postgres/config'
import { definePrismaConfig } from 'prisma/config'

export default definePrismaConfig({
  orm: defineConfig({
    contract: prisma7Schema('./prisma/schema'),
    output: './src/generated/prisma',
    db: { connection: process.env.DATABASE_URL },
  }),
})
