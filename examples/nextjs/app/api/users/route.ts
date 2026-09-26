import { db } from '../../../prisma/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json(
    await db.orm.public.User.include('posts')
      .select('id', 'email', 'name')
      .orderBy((user) => user.id.asc())
      .all(),
  )
}
