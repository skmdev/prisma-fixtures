import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { db } from '../prisma/client.ts'

const app = new Hono()
app.get('/api/users', async (c) =>
  c.json(
    await db.orm.public.User.include('posts')
      .select('id', 'email', 'name')
      .orderBy((user) => user.id.asc())
      .all(),
  ),
)

serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
})
