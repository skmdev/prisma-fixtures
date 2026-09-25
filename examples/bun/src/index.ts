import { prisma } from '../prisma/client.ts'

Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  routes: {
    '/api/users': {
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
