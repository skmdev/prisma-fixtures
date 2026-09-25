# @skmdev/prisma-fixtures

Load YAML or JSON fixtures into Prisma using named references, generated data and
processors. The CLI can initialize a generated Prisma 7 client from your Prisma
config; the API also accepts a client you create.

```sh
npm install --save-dev @skmdev/prisma-fixtures
```

Requires Node.js 22.18+; tested with Prisma 7.10 and PostgreSQL. Prisma itself is
provided by your application, not installed as a runtime dependency of this package.

## Quick start

Create `fixtures/users.yml`:

```yaml
entity: User
items:
  user{1..3}:
    email: 'user($current)@example.test'
    name: '{{name.firstName}} {{name.lastName}}'
```

Create `fixtures/posts.yml`:

```yaml
entity: Post
connectedFields: [author]
items:
  post{1..3}:
    title: 'Post ($current)'
    author: '@user($current)'
```

With `prisma.config.ts` and a generated `prisma-client` in your project, run
`npx prisma-fixtures init` beside the Prisma config. It creates `.prisma-fixtures`
and a fixtures directory; add your YAML files there. The generated config is:

```json
{
  "fixtures": ["./fixtures"]
}
```

Add `migrations: { seed: 'prisma-fixtures' }` to your `prisma.config.ts`.
Set `DATABASE_URL`, then generate the client and load the fixtures:

```sh
npx prisma generate
npx prisma db seed
```

The CLI reads the Prisma config and loads both files in one transaction; no client
wrapper is needed. To clear and reload the database, run
`npx prisma db seed -- --reset`; this forwards `--reset` to the fixture CLI.
Programmatic use with your own client is covered under
[API and persistence](#api-and-persistence). CommonJS is supported with
`require('@skmdev/prisma-fixtures')`.

See the [framework and runtime examples](examples/README.md) for Next.js, Hono,
TanStack Start, NestJS, Astro, Nuxt, SvelteKit, Bun, Elysia and Deno. Each loads
users and related posts, hashes user passwords with an Argon2 processor, and
serves the seeded records through an API. NestJS demonstrates a CommonJS client.

## Fixture format

Each `.yml`, `.yaml` or `.json` file describes one entity. `User` and `user` both
resolve to the `user` delegate. Directory files are sorted; reference dependencies
determine insert order. Fixture names must be unique across all files.

| Feature                  | Example                          | Meaning                                                       |
| ------------------------ | -------------------------------- | ------------------------------------------------------------- |
| Inclusive range          | `user{1..10}`                    | Ten independent records                                       |
| Current index            | `user($current)@example.test`    | Numeric suffix of the expanded fixture name                   |
| Arithmetic               | `($current*100)`                 | One `+`, `-`, `*` or `/` operation with a nonnegative integer |
| Record reference         | `'@user1'`                       | The saved record                                              |
| Field reference          | `'@user1.id'`                    | An own field of the saved record                              |
| Random reference         | `'@user*'`                       | One existing name with that prefix and a numeric suffix       |
| Bounded random reference | `'@user{1..3}'`                  | One of user1, user2 or user3; all must exist                  |
| Literal `@`              | `'@@literal'`                    | Produces `@literal`                                           |
| Parameters               | `'<{names.admin}>'`              | A parameter from this document, converted to text             |
| Faker                    | `'{{internet.email}}'`           | Generated value; a standalone provider preserves its type     |
| EJS                      | `"<%= ['a', 'b'].join(', ') %>"` | JavaScript template rendered to text                          |

Quote references and template expressions in YAML. Arrays and nested objects are
supported. Random choices are selected once before dependency ordering. Missing
references and cycles fail before any insert. An absent scalar field can only be
detected after its referenced record has been saved; use a transaction for atomicity.

`connectedFields` converts a saved record into `{ connect: { id } }`, or an array
into `{ connect: [{ id }, ...] }`. Referenced models need an `id` field for this
shorthand. For other unique keys use Prisma's explicit nested input:

```yaml
entity: Post
items:
  post1:
    title: Example
    author:
      connect:
        email: '@user1.email'
```

For a nullable scalar link that cannot exist until another fixture is created,
declare `deferredFields`. The loader omits those fields on create, then updates
the saved rows after all creates in the same transaction:

Include an `@updatedAt` field in `deferredFields` when that update must retain a
specific fixture timestamp.

```yaml
entity: Candidate
deferredFields: [primaryResumeId]
items:
  candidate1:
    id: can_local_1
    primaryResumeId: rsu_local_1
```

Deferred fields require a saved `id`, a Prisma `update` delegate and the default
writer. Use a transaction so a failed update rolls back the earlier creates.

Parameters, locale and templates can be combined:

```yaml
entity: User
locale: en
parameters:
  names:
    admin: Administrator
items:
  admin1:
    email: admin@example.test
    name: '<{names.admin}> <%= name %>'
```

EJS receives the normalized fixture (`name`, `entity`, `data`, `parameters`, etc.).
Expansion order is current-index substitution, EJS, Faker, parameters, references,
processor, connections, then persistence. Parameters are local to their document.
`<{process.env.NAME}>` falls back to the environment when no explicit parameter
with that path exists; missing variables raise an error.

Faker 10 providers are supported, with aliases for the upstream README's
`name.firstName`, `name.lastName`, `name.title`, `internet.userName` and
`random.number`. For example, `{{random.number({"min": 1, "max": 10})}}` produces a
number. `{{date.past}}` produces a Date; composed strings preserve surrounding text.
Locale falls back to English. This is syntax compatibility, not identical random
output or complete emulation of every removed Faker API.

Pass `seed` and `refDate` to reproduce package-generated Faker values, relative
dates and random-reference choices:

```ts
await loadFixtures(prisma, definitions, {
  seed: 42,
  refDate: '2026-01-01T00:00:00.000Z',
})
```

`seed` is an integer from 0 through 4294967295. `refDate` must be a real canonical
UTC timestamp in `YYYY-MM-DDTHH:mm:ss.sssZ` form. Each load/reset owns its random
state; global Faker seeding does not affect it. Equal ordered inputs and options
reproduce package-generated values with the same package/Faker version. Fixture
order, hooks, environment values and database-generated IDs remain outside that
guarantee. An explicit Faker provider `refDate` argument overrides the operation
default.

## Processors

Set `processor: ./user-processor.mjs` in the fixture document. Paths are relative
to that document; extensionless paths such as `./user-processor` are also resolved.
A processor exports a default class with an optional sync or
async `preProcess(name, object)` hook:

```js
export default class UserProcessor {
  async preProcess(name, object) {
    return { ...object, email: object.email.toLowerCase() }
  }
}
```

CommonJS `module.exports = class ...` and `exports.default = class ...` work too.
Preloaded CommonJS hooks such as `ts-node/register` and `tsconfig-paths/register`
are honored, including their TypeScript and path-alias handling. Genuine ESM and
top-level-await modules fall back to native import. TypeScript processors can also
use Node's native type stripping for supported syntax (for example an ESM `.mts`
module). Native stripping does not convert ESM imports to CommonJS; match your
module extension/package configuration or compile your processor first. The hook
runs once per record after resolving references and before converting connections.
Return a plain object. No postProcess hook is defined by the upstream processor
contract.

## API and persistence

To load the paths in `.prisma-fixtures` without the CLI, use an existing Prisma
client (with its adapter already configured):

```ts
import { PrismaFixtures } from '@skmdev/prisma-fixtures'

const fixtures = new PrismaFixtures()
const records = await fixtures.load(prisma)
```

See the [runnable programmatic example](examples/hono/prisma/seed.mjs) and its
[setup instructions](examples/hono/README.md).

`load()` reads `.prisma-fixtures` from the current directory, applies its `seed`,
`refDate` and `timeout` settings, and loads in one transaction. The caller keeps
ownership of the client and disconnects it when finished. A configured `client`
module is ignored because the client is supplied; guarded client configs require
the CLI.

- `readFixtureDefinitions(path): FixtureDefinition[]` parses without executing
  templates, importing processors or accessing a database.
- `loadFixtures(client, definitions, options?, writer?): Promise<Record<string, Record<string, unknown>>>`
  validates and loads definitions. `options` accepts `seed` and `refDate`; passing
  the writer directly as the third argument remains supported. It accepts either
  a Prisma client or transaction client and does not disconnect it. Types
  `FixtureDefinition`, `FixtureLoadOptions`, `FixtureWriter` and `FixtureProcessor`
  are exported.
- The optional `writer(fixture, data)` returns the saved record and replaces the
  default `create({ data })`. Use it to implement application-specific upserts.
  When using a transaction, the writer must use that same transaction client.
- `cleanFixtures(client, options?)` clears PostgreSQL data, except exact
  `options.preserveTables` entries.
- `resetFixtures(client, definitions, options?, writer?)` clears the database,
  then loads the fixtures and returns the same record map as `loadFixtures`.
  `FixtureResetOptions` combines `seed`, `refDate` and `preserveTables`. Passing
  the writer as the third argument remains supported.
- Package-owned failures are `FixtureError` instances with a stable `code`, safe
  `stage`/source/fixture/path context and the original private `cause` for API
  callers. Opaque provider, hook and database messages are not copied into the
  safe message.

Default loading inserts records. Repeating a load can create duplicates or raise
unique-constraint errors. Cleaning and resetting are explicit operations; normal
loading never deletes or automatically upserts. All three functions accept a
client or transaction client and leave transaction/disconnection ownership to you.
Use a transaction to prevent a failed reset from leaving data deleted:

```ts
import { resetFixtures } from '@skmdev/prisma-fixtures'

const records = await prisma.$transaction(
  (tx) =>
    resetFixtures(tx, definitions, {
      preserveTables: ['public.audit_log'],
    }),
  { timeout: 60_000 },
)
```

Cleanup currently supports **PostgreSQL only** and requires `$executeRawUnsafe`.
It truncates all ordinary/partitioned tables across all non-system schemas in the
connected database, including implicit join tables. Tables, schema, indexes,
constraints, sequence values and `_prisma_migrations` records are preserved.
Each `preserveTables` entry names one existing table as `schema.table`;
its data and sequence state are also preserved. Unknown tables and
duplicate or malformed entries fail before truncation.
Foreign tables and materialized views are outside this cleanup scope.
Cleanup refuses inherited/partitioned structures with excluded descendants, so
truncating a parent cannot reach a preserved table, remote table or migration
history, and truncating a child cannot change rows visible through a preserved
ancestor. `RESTRICT` also makes a foreign key from a preserved table to a cleaned
table fail the cleanup instead of cascading or bypassing triggers.
The database user needs `TRUNCATE` privileges on every included table.

Cleanup needs no fixture definitions and executes no templates or processors.
Reset prepares templates and random references once and validates the load before
clearing data; an empty definition list still clears the database. Generated
values may change on each reset unless fixed generation options are supplied.
PostgreSQL's
[`TRUNCATE`](https://www.postgresql.org/docs/current/sql-truncate.html) runs
transactionally, fires `ON TRUNCATE` triggers and does not fire `ON DELETE` triggers.

Without a caller-owned transaction, an error can leave earlier deletes or inserts
applied. Rollback cannot undo external side effects in templates or processors.

## CLI

Run `npx prisma-fixtures init` beside your `prisma.config.ts` to create the
minimal config and fixtures directory. It uses an existing `prisma/fixtures`
directory when present, otherwise `fixtures`, and never overwrites an existing
`.prisma-fixtures`. The generated config is:

```json
{
  "fixtures": ["./fixtures"]
}
```

To reuse an existing fixture directory, pass its relative path, for example
`npx prisma-fixtures init ../shared/fixtures`. The directory must already exist.

Set `DATABASE_URL`, run `npx prisma generate`, then `npx prisma-fixtures`. The CLI
reads the adjacent Prisma config for its schema and datasource, finds the
`prisma-client` generator output, and uses your installed PostgreSQL adapter. A
CommonJS TypeScript client uses the compiled path specified by a `tsconfig.json`
with `rootDir` and `outDir` when it exists. Otherwise the CLI automatically
registers the project's installed `ts-node` for an inferred `.ts` or `.cts`
client. No client wrapper is needed. Use `--require` for additional processor
hooks or path aliases.

```sh
npx prisma-fixtures ./fixtures --list
npx prisma-fixtures --clean
npx prisma-fixtures --reset
npx prisma-fixtures --seed 42 --refDate 2026-01-01T00:00:00.000Z
npx prisma-fixtures --help
```

Other options can go in the same file:

```json
{
  "fixtures": ["./fixtures"],
  "timeout": 60000,
  "seed": 42,
  "refDate": "2026-01-01T00:00:00.000Z",
  "preserveTables": ["public.audit_log"]
}
```

```sh
npx prisma-fixtures
npx prisma-fixtures --list
npx prisma-fixtures --config ./test/.prisma-fixtures
```

The config accepts `fixtures` (a nonempty array of paths), optional `client` (an
explicit generated client module plus `pg` adapter, or a legacy client module path),
`timeout` (a positive integer in milliseconds), `schema` (a JSON Schema
path used by `--lint`), `seed`, `refDate` and `preserveTables` (an array of exact
`schema.table` strings used only by `--clean` and `--reset`).
When `client` is omitted, `--clean` and `--reset` also preserve the PostgreSQL
tables listed in Prisma's `tables.external` (with
`experimental.externalTables` enabled). These `schema.table` entries are combined
with any explicit `preserveTables` entries. For example,
`tables: { external: ['public.flyway_schema_history'] }` in `prisma.config.ts`
preserves that table without repeating it in `.prisma-fixtures`. Direct API calls
still use only the options passed to them. Unknown fields are rejected.

Config paths are relative to the config file;
positional paths and matching CLI flags override config values field by field.
Paths passed on the command line are relative to the working directory.
Automatic discovery checks only the current directory. `--config` selects a
different file and fails if it is missing. `--help` and `--version` skip config
loading; `--list` only parses the JSON and fixture documents.

To run through Prisma, add its supported
[`migrations.seed`](https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference)
option to your existing `prisma.config.ts`:

```ts
export default defineConfig({
  // Keep your existing schema, datasource and other settings.
  migrations: { seed: 'prisma-fixtures' },
})
```

Run `npx prisma db seed` to load or `npx prisma db seed -- --reset` to clear and
reload from your project directory. Reset removes data from tables not preserved
by `preserveTables` or Prisma's `tables.external`. The fixture CLI loads
Prisma's config only for write commands when `client` is omitted. It resolves the
generated client from a static `prisma-client` output path in the configured
schema. Use an explicit `client` for custom generation or runtime setups.

The inferred client uses Prisma's datasource URL, then `DATABASE_URL` from the
environment if the config omits it. `--databaseUrl` overrides both. Keep
credentials out of the JSON config and shell history. The CLI does not
independently load `.env` files; a `prisma.config.ts` import of `dotenv/config`
works when Prisma loads that config. Otherwise use `--require dotenv/config`.
For
application-specific safety checks, `client.guard` may name a module exporting
`fixtureDatabaseUrl(env)` and `fixtureTransaction(client, action, timeout)`.
Those functions validate the connection before client creation and wrap writes
in the application's transaction guard. The legacy string form may export a
client or factory; `--databaseUrl` requires a factory in that form. `--client`
overrides either configured form with a legacy module path.

The CLI wraps writes in one transaction (60-second timeout; override with
`--timeout <ms>`) and always disconnects a successfully acquired valid client.
`--require <module>` may be repeated to preload hooks such as `ts-node/register`;
modules resolve from the working directory. `--list` and `--lint` skip all hooks and client
imports. `--version`/`-v`, `--help`/`-h`, `--debug`/`-d` and `--no-color` are supported.
Multiple positional paths are combined into one load and one transaction.
`--clean` clears database data without loading or reading fixture files; `--reset`
clears database data and reloads fixtures in the same transaction. Both clear all
non-system tables not named by `preserveTables`, including those absent from the
fixture files, while preserving schema and migration history. Ordinary loading
does not apply the preserve list or delete data. These two modes currently
support PostgreSQL only.
Use only one of `--clean`, `--reset`, `--list` and `--lint` at a time. Destructive
modes must be requested on the command line and cannot be saved in config.
Package diagnostics include a stable code and available filename, fixture name
and JSON Pointer field path. Output is escaped, bounded and omits fixture values,
URLs and opaque provider/client messages, including with `--debug`. API callers
can inspect a `FixtureError` cause in their own diagnostic harness.

## Fixture linting and editor support

```sh
npx prisma-fixtures --lint
npx prisma-fixtures ./fixtures --lint
npx prisma-fixtures --config ./test/.prisma-fixtures --lint
```

Lint works without a client or database. It checks YAML/JSON syntax, duplicate
keys, allowed metadata, fixture shapes/names, ranges, current-index expressions,
duplicate fixture names across files and input limits. It also validates literal
fixed, wildcard and bounded references after combining all selected paths, and
rejects definite self/cross-file dependency cycles. A successful check exits
with code 0; the first error exits with code 1. YAML syntax diagnostics include
the filename, line/column and parser error code without printing fixture values.
`--lint` and `--list` are separate modes; use one at a time.

Lint does not execute templates, Faker, environment substitutions, processors,
preloads or random selection. Dynamic strings and references with several valid
candidates are counted as unresolved without failing lint or being added as
definite graph edges; a sole random candidate is a definite edge. Saved-record
field presence, rendered types, arbitrary hook behavior and database constraints
remain runtime checks. Formatting is separate: use your existing YAML formatter,
such as Prettier.

### Generate a schema from your Prisma models

Add a generator to `prisma/schema.prisma`:

```prisma
generator fixtures {
  provider = "prisma-fixtures-generator"
  output   = "../generated/fixtures"
}
```

Run `npx prisma generate`. This creates `generated/fixtures/schema.json` from
Prisma's model and create-input metadata. Output paths are relative to
`schema.prisma`; regenerate after changing your models. No database connection
is needed for this generator.

Use the same schema for CLI lint by adding `schema` to `.prisma-fixtures`:

```json
{
  "fixtures": ["./fixtures"],
  "schema": "./generated/fixtures/schema.json"
}
```

Or pass it explicitly:

```sh
npx prisma-fixtures ./fixtures --lint --schema ./generated/fixtures/schema.json
```

The generated schema selects fields by `entity`, accepts model and delegate
names, and checks known fields, scalar types, enums, nullability, lists and
required create inputs. Both nested relation inputs and direct foreign keys are
supported. References, Faker, EJS and parameter expressions remain dynamic
strings; their evaluated types are checked when loading. References and records
with an `id` (including arrays) are allowed for `connectedFields` shorthand.

Documents with a `processor` skip model item validation because the processor
may add, remove or transform fields; their fixture structure is still checked.
The schema does not reproduce every Prisma runtime rule: native database type
limits, DateTime/Decimal/Bytes conversions, relation-shorthand correctness,
uniqueness and reference targets still need runtime validation.

### Editor setup

The schema comment is optional. Configure a file association once, or use a
comment in each fixture; you do not need both. For
[VS Code's Red Hat YAML extension](https://github.com/redhat-developer/vscode-yaml),
add this to `.vscode/settings.json` in your application:

```json
{
  "yaml.schemas": {
    "./generated/fixtures/schema.json": [
      "fixtures/**/*.yml",
      "fixtures/**/*.yaml"
    ]
  }
}
```

Or add a schema comment to each YAML file, with a path relative to that file:

```yaml
# yaml-language-server: $schema=../generated/fixtures/schema.json
entity: User
items:
  user1:
    email: user1@example.test
```

If you only need generic fixture metadata checks, the package also includes
`schema/fixture.schema.json`, exported as `@skmdev/prisma-fixtures/schema.json`.
Point your editor at `node_modules/@skmdev/prisma-fixtures/schema/fixture.schema.json`
to use it without generation.

The editor schema cannot check cross-file names, the literal dependency graph or
runtime behavior; run `--lint` in CI as well. This repository's `npm run verify`
includes `npm run lint:fixtures` for the example fixtures.

## Trust and limits

Load trusted fixtures only. EJS, processors, preloads and client modules execute
JavaScript with your process permissions; parsing limits do not sandbox code.
The parser rejects prototype keys, duplicate names/keys and YAML aliases. Limits:
100 fixture files, 1 MiB per file, 2,000 expanded records, depth 32 and 50,000
visited nodes per validated value. No fixture values are logged by the engine.

## Compatibility and attribution

The fixture language follows
[getbigger-io/prisma-fixtures](https://github.com/getbigger-io/prisma-fixtures),
with modern client injection and validation. This new package does not expose the
old `Loader`, `Builder`, `Parser`, `Resolver` or `fixturesIterator` class API, or
instantiate an implicit Prisma client. Replace that setup with the functions
above. MIT; see [LICENSE](LICENSE) and retained upstream attribution in [NOTICE](NOTICE).

## Develop and prepare a release

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
