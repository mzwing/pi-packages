import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildEnhancerJsonSchema } from '../src/config.ts'

const schemaPath = fileURLToPath(new URL('../schemas/config.schema.json', import.meta.url))
writeFileSync(schemaPath, `${JSON.stringify(buildEnhancerJsonSchema(), null, 2)}\n`)
