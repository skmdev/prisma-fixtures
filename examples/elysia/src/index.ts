import { Elysia } from 'elysia'
import { prisma } from '../prisma/client.ts'

new Elysia()
  .get('/api/users', () =>
    prisma.user.findMany({
      select: { id: true, email: true, name: true, posts: true },
      orderBy: { id: 'asc' },
    }),
  )
  .listen({ hostname: '127.0.0.1', port: Number(process.env.PORT ?? 3000) })
