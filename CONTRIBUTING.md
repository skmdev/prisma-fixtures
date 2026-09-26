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

## Publish through GitHub Actions

Publishing a stable GitHub Release runs
[publish.yml](.github/workflows/publish.yml). It reuses the full CI checks on
Node 22 and 24, then publishes to npm on Node 24. The release tag must be
`v<package.json version>`, such as `v0.1.0`. Drafts and prereleases do not publish;
versions must use the stable `major.minor.patch` format.

Only `dist`, the fixture JSON Schema, package metadata, README and license/notice
files are published. `prepack` builds JavaScript and declarations.

### First publish

Push this repository, including both workflows, to `skmdev/prisma-fixtures` on
GitHub before creating the release tag. The repository URL in `package.json`
must match the GitHub repository used to publish.

If the npm package does not exist yet, create it with the first workflow run:

1. Sign in to the npm account with publish access to the `@skmdev` scope.
2. Create a short-lived [granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens/)
   with **Read and write (publish and stage)** access to the `@skmdev` scope and
   **Bypass two-factor authentication** enabled.
3. Add it as the GitHub repository Actions secret **NPM_TOKEN** under
   **Settings → Secrets and variables → Actions**.
4. Follow the release steps below using the version in `package.json`.
5. Once the package exists, configure trusted publishing below, delete the
   GitHub `NPM_TOKEN` secret and revoke the temporary token in npm.

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

1. Choose an unused version. For the first release, keep the version in `package.json`;
   for later releases, run `npm version patch`, `minor` or `major` from a clean
   working tree. This updates both package manifests and creates a commit and tag.
2. Run the development checks above and inspect `npm publish --dry-run`.
3. Push the release commit and its `v<version>` tag. For the first release, create
   the matching `v<version>` tag after committing the workflow changes.
4. On GitHub, create and publish a Release using that tag. The tag's commit must
   contain both workflows. A tag push alone does not publish to npm.
5. Wait for **Publish to npm** to succeed, then check
   `npm view @skmdev/prisma-fixtures@<version> version` and install that version in
   a consumer project.

If a check fails, publishing is blocked. Fix the failure before releasing; an
already published npm version cannot be overwritten. Ship a new patch version
to correct a published release.
