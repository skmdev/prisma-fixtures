import { db } from '../prisma/client.ts'

Deno.serve(
  { hostname: '127.0.0.1', port: Number(Deno.env.get('PORT') ?? 3000) },
  async (request) => {
    if (new URL(request.url).pathname !== '/api/users') {
      return new Response('Not found', { status: 404 })
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET' },
      })
    }
    return Response.json(
      await db.orm.public.User.include('posts')
        .select('id', 'email', 'name')
        .orderBy((user) => user.id.asc())
        .all(),
    )
  },
)
