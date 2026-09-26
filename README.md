# @skmdev/prisma-fixtures

Load YAML or JSON fixtures into Prisma using named references, generated data and
processors. The CLI supports generated Prisma 7 clients and emitted Prisma 8
contracts; the API also accepts a client you create.

Requires Node.js 22.18+. The retained path uses Prisma 7.10; the Prisma 8 release
candidate targets `prisma@8.0.0-rc.17`,
`@prisma/orm-postgres@8.0.0-rc.12` and PostgreSQL 17+. Prisma itself is provided
by your application, not installed as a runtime dependency of this package.
Install `@skmdev/prisma-fixtures@1.0.0-rc.1` after it is published to npm `next`,
or test it before publication through the local tarball workflow below.

- [Prisma 7 quick start](#prisma-7-quick-start)
- [Prisma 8 migration preview](#prisma-8-migration-preview)
- [Fixture format](#fixture-format)
- [Processors](#processors)
- [API and persistence](#api-and-persistence)
- [CLI](#cli)
- [Fixture linting and editor support](#fixture-linting-and-editor-support)
- [Trust and limits](#trust-and-limits)
- [Compatibility and attribution](#compatibility-and-attribution)
- [Contributing and releases](CONTRIBUTING.md)

## Prisma 7 quick start

Start with an existing Prisma 7 application that has:

- `prisma`, `@prisma/client` and `@prisma/adapter-pg` installed.
- A `prisma.config.ts`, a `prisma-client` generator and a PostgreSQL database
  configured through `DATABASE_URL`. See [client discovery](#client-discovery-and-overrides)
  for TypeScript and CommonJS runtime setup.
- `User` and `Post` models compatible with the following fields, with their
  tables already created by your application's migrations. Fixtures insert data;
  they do not create tables.

<details>
<summary>Minimal User and Post models</summary>

```prisma
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  name  String
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}
```

</details>

### 1. Install and initialize

Run beside your `prisma.config.ts`:

```sh
npm install --save-dev @skmdev/prisma-fixtures
npx prisma-fixtures init
```

This creates `.prisma-fixtures` and a fixtures directory. It uses `prisma/fixtures`
if that directory already exists; otherwise it creates `fixtures`. The examples
below assume the latter, with this generated config:

```json
{
  "fixtures": ["./fixtures"]
}
```

### 2. Add fixtures

Use the directory recorded in `.prisma-fixtures` for both files.
Create `fixtures/users.yml`:

```yaml
entity: User
items:
  user{1..3}:
    email: 'user($current)@example.test'
    name: '{{person.firstName}} {{person.lastName}}'
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

### 3. Configure and run the seed

Add `seed` to `migrations` in your existing `prisma.config.ts`, keeping your other
settings:

```ts
export default defineConfig({
  // Keep your existing schema, datasource and other settings.
  migrations: { seed: 'prisma-fixtures' },
})
```

With `DATABASE_URL` available, generate the client, check the fixtures and seed:

```sh
npx prisma generate
npx prisma-fixtures --lint
npx prisma db seed
```

The CLI prints `Loaded 6 fixtures.`: three users, each with one related post,
committed in one transaction. It reads your Prisma config; no client wrapper is
needed. For loading from application code, see [API and persistence](#api-and-persistence).

Ordinary loading only inserts; it does not upsert or delete. Running this example
again fails on the unique emails. To clear and reload, use
`npx prisma db seed -- --reset`. **Reset clears data from all ordinary/partitioned
tables in non-system schemas, including tables absent from your fixtures.**
Migration history and tables preserved by `preserveTables` or Prisma's
`tables.external` remain; see [cleanup and reset](#cleanup-and-reset).

See the [framework and runtime examples](examples/README.md) for standalone apps
with Argon2 password processors and API endpoints. NestJS demonstrates a CommonJS client.

## Prisma 8 migration preview

Prisma 8 support in this checkout uses separately versioned release candidates:

```sh
npm install @prisma/orm-postgres@8.0.0-rc.12
npm install --save-dev prisma@8.0.0-rc.17
```

After the fixture RC is published, install its exact version:

```sh
npm install --save-dev @skmdev/prisma-fixtures@1.0.0-rc.1
```

`npm install --save-dev @skmdev/prisma-fixtures@next` discovers the current
prerelease, while the exact version gives reproducible installs. Before
`1.0.0-rc.1` is published, build the fixture package from this repository. Its
baseline package version, and therefore the tarball name, remains `0.1.1` until
the Prepare release action creates the version-bump pull request:

```sh
# In this repository
npm ci
npm pack

# In the Prisma application
npm install --no-save /path/to/skmdev-prisma-fixtures-0.1.1.tgz
```

An existing multi-file Prisma 7 schema can be the source for an emitted Prisma 8
contract. Configure `prisma.config.ts`:

```ts
import { defineConfig, prisma7Schema } from '@prisma/orm-postgres/config'
import { definePrismaConfig } from 'prisma/config'

export default definePrismaConfig({
  orm: defineConfig({
    contract: prisma7Schema('./prisma/schema'),
    output: './src/generated/prisma',
    db: { connection: process.env.DATABASE_URL },
  }),
})
```

Emit `contract.json` and `contract.d.ts`, then derive the fixture JSON Schema
offline from that contract:

```sh
npx prisma contract emit
npx prisma-fixtures-generator src/generated/prisma/contract.json src/generated/prisma-fixtures
npx prisma-fixtures --lint --schema src/generated/prisma-fixtures/schema.json
```

After creating the database schema with `prisma db init` or your migration
workflow, load or reset fixtures directly:

```sh
npx prisma-fixtures
npx prisma-fixtures --reset
```

With no `client` in `.prisma-fixtures`, the CLI reads the v8 config, loads the
emitted contract and constructs the PostgreSQL fixture adapter. To select it
explicitly, point the existing configured-client shape at `contract.json`:

```json
{
  "fixtures": ["./fixtures"],
  "client": {
    "module": "./src/generated/prisma/contract.json",
    "adapter": "pg"
  }
}
```

Application routes should use the native Prisma 8 `db.orm` API. Only fixture
loading needs the compatibility bridge:

```ts
import postgres from '@prisma/orm-postgres/runtime'
import {
  createPrisma8FixtureClient,
  PrismaFixtures,
} from '@skmdev/prisma-fixtures'
import type { Contract } from './src/generated/prisma/contract.js'
import contractJson from './src/generated/prisma/contract.json' with { type: 'json' }

const db = postgres<Contract>({
  contractJson,
  url: process.env.DATABASE_URL!,
})
const client = createPrisma8FixtureClient(db)

try {
  await new PrismaFixtures().load(client)
} finally {
  await client.$disconnect()
}
```

`createPrisma8FixtureClient(db)` exposes the legacy fixture-facing delegates,
`$transaction` and `$disconnect` on top of the native v8 client. Prisma 8 fixture
transactions set PostgreSQL's `transaction_timeout`, so this path requires
PostgreSQL 17 or newer and retains rollback when the configured timeout expires.
Enable TypeScript's `resolveJsonModule`; use `contract.js` with NodeNext ESM or
`contract.d` with bundler module resolution for the generated `Contract` type.

The v8 bridge decodes scalar fixture values with the contract's PostgreSQL codecs,
including nested creates, connections and scalar lists. Quote large integers and
decimals to preserve precision; use base64 strings for binary fields. JSON fields
remain JSON. Dates use the emitted codec's ISO format: `Temporal.Instant` takes
a timezone such as `2026-01-02T03:04:05Z`, while `Temporal.PlainDateTime` takes
`2026-01-02T03:04:05` without a timezone. Processors can also supply the codec's
native values directly.

If your contract uses Temporal codecs and your runtime has no `Temporal`, install
the application's polyfill and preload it before constructing the client:

```sh
npm install temporal-polyfill@1.0.5
npx prisma-fixtures --require temporal-polyfill/full/global
```

For programmatic loading, use `import 'temporal-polyfill/full/global'` before
creating `db`. The fixture package does not install a global polyfill itself.

## Fixture format

Each `.yml`, `.yaml` or `.json` file describes one entity. Prisma 8 accepts
namespace-qualified entities such as `public.User`; `User` and `user` are also
available when that model name is unambiguous across namespaces. Prisma 7 resolves
`User` and `user` to the `user` delegate. Directory files are sorted; reference
dependencies determine insert order. Fixture names must be unique across all files.

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

### References and relations

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

### Deferred fields

For a nullable scalar link that cannot exist until another fixture is created,
declare `deferredFields`. The loader omits those fields on create, then updates
the saved rows after all creates. For example, a candidate's optional primary
resume points to a resume that requires the candidate to exist first:

```yaml
# fixtures/candidates.yml
entity: Candidate
deferredFields: [primaryResumeId]
items:
  candidate1:
    id: can_local_1
    primaryResumeId: rsu_local_1
```

```yaml
# fixtures/resumes.yml
entity: Resume
items:
  resume1:
    id: rsu_local_1
    candidateId: '@candidate1.id'
```

The loader creates `candidate1` without `primaryResumeId`, creates `resume1`, then
sets the candidate's primary resume. Use a fixed ID for the deferred link here:
`'@resume1.id'` would create a reference cycle because references are still
resolved before inserts. The models must allow `primaryResumeId` to be omitted
on create and accept the explicit string IDs shown above.

Deferred fields require a saved `id`, a Prisma `update` delegate and the default
writer. Use a transaction so a failed update rolls back the earlier creates.
Include an `@updatedAt` field in `deferredFields` when that update must retain a
specific fixture timestamp.

### Parameters and templates

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

Use Faker 10 providers, such as `{{number.int({"min": 1, "max": 10})}}` for a
number or `{{date.past}}` for a Date. Composed strings preserve surrounding text.
Locale falls back to English; see [compatibility](#compatibility-and-attribution)
for legacy provider aliases.

### Reproducible data

Pass `seed` and `refDate` through the [CLI](#cli) or
[API](#load-definitions-in-your-own-transaction) to reproduce package-generated
Faker values, relative dates and random-reference choices.

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

| Entry point                                      | Transaction ownership                           | Disconnects the client |
| ------------------------------------------------ | ----------------------------------------------- | ---------------------- |
| CLI                                              | Automatic, or your configured guard             | Yes                    |
| `PrismaFixtures.load(client)`                    | Automatic                                       | No; caller owns it     |
| `loadFixtures`, `cleanFixtures`, `resetFixtures` | Caller; pass a transaction client for atomicity | No; caller owns it     |

CommonJS callers can use `require('@skmdev/prisma-fixtures')`.

### Load from config

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

### Load definitions in your own transaction

With your existing `prisma` client, read a file or directory and pass the
definitions to `loadFixtures`. Returned records are keyed by fixture name:

```ts
import { loadFixtures, readFixtureDefinitions } from '@skmdev/prisma-fixtures'

const definitions = readFixtureDefinitions('./fixtures')
const records = await prisma.$transaction(
  (tx) =>
    loadFixtures(tx, definitions, {
      seed: 42,
      refDate: '2026-01-01T00:00:00.000Z',
    }),
  { timeout: 60_000 },
)

console.log(records.user1.id)
```

Disconnect `prisma` when your application is finished with it. For a standalone
seed script, use `try`/`finally` as in the runnable example above.

### Function reference

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
- `createPrisma8FixtureClient(db)` adapts a native Prisma 8 PostgreSQL client to
  the fixture delegate, transaction and disconnect interface. Application queries
  continue to use the original native `db`.
- Package-owned failures are `FixtureError` instances with a stable `code`, safe
  `stage`/source/fixture/path context and the original private `cause` for API
  callers. Opaque provider, hook and database messages are not copied into the
  safe message.

### Cleanup and reset

Default loading inserts records; it never deletes or automatically upserts.
Repeating a load can create duplicates or raise unique-constraint errors.
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
constraints, sequence values, `_prisma_migrations` records and Prisma 8's
`prisma_contract` schema are preserved.
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

Run these commands from your project directory:

| Command                                                            | Purpose                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `npx prisma-fixtures init`                                         | Create config and fixture directory without overwriting an existing config |
| `npx prisma-fixtures`                                              | Load configured fixtures; used directly by v8 and by the v7 seed command   |
| `npx prisma-fixtures ./fixtures --list`                            | List fixture names and entities without executing code                     |
| `npx prisma-fixtures --lint`                                       | Check fixtures without a client or database                                |
| `npx prisma-fixtures --clean`                                      | Clear database data without reading fixtures (PostgreSQL only)             |
| `npx prisma-fixtures --reset`                                      | Clear database data, then load fixtures (PostgreSQL only)                  |
| `npx prisma-fixtures --seed 42 --refDate 2026-01-01T00:00:00.000Z` | Reproduce generated values and random references                           |
| `npx prisma-fixtures --config ./test/.prisma-fixtures`             | Use a different config file                                                |
| `npx prisma-fixtures --help`                                       | Show all options                                                           |

Use only one of `--clean`, `--reset`, `--list` and `--lint` at a time. Clean and
reset affect tables beyond those in your fixtures; see [cleanup and reset](#cleanup-and-reset).
These destructive modes must be requested on the command line, not saved in config.

To reuse an existing directory during setup, run
`npx prisma-fixtures init ../shared/fixtures`. The directory must already exist.

### Configuration

`.prisma-fixtures` is JSON. Start with the config from the Prisma 7 quick start
or Prisma 8 preview and add only the options you need:

```json
{
  "fixtures": ["./fixtures"],
  "timeout": 60000,
  "seed": 42,
  "refDate": "2026-01-01T00:00:00.000Z",
  "preserveTables": ["public.audit_log"]
}
```

| Config key       | CLI override            | Default / purpose                                                                        |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `fixtures`       | Positional paths        | No default; nonempty array of paths, required unless using positional paths or `--clean` |
| `client`         | `--client <module>`     | Inferred from Prisma config; see client discovery below                                  |
| `timeout`        | `--timeout <ms>`        | `60000`; positive integer transaction timeout in milliseconds                            |
| `schema`         | `--schema <file>`       | None; JSON Schema for `--lint`                                                           |
| `seed`           | `--seed <integer>`      | Random; integer from 0 through 4294967295                                                |
| `refDate`        | `--refDate <timestamp>` | Current time; canonical UTC timestamp such as `2026-01-01T00:00:00.000Z`                 |
| `preserveTables` | Config only             | `[]`; exact existing `schema.table` names excluded from clean/reset                      |

Unknown fields are rejected. Config paths are relative to the config file;
positional paths and CLI flags are relative to the working directory and override
matching config fields. Multiple fixture paths form one load and one transaction.
Discovery checks only the current directory; an explicit `--config` file must exist.

When `client` is omitted, `--clean` and `--reset` also preserve Prisma 7
`tables.external` entries from the adjacent config when
`experimental.externalTables` is enabled. Every Prisma 8 adapter preserves emitted
contract tables whose control is `external`, `observed` or `tolerated`. This applies
to CLI clients constructed from inferred or explicit `contract.json` paths and to
programmatic transactions created by `createPrisma8FixtureClient(db)`. These tables
are combined with explicit `preserveTables` entries. Ordinary loading ignores the
preserve list and never deletes data.

### Client discovery and overrides

For write commands with no explicit `client`, the CLI reads the adjacent Prisma
config. A Prisma 8 `definePrismaConfig({ orm: ... })` config resolves its emitted
`contract.json` output and constructs `createPrisma8FixtureClient(db)` with the
installed `@prisma/orm-postgres` runtime. Run `prisma contract emit` first.

The retained Prisma 7 path resolves the static `prisma-client` output and uses
the installed `@prisma/adapter-pg`; run `prisma generate` first. For inferred
`.ts`/`.cts` v7 clients, the CLI uses compiled output described by `tsconfig.json`
or the project's installed `ts-node`. Native ESM `.mts` clients work with Node's
type stripping.

An explicit `client` object uses `module`, `adapter: 'pg'` and an optional
`guard`. `module` can name a v8 `contract.json` or a generated v7 client. A legacy
module path exporting a client or factory remains supported, and `--client`
overrides either configured form with that path.

| CLI-only option                    | Purpose                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `--databaseUrl <url>`              | Override the datasource URL; a legacy client module must export a factory            |
| `--require <module>`               | Preload a hook or path alias module; repeatable, resolved from the working directory |
| `--debug`, `-d`                    | Include error type/code without fixture values or URLs                               |
| `--no-color`                       | Accepted for compatibility; output is always plain                                   |
| `--version`, `-v` / `--help`, `-h` | Print version/help without loading config                                            |

The inferred client uses Prisma's datasource URL, then `DATABASE_URL` from the
environment if the config omits it. `--databaseUrl` overrides both. Keep
credentials out of the JSON config and shell history. The CLI does not
independently load `.env` files; a `prisma.config.ts` import of `dotenv/config`
works when Prisma loads that config. Otherwise use `--require dotenv/config`.
For application-specific safety checks, `client.guard` may name a module exporting
`fixtureDatabaseUrl(env)` and `fixtureTransaction(client, action, timeout)`.
Those functions validate the connection before client creation and wrap writes
in the application's transaction guard.

### Transactions and diagnostics

The CLI wraps writes in one transaction (60-second timeout; override with
`--timeout <ms>`) and always disconnects a successfully acquired valid client.
Prisma 8 enforces this with PostgreSQL 17+'s `transaction_timeout`; Prisma 7 uses
its client transaction timeout option.
`--list` and `--lint` skip all hooks, Prisma config loading and client imports;
`--list` only parses the JSON config and fixture documents.
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

For Prisma 8, emit the contract and pass it to the generator's offline contract
mode:

```sh
npx prisma contract emit
npx prisma-fixtures-generator src/generated/prisma/contract.json src/generated/prisma-fixtures
```

This writes `src/generated/prisma-fixtures/schema.json`. Contract validation
fails closed: dictionary fields and unknown codec IDs, including unsupported
extension-provided codecs, stop generation instead of producing a permissive or
incorrect schema.

For Prisma 7, add the legacy generator block to `prisma/schema.prisma`:

```prisma
generator fixtures {
  provider = "prisma-fixtures-generator"
  output   = "../generated/fixtures"
}
```

Run `npx prisma generate`. This creates `generated/fixtures/schema.json` from
Prisma's model and create-input metadata. Output paths are relative to
`schema.prisma`; regenerate after changing your models. Neither generator mode
needs a database connection.

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

The generated schema selects fields by `entity`. Prisma 8 schemas include
namespace-qualified names such as `public.User`, plus unqualified model and
delegate aliases when they are unambiguous; Prisma 7 schemas accept model and
delegate names. The schema checks known fields, scalar types, enums, nullability,
lists and required create inputs. Both nested relation inputs and direct foreign
keys are supported. References, Faker, EJS and parameter expressions remain
dynamic strings; their evaluated types are checked when loading. References and
records with an `id` (including arrays) are allowed for `connectedFields`
shorthand.

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

The Prisma 8 release candidate is tested against the exact RC pair documented
above and PostgreSQL 17+. Prisma 8 CLI and runtime packages have separate version
numbers. Prisma 7.10 support, its generator RPC and existing client injection
remain available for legacy consumers. A stable fixture package `1.0.0` requires
stable Prisma 8 CLI and runtime releases and successful migration verification
against those stable versions.

Legacy Faker aliases `name.firstName`, `name.lastName`, `name.title`,
`internet.userName` and `random.number` remain supported. This is syntax
compatibility, not identical random output or complete emulation of every removed
Faker API. New fixtures should use Faker 10 provider names.

The fixture language follows
[getbigger-io/prisma-fixtures](https://github.com/getbigger-io/prisma-fixtures),
with modern client injection and validation. This new package does not expose the
old `Loader`, `Builder`, `Parser`, `Resolver` or `fixturesIterator` class API, or
instantiate an implicit Prisma client. Replace that setup with the functions
above. MIT; see [LICENSE](LICENSE) and retained upstream attribution in [NOTICE](NOTICE).

Development checks and release instructions are in [CONTRIBUTING.md](CONTRIBUTING.md).
