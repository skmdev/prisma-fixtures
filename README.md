# @skmdev/prisma-fixtures

Load YAML or JSON fixtures into Prisma using named references, generated data and
processors. Works with a client you create, including Prisma 7 driver adapters.

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

Then load the directory using your existing client:

```ts
import { loadFixtures, readFixtureDefinitions } from '@skmdev/prisma-fixtures'
import { prisma } from './your-prisma-client'

const definitions = readFixtureDefinitions('./fixtures')
const records = await prisma.$transaction(
  (tx) => loadFixtures(tx, definitions),
  { timeout: 60_000 },
)
console.log(records.user1.id)
```

CommonJS is supported with `require('@skmdev/prisma-fixtures')`.

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
TypeScript processors can use Node's native type stripping for supported syntax
(for example an ESM `.mts` module), or a loader you configure. Native stripping
does not convert ESM imports to CommonJS; match your module extension/package
configuration or compile your processor first. The hook runs once per record after resolving references
and before converting connections. Return a plain object. No postProcess hook is
defined by the upstream processor contract.

## API and persistence

- `readFixtureDefinitions(path): FixtureDefinition[]` parses without executing
  templates, importing processors or accessing a database.
- `loadFixtures(client, definitions, writer?): Promise<Record<string, Record<string, unknown>>>`
  validates and loads definitions. It accepts either a Prisma client or transaction
  client and does not disconnect it. Types `FixtureDefinition`, `FixtureWriter`
  and `FixtureProcessor` are exported.
- The optional `writer(fixture, data)` returns the saved record and replaces the
  default `create({ data })`. Use it to implement application-specific upserts.
  When using a transaction, the writer must use that same transaction client.

Default loading inserts records. Repeating a load can create duplicates or raise
unique-constraint errors. There is no reset, deletion or automatic upsert. Without
a caller-owned transaction, a later database/processor error can leave earlier
records inserted. Rollback cannot undo external side effects in a processor.

## CLI

Create `fixtures-client.mjs` with your generated client's actual import path:

```js
import { PrismaClient } from './generated/prisma/client.js'
import { PrismaPg } from '@prisma/adapter-pg'

export default function createClient({ databaseUrl }) {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseUrl ?? process.env.DATABASE_URL,
    }),
  })
}
```

```sh
npx prisma-fixtures ./fixtures --list
npx prisma-fixtures ./fixtures --client ./fixtures-client.mjs
npx prisma-fixtures --help
```

The module may export a ready client instead of a factory. `--databaseUrl` is only
accepted with a factory. Prefer setting connection details in your client module
or environment to avoid placing credentials in shell history. The CLI does not
load `.env` files for you; your application controls configuration.

The CLI wraps writes in one transaction (60-second timeout; override with
`--timeout <ms>`) and always disconnects a successfully acquired valid client.
`--require <module>` may be repeated to preload hooks such as `ts-node/register`;
modules resolve from the working directory. `--list` skips all hooks and client
imports. `--version`/`-v`, `--help`/`-h`, `--debug`/`-d` and `--no-color` are supported.
Multiple positional paths are combined into one load and one transaction.
Debug output includes only the failure stage and error type/code. Use the API in
your own diagnostic harness if you need to inspect the original error.

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
instantiate an implicit Prisma client. Replace that setup with the two functions
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
generates a Prisma 7 client, checks relations and rollback against PostgreSQL, and
exercises CommonJS, ESM, TypeScript and the installed CLI. CI runs on Node 22 and 24.
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

Only `dist`, package metadata, README and license/notice files are published.
`prepack` builds JavaScript and declarations. Publication and GitHub pushes are
manual; nothing publishes automatically from this repository.
