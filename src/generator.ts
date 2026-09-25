#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

import { generatorHandler } from '@prisma/generator-helper'

import { buildFixtureSchema } from './fixture-schema'

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
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(
      path.join(output, 'schema.json'),
      `${JSON.stringify(buildFixtureSchema(options.dmmf), null, 2)}\n`,
    )
  },
})
