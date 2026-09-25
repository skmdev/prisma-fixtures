import { prisma } from '../../../prisma/client'

export async function GET() {
  return Response.json(
    await prisma.user.findMany({
      select: { id: true, email: true, name: true, posts: true },
      orderBy: { id: 'asc' },
    }),
  )
}
