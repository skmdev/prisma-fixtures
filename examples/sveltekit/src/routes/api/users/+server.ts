import { json } from '@sveltejs/kit'
import { prisma } from '../../../../prisma/client.server'

export async function GET() {
  return json(
    await prisma.user.findMany({
      select: { id: true, email: true, name: true, posts: true },
      orderBy: { id: 'asc' },
    }),
  )
}
