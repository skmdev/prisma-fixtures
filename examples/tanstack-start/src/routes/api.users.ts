import { createFileRoute } from '@tanstack/react-router'
import { db } from '../../prisma/client.server'

export const Route = createFileRoute('/api/users')({
  server: {
    handlers: {
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
