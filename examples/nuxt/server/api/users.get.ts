import { prisma } from '../../prisma/client'

export default defineEventHandler(() =>
  prisma.user.findMany({
    select: { id: true, email: true, name: true, posts: true },
    orderBy: { id: 'asc' },
  }),
)
