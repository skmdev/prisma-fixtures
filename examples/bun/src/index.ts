import { db } from '../prisma/client.ts'

Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  routes: {
    '/api/users': {
      GET: async () =>
        Response.json(
          await db.orm.public.User.include('posts')
            .select('id', 'email', 'name')
            .orderBy((user) => user.id.asc())
            .all(),
        ),
    },
  },
})
