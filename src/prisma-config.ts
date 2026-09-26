import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { contractPreservedTables } from './prisma8-client'

import {
  normalizeCleanupOptions,
  type FixturePreservedTable,
} from './cleanup-options'

type PrismaDefaults = {
  module: string
  databaseUrl?: string
  preserveTables: FixturePreservedTable[]
}

export async function loadPrismaDefaults(
  configRoot: string,
  requireFromCwd: NodeRequire,
  databaseUrlOverride?: string,
): Promise<PrismaDefaults> {
  const requireFromPrisma = createRequire(
    requireFromCwd.resolve('prisma/package.json'),
  )
  const version = requireFromPrisma('./package.json').version as string
  const previousUrl = process.env.DATABASE_URL
  if (databaseUrlOverride !== undefined) {
    process.env.DATABASE_URL = databaseUrlOverride
  }
  try {
    return version.startsWith('8.')
      ? await loadPrisma8Defaults(configRoot, requireFromPrisma)
      : await loadPrisma7Defaults(configRoot, requireFromPrisma, requireFromCwd)
  } finally {
    if (databaseUrlOverride !== undefined) {
      if (previousUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousUrl
    }
  }
}

async function loadPrisma7Defaults(
  configRoot: string,
  requireFromPrisma: NodeRequire,
  requireFromCwd: NodeRequire,
): Promise<PrismaDefaults> {
  const { loadConfigFromFile } = requireFromPrisma('@prisma/config') as {
    loadConfigFromFile: (options: { configRoot: string }) => Promise<{
      resolvedPath: string | null
      config?: {
        schema?: string
        datasource?: { url?: string }
        tables?: { external?: string[] }
      }
      error?: unknown
    }>
  }
  const loaded = await loadConfigFromFile({ configRoot })
  if (!loaded.resolvedPath || !loaded.config || loaded.error) {
    throw new Error('Prisma config could not be loaded')
  }

  const schemaPath = loaded.config.schema ?? defaultSchema(configRoot)
  const source = generatedClient(schemaPath)
  return {
    module: runtimeClient(source, configRoot, requireFromCwd),
    databaseUrl: loaded.config.datasource?.url,
    preserveTables:
      normalizeCleanupOptions({
        preserveTables: loaded.config.tables?.external ?? [],
      }).preserveTables ?? [],
  }
}

async function loadPrisma8Defaults(
  configRoot: string,
  requireFromPrisma: NodeRequire,
): Promise<PrismaDefaults> {
  const { loadConfigForSections } = (await import(
    pathToFileURL(
      requireFromPrisma.resolve('@prisma/orm-toolchain/config-loader'),
    ).href
  )) as {
    loadConfigForSections: (
      file: string,
      sections: string[],
    ) => Promise<{
      ok: boolean
      value?: {
        contract?: { output?: string }
        db?: { connection?: string }
        extensions?: unknown[]
      }
    }>
  }
  const loaded = await loadConfigForSections(
    path.join(configRoot, 'prisma.config.ts'),
    ['contract', 'db'],
  )
  const config = loaded.ok ? loaded.value : undefined
  const output = config?.contract?.output
  if (!output || config?.extensions?.length) {
    throw new Error(
      'Prisma 8 config requires an emitted contract and a supported runtime',
    )
  }
  return {
    module: output,
    databaseUrl: config?.db?.connection,
    preserveTables: contractPreservedTables(
      JSON.parse(fs.readFileSync(output, 'utf8')),
    ),
  }
}

function defaultSchema(root: string): string {
  for (const name of ['prisma/schema.prisma', 'schema.prisma']) {
    const file = path.join(root, name)
    if (fs.existsSync(file)) return file
  }
  throw new Error('Prisma schema not found')
}

function generatedClient(schemaPath: string): string {
  const files: string[] = []
  function visit(target: string) {
    if (fs.statSync(target).isDirectory()) {
      for (const entry of fs.readdirSync(target).sort())
        visit(path.join(target, entry))
    } else if (target.endsWith('.prisma')) {
      files.push(target)
    }
  }
  visit(schemaPath)
  const clients: string[] = []
  for (const file of files) {
    const source = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    for (const match of source.matchAll(
      /^\s*generator\s+\w+\s*\{([^}]*)\}/gm,
    )) {
      const field = (name: string) =>
        match[1]!.match(
          new RegExp(`^\\s*${name}\\s*=\\s*"([^"\\n]*)"`, 'm'),
        )?.[1]
      if (field('provider') !== 'prisma-client') continue
      const output = field('output')
      const extension = field('generatedFileExtension') ?? 'ts'
      if (
        !output ||
        !['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].includes(extension)
      ) {
        throw new Error('Prisma client output must be a static supported path')
      }
      clients.push(
        path.resolve(path.dirname(file), output, `client.${extension}`),
      )
    }
  }
  if (clients.length !== 1)
    throw new Error('Expected one prisma-client generator')
  if (!fs.existsSync(clients[0]!)) {
    throw new Error('Generated Prisma client not found; run prisma generate')
  }
  return clients[0]!
}

function runtimeClient(
  source: string,
  configRoot: string,
  requireFromCwd: NodeRequire,
): string {
  const extension = path.extname(source)
  if (extension !== '.ts' && extension !== '.cts') return source
  if (require.extensions[extension]) return source

  const tsconfig = path.join(configRoot, 'tsconfig.json')
  if (fs.existsSync(tsconfig)) {
    const ts = requireFromCwd('typescript') as typeof import('typescript')
    const parsed = ts.readConfigFile(tsconfig, ts.sys.readFile)
    const { rootDir, outDir } = parsed.config?.compilerOptions ?? {}
    if (typeof rootDir === 'string' && typeof outDir === 'string') {
      const relative = path.relative(path.resolve(configRoot, rootDir), source)
      if (
        relative &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative)
      ) {
        const emitted = path.resolve(
          configRoot,
          outDir,
          relative.replace(
            /\.(?:ts|cts)$/,
            extension === '.cts' ? '.cjs' : '.js',
          ),
        )
        if (fs.existsSync(emitted)) return emitted
      }
    }
  }
  return source
}
