import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { prisma } from '../prisma/client.ts'

const app = new Hono()
app.get('/api/users', async (c) =>
  c.json(
    await prisma.user.findMany({
      select: { id: true, email: true, name: true, posts: true },
      orderBy: { id: 'asc' },
    }),
  ),
)

serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
})
