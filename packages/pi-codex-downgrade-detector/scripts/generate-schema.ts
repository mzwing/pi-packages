import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildDetectorJsonSchema } from '../src/config.ts'

const schemaPath = fileURLToPath(new URL('../schemas/config.schema.json', import.meta.url))
writeFileSync(schemaPath, `${JSON.stringify(buildDetectorJsonSchema(), null, 2)}\n`)
