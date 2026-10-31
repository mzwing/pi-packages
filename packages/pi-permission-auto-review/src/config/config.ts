import { toJsonSchema } from '@valibot/to-json-schema'
import * as v from 'valibot'

export const EXTENSION_ID = 'pi-permission-auto-review'
export const DEFAULT_PROVIDER = 'openai-codex'
export const DEFAULT_MODEL = 'codex-auto-review'
const MAX_TIMEOUT_MS = 300_000
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/main/packages/pi-permission-auto-review/schemas/config.schema.json'

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const FOLLOW_UP_REVIEW_MODES = ['auto', 'always', 'off'] as const

const nonBlankSchema = v.pipe(v.string(), v.trim(), v.minLength(1))
const timeoutSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(MAX_TIMEOUT_MS))
const maxRetriesSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(20))

const fileSchema = v.strictObject({
  $schema: v.optional(v.pipe(v.string(), v.minLength(1))),
  provider: v.optional(nonBlankSchema),
  model: v.optional(nonBlankSchema),
  reasoning: v.optional(v.picklist(REASONING_LEVELS)),
  timeoutMs: v.optional(timeoutSchema),
  maxRetries: v.optional(maxRetriesSchema),
  attemptTimeoutMs: v.optional(timeoutSchema),
  followUpReviews: v.optional(v.picklist(FOLLOW_UP_REVIEW_MODES)),
  includeBaselinePolicy: v.optional(v.boolean()),
  additionalPolicy: v.optional(nonBlankSchema),
})

const configSchema = v.pipe(
  v.strictObject({
    ...fileSchema.entries,
    provider: v.optional(nonBlankSchema, DEFAULT_PROVIDER),
    model: v.optional(nonBlankSchema, DEFAULT_MODEL),
    reasoning: v.optional(v.picklist(REASONING_LEVELS), 'low'),
    timeoutMs: v.optional(timeoutSchema, 90_000),
    maxRetries: v.optional(maxRetriesSchema, 2),
    followUpReviews: v.optional(v.picklist(FOLLOW_UP_REVIEW_MODES), 'auto'),
    includeBaselinePolicy: v.optional(v.boolean(), true),
  }),
  v.forward(
    v.check(
      config => config.includeBaselinePolicy || config.additionalPolicy !== undefined,
      'additionalPolicy is required when includeBaselinePolicy is false',
    ),
    ['additionalPolicy'],
  ),
)

// `isolatedDeclarations` cannot emit a `v.InferOutput` of a private schema; `DEFAULT_CONFIG` keeps the two in step
export interface AutoReviewConfig {
  $schema?: string | undefined
  provider: string
  model: string
  reasoning: (typeof REASONING_LEVELS)[number]
  timeoutMs: number
  maxRetries: number
  attemptTimeoutMs?: number | undefined
  followUpReviews: (typeof FOLLOW_UP_REVIEW_MODES)[number]
  includeBaselinePolicy: boolean
  additionalPolicy?: string | undefined
}

export type AutoReviewConfigFile = { [K in keyof AutoReviewConfig]?: AutoReviewConfig[K] | undefined }

export const DEFAULT_CONFIG: AutoReviewConfig = v.parse(configSchema, {})

export type ParseResult<T> = { ok: true; config: T } | { ok: false; issue: string }

function formatIssues(issues: v.BaseIssue<unknown>[]): string {
  return issues.map(issue => `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`).join('; ')
}

export function validateConfigFile(value: unknown): ParseResult<AutoReviewConfigFile> {
  const parsed = v.safeParse(fileSchema, value)

  return parsed.success ? { ok: true, config: parsed.output } : { ok: false, issue: formatIssues(parsed.issues) }
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

/** Project fields override global ones; the cross-field rule can only be judged on the merge */
export function mergeConfig(
  global: AutoReviewConfigFile,
  project: AutoReviewConfigFile,
): ParseResult<AutoReviewConfig> {
  const parsed = v.safeParse(configSchema, { ...global, ...project })

  return parsed.success ? { ok: true, config: parsed.output } : { ok: false, issue: formatIssues(parsed.issues) }
}

export function buildJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = toJsonSchema(configSchema, {
    target: 'draft-2020-12',
    typeMode: 'input',
    ignoreActions: ['trim', 'check'],
  })

  return {
    $schema,
    $id: CONFIG_SCHEMA_URL,
    ...schema,
    // Mirrors the `check`, which JSON Schema output cannot express on its own
    allOf: [
      {
        if: { properties: { includeBaselinePolicy: { const: false } }, required: ['includeBaselinePolicy'] },
        then: { required: ['additionalPolicy'] },
      },
    ],
  }
}
