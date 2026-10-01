import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildJsonSchema } from '../src/config.ts'

const schemaPath = fileURLToPath(new URL('../schemas/config.schema.json', import.meta.url))
writeFileSync(schemaPath, `${JSON.stringify(buildJsonSchema(), null, 2)}\n`)
