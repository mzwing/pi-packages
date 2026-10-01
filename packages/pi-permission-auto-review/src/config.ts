import { z } from 'zod'

export const EXTENSION_ID = 'pi-permission-auto-review'
export const DEFAULT_PROVIDER = 'openai-codex'
export const DEFAULT_MODEL = 'codex-auto-review'
export const MAX_TIMEOUT_MS = 300_000
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/main/packages/pi-permission-auto-review/schemas/config.schema.json'

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const timeoutSchema = z.number().int().positive().max(MAX_TIMEOUT_MS)

const fileSchema = z.strictObject({
  $schema: z.string().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  reasoning: z.enum(REASONING_LEVELS).optional(),
  timeoutMs: timeoutSchema.optional(),
  includeBaselinePolicy: z.boolean().optional(),
  additionalPolicy: z.string().trim().min(1).optional(),
})

const configSchema = fileSchema
  .extend({
    provider: z.string().trim().min(1).default(DEFAULT_PROVIDER),
    model: z.string().trim().min(1).default(DEFAULT_MODEL),
    reasoning: z.enum(REASONING_LEVELS).default('low'),
    timeoutMs: timeoutSchema.default(90_000),
    includeBaselinePolicy: z.boolean().default(true),
  })
  .superRefine((config, context) => {
    if (!config.includeBaselinePolicy && config.additionalPolicy === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'additionalPolicy is required when includeBaselinePolicy is false',
        path: ['additionalPolicy'],
      })
    }
  })

// `isolatedDeclarations` cannot emit a `z.infer` of a private schema; `DEFAULT_CONFIG` keeps the two in step.
export interface AutoReviewConfig {
  $schema?: string | undefined
  provider: string
  model: string
  reasoning: (typeof REASONING_LEVELS)[number]
  timeoutMs: number
  includeBaselinePolicy: boolean
  additionalPolicy?: string | undefined
}

export type AutoReviewConfigFile = { [K in keyof AutoReviewConfig]?: AutoReviewConfig[K] | undefined }

export const DEFAULT_CONFIG: AutoReviewConfig = configSchema.parse({})

export type ParseResult<T> = { ok: true; config: T } | { ok: false; issue: string }

function formatIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
}

export function validateConfigFile(value: unknown): ParseResult<AutoReviewConfigFile> {
  const parsed = fileSchema.safeParse(value)

  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, issue: formatIssues(parsed.error) }
}

export function parseConfigFile(source: string): ParseResult<AutoReviewConfigFile> {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    return { ok: false, issue: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }

  return validateConfigFile(value)
}

/** Project fields override global ones; the cross-field rule can only be judged on the merge. */
export function mergeConfig(
  global: AutoReviewConfigFile,
  project: AutoReviewConfigFile,
): ParseResult<AutoReviewConfig> {
  const parsed = configSchema.safeParse({ ...global, ...project })

  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, issue: formatIssues(parsed.error) }
}

export function buildJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(configSchema, { target: 'draft-2020-12', io: 'input' })

  return {
    $schema,
    $id: CONFIG_SCHEMA_URL,
    ...schema,
    // Mirrors the `superRefine`, which JSON Schema output cannot express on its own.
    allOf: [
      {
        if: { properties: { includeBaselinePolicy: { const: false } }, required: ['includeBaselinePolicy'] },
        then: { required: ['additionalPolicy'] },
      },
    ],
  }
}
