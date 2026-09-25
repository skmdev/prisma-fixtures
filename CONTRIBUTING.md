# Contributing and releases

## Development checks

Run from the repository root:

```sh
npm ci
npm run verify
npm run test:integration # Docker required; owns and removes a disposable Postgres
npm audit --omit=dev
npm pack --dry-run
```

The integration check installs the actual tarball into a clean temporary project,
generates Prisma 7 clients, checks relations and rollback against PostgreSQL, and
exercises CommonJS, ESM, TypeScript, the installed CLI, and the NestJS/Hono examples
including Argon2 password verification and HTTP responses. CI runs on Node 22 and 24.
Run `npm run test:examples` with Bun and Deno also on `PATH` to install, build,
seed and check all ten framework/runtime examples in temporary directories.
Development-only overrides update Prisma CLI's transitive `deepmerge-ts` and
`mysql2` to patched releases. The real Prisma generation/database check validates
the configuration path; remove the overrides when Prisma adopts patched versions.

## Prepare a release

When ready to publish, authenticate to the npm account that owns the `@skmdev`
scope, choose the release version, rerun the checks above and inspect the tarball:

```sh
npm login
npm whoami
npm publish --dry-run
npm publish --access public
```

Only `dist`, the fixture JSON Schema, package metadata, README and license/notice files are published.
`prepack` builds JavaScript and declarations. Publication and GitHub pushes are
manual; nothing publishes automatically from this repository.
