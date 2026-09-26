# Elysia

A minimal Elysia running on Bun. Loads three users and three related posts,
and hashes each `User.password` with an async Argon2id fixture processor.

## Run

Requires Node.js 22.18+ and PostgreSQL 17+.
Also install Bun 1.3+.
Start a [disposable database](../README.md#start-postgresql) and export
`DATABASE_URL` in this shell. From this directory:

```sh
# First build the local tarball as described in ../README.md
npm install --no-save ../../skmdev-prisma-fixtures-1.0.0-rc.1.tgz
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

In another terminal:

```sh
curl http://127.0.0.1:3000/api/users
```

The [API handler](src/index.ts) returns three users, each with one post. It selects
`id`, `email`, `name` and `posts`, so password hashes never enter the response.
The [`User` and `Post` models](prisma/schema) use a required author relation.

## Fixtures and password processor

[users.yml](prisma/fixtures/users.yml) declares `processor: ./processors/user-processor.mjs`:

```yaml
entity: User
processor: ./processors/user-processor.mjs
items:
  user{1..3}:
    email: 'user($current)@example.test'
    name: '{{person.firstName}} {{person.lastName}}'
    password: fixture-password
```

The [processor](prisma/fixtures/processors/user-processor.mjs) hashes the demonstration password
before each insert:

```js
import { argon2id, hash } from 'argon2'

export default class UserProcessor {
  async preProcess(_name, user) {
    return { ...user, password: await hash(user.password, { type: argon2id }) }
  }
}
```

`fixture-password` is public sample data. Stored passwords use salted Argon2id
hashes; use `argon2.verify(storedHash, 'fixture-password')` to verify them.
[posts.yml](prisma/fixtures/posts.yml) connects `post{1..3}` to `@user($current)` via
`connectedFields: [author]`. The loader creates users first, even though
`posts.yml` sorts before `users.yml`, and commits all six records atomically.

```sh
npm run lint:fixtures  # Generate the fixture schema and lint without a database
npm run db:reset       # Clear this example database and reload six fixtures
```

A second ordinary seed fails on unique emails; reset explicitly when reloading.
Lint checks structure and references without running the password processor.
The emitted Prisma 8 contract and fixture JSON Schema live in `src/generated/`.

The API runs on Bun 1.3+. Dependency installation, Prisma generation and fixture
loading use Node.js/npm, including the native `argon2` processor. Keep both
runtimes installed; the API does not load fixtures during startup.

See the [Elysia documentation](https://elysiajs.com/quick-start) and
[Argon2 documentation](https://github.com/ranisalt/node-argon2).
