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

The checks install the actual tarball into clean temporary projects and exercise
both the retained Prisma 7 client path and the Prisma 8 contract path against
PostgreSQL 17+. The v8 checks pin `prisma@8.0.0-rc.17` and
`@prisma/orm-postgres@8.0.0-rc.12`; do not replace either with an unverified tag.
The CI matrix runs verification on Node 22 and 24. Node 22 runs package integration
with the NestJS and Hono examples, including Argon2 password verification and HTTP
responses. Node 24 runs all ten examples, using Bun 1.3.11 and Deno 2.9.6 for their
native servers. Together these checks cover relations, timeout rollback, protected
tables, CommonJS, ESM, TypeScript and the installed CLI.
Development-only overrides update Prisma CLI's transitive `deepmerge-ts` and
`mysql2` to patched releases. The real Prisma generation/database check validates
the configuration path; remove the overrides when Prisma adopts patched versions.

## Publish through GitHub Actions

Publishing a GitHub Release runs [publish.yml](.github/workflows/publish.yml). It
reuses the Node 22 and 24 checks above, then publishes to npm on Node 24. The
release tag must be `v<package.json version>`. A prerelease package version must
use a GitHub prerelease and publishes explicitly to npm `next`; a stable package
version must use a non-prerelease GitHub Release and publishes explicitly to npm
`latest`. Tag, package version and GitHub prerelease state must all agree.

The Prisma 8 release candidate is `1.0.0-rc.1`. A stable `1.x` release is blocked
while either the Prisma CLI or `@prisma/orm-postgres` development version is a
prerelease. Do not release `1.0.0` until stable Prisma 8 packages exist and this
migration has passed verification against those exact stable versions.

Only `dist`, the fixture JSON Schema, package metadata, README and license/notice
files are published. `prepack` builds JavaScript and declarations.

### Enable release preparation

Merge these workflows into the default branch before using **Prepare release**.
In repository **Settings → Actions → General → Workflow permissions**, enable
**Allow GitHub Actions to create and approve pull requests**. The preparation job
requests only the repository, pull request and Actions write permissions it needs
to create a release branch/PR and dispatch CI. It does not approve or merge PRs.

The release workflow uses the existing npm package and its trusted publisher
below. Version updates, tests, builds, packing, publication and registry smoke
tests run in GitHub Actions; no local npm commands are needed to release.

### Configure trusted publishing

In the npm package's **Settings → Trusted Publisher**, select **GitHub Actions**
and enter:

| Field                | Value               |
| -------------------- | ------------------- |
| Organization or user | `skmdev`            |
| Repository           | `prisma-fixtures`   |
| Workflow filename    | `publish.yml`       |
| Environment name     | Leave blank         |
| Allowed actions      | Allow `npm publish` |

Subsequent releases use [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
with OIDC, without an npm token secret. The workflow uses npm 11 and grants
`id-token: write` only to the publishing job. npm adds provenance automatically
when both the repository and package are public.

### Release a version

1. In GitHub Actions, run **Prepare release** and enter the unused version. For the
   first Prisma 8 candidate, enter `1.0.0-rc.1`. The action updates the root
   manifest and lockfile, every example dependency and every local tarball
   reference, then opens a release pull request.
2. Review that pull request and wait for its required Node 22 and 24 checks. Merge
   only the generated release changes whose checks pass.
3. Create a GitHub Release from the reviewed merge commit with the exact
   `v<version>` tag. Mark an RC as a prerelease and leave a stable release unmarked.
   A tag push alone does not publish to npm.
4. Publishing the GitHub Release starts **Publish to npm**. The workflow checks the
   tag, package version and GitHub prerelease state, runs the required test matrix,
   and publishes an RC to `next` or a stable release to `latest`.
5. Wait for the workflow to succeed and review its registry and dist-tag
   verification before announcing the release.

If a check fails, publishing is blocked. Fix the failure before releasing; an
already published npm version cannot be overwritten. Prepare a new version through
the action to correct a published release.
