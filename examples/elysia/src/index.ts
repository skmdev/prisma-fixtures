import { Elysia } from 'elysia'
import { db } from '../prisma/client.ts'

new Elysia()
  .get('/api/users', () =>
    db.orm.public.User.include('posts')
      .select('id', 'email', 'name')
      .orderBy((user) => user.id.asc())
      .all(),
  )
  .listen({ hostname: '127.0.0.1', port: Number(process.env.PORT ?? 3000) })
