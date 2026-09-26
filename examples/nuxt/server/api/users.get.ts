import { db } from '../../prisma/client'

export default defineEventHandler(() =>
  db.orm.public.User.include('posts')
    .select('id', 'email', 'name')
    .orderBy((user) => user.id.asc())
    .all(),
)
