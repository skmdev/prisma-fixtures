import { createFileRoute } from '@tanstack/react-router'
import { prisma } from '../../prisma/client.server'

export const Route = createFileRoute('/api/users')({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          await prisma.user.findMany({
            select: { id: true, email: true, name: true, posts: true },
            orderBy: { id: 'asc' },
          }),
        ),
    },
  },
})
