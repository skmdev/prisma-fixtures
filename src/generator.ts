#!/usr/bin/env node
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { generatorHandler } from '@prisma/generator-helper'

import { buildContractFixtureSchema } from './contract-fixture-schema'
import { buildFixtureSchema } from './fixture-schema'

const writeSchema = (output: string, schema: unknown) => {
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(
    path.join(output, 'schema.json'),
    `${JSON.stringify(schema, null, 2)}\n`,
  )
}

const args = process.argv.slice(2)
if (args.length) {
  if (args.length !== 2)
    throw new Error(
      'Usage: prisma-fixtures-generator <contract.json> <output-directory>',
    )
  const [contractPath, output] = args
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as unknown
  const consumerRequire = createRequire(
    path.join(process.cwd(), 'package.json'),
  )
  const runtime = consumerRequire.resolve('@prisma/orm-postgres/target/runtime')
  void import(pathToFileURL(runtime).href).then(
    ({ PostgresContractSerializer }) => {
      new PostgresContractSerializer().deserializeContract(contract)
      writeSchema(output, buildContractFixtureSchema(contract))
    },
  )
} else {
  generatorHandler({
    onManifest() {
      return {
        prettyName: 'Prisma Fixtures',
        defaultOutput: './generated/fixtures',
      }
    },
    async onGenerate(options) {
      const output = options.generator.output?.value
      if (!output)
        throw new Error('Prisma Fixtures generator requires an output path')
      writeSchema(output, buildFixtureSchema(options.dmmf))
    },
  })
}
