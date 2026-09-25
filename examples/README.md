# Framework and runtime examples

Each directory is a standalone application with its own dependencies, Prisma
schema, fixture configuration and YAML files. All examples load three `User`
records and three `Post` records. An async Argon2id processor hashes the sample
`User.password` before persistence; `GET /api/users` returns users and their posts
without exposing passwords.

| Example                                    | Integration                                            |
| ------------------------------------------ | ------------------------------------------------------ |
| [Next.js](nextjs/README.md)                | App Router route handler                               |
| [Hono](hono/README.md)                     | Hono on Node.js                                        |
| [TanStack Start](tanstack-start/README.md) | TanStack Start server route                            |
| [NestJS](nestjs/README.md)                 | Nest controller with a compiled CommonJS Prisma client |
| [Astro](astro/README.md)                   | Astro server endpoint with the Node adapter            |
| [Nuxt](nuxt/README.md)                     | Nuxt server API route                                  |
| [SvelteKit](sveltekit/README.md)           | SvelteKit server route with adapter-node               |
| [Bun](bun/README.md)                       | Bun.serve native HTTP server                           |
| [Elysia](elysia/README.md)                 | Elysia running on Bun                                  |
| [Deno](deno/README.md)                     | Deno.serve native HTTP server                          |

Use Node.js 22.19+ or 24.11+ and PostgreSQL. Bun/Elysia also need Bun 1.3+; Deno
needs Deno 2. All examples use the Node.js Prisma and fixture CLI for seeding.
Run one example at a time with a fresh database. Each README has its own startup
commands and points to the framework's API handler.

Prisma source files are grouped under `prisma/`, with one schema file per model.
Generated clients and fixture schemas live under `src/generated/`:

```text
prisma/
  schema/
    00_base.prisma
    user.prisma
    post.prisma
  fixtures/
    users.yml
    posts.yml
    processors/
      user-processor.mjs
  client.ts              # client.server.ts in TanStack Start and SvelteKit
  seed.mjs               # Hono's additional programmatic loading example
src/generated/          # Created by prisma generate
  prisma/
  prisma-fixtures/
prisma.config.ts         # Root config for Prisma's automatic discovery
.prisma-fixtures         # Points to ./prisma/fixtures
```

## Start PostgreSQL

From your chosen example directory, start a disposable database:

```sh
docker run --rm --detach --name prisma-fixtures-example \
  --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=fixture_example \
  --env POSTGRES_PASSWORD=fixture_example \
  --env POSTGRES_DB=fixture_example \
  postgres:17.9-alpine

export DATABASE_URL="postgresql://fixture_example:fixture_example@$(docker port prisma-fixtures-example 5432/tcp)/fixture_example"

docker exec prisma-fixtures-example pg_isready -U fixture_example
```

Wait until PostgreSQL reports `accepting connections`, then follow the chosen
example's README in the same shell. The credentials above are public and only
for this disposable database. `db:reset` clears its data before loading fixtures;
use a separate database for each example if running several at once.

## Use the local package

To try unpublished changes from this checkout, build and pack at the repository
root:

```sh
npm ci
npm pack
```

Then, from your chosen `examples/<name>` directory, replace the README's
`npm install` with:

```sh
npm install --no-save ../../skmdev-prisma-fixtures-0.1.0.tgz
```

This installs the example's dependencies and the local fixture package. Continue
with `db:generate`, `db:push` and `db:seed` (NestJS also builds before seeding).
The examples do not require workspace links or dependencies from sibling examples.

## Verification

From the repository root:

```sh
npm run lint:fixtures     # Generate and lint fixtures for all ten examples
npm run test:integration # Package integration plus NestJS and Hono
npm run test:examples    # All ten; Docker, Bun and Deno required
```

The integration checks install the packed package in temporary standalone
projects, generate clients, build the apps, seed an isolated PostgreSQL database,
verify Argon2 hashes and user/post relations, and exercise the real HTTP endpoints.
They also check duplicate-seed rollback, reset, the programmatic API in Hono, and
external-table preservation in NestJS. They remove their database container and
temporary files afterwards.

## Clean up

Stop the app, then remove the disposable database:

```sh
docker stop prisma-fixtures-example
unset DATABASE_URL
```

The container has no persistent volume; stopping it discards the example data.
