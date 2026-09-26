import { json } from '@sveltejs/kit'
import { db } from '../../../../prisma/client.server'

export async function GET() {
  return json(
    await db.orm.public.User.include('posts')
      .select('id', 'email', 'name')
      .orderBy((user) => user.id.asc())
      .all(),
  )
}
