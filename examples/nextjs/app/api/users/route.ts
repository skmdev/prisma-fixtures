import { prisma } from '../../../prisma/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json(
    await prisma.user.findMany({
      select: { id: true, email: true, name: true, posts: true },
      orderBy: { id: 'asc' },
    }),
  )
}
