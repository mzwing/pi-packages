import type { AutoReviewConfig, PresetName, RuleListName } from '../config/config.js'
import type { ReviewConversation } from '../reviewer/conversation.js'
import type { CallFailure, ModelCall } from '../reviewer/model-call.js'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { CLAUDE_CODE_PRESET } from './claude-code/preset.js'
import { CODEX_PRESET } from './codex/preset.js'

export interface ContextFile {
  path: string
  content: string
}

interface ReviewInput {
  config: AutoReviewConfig
  branch: SessionEntry[]
  details: PromptPermissionDetails
  /** Already narrowed to the files the user's trust covers */
  contextFiles: readonly ContextFile[]
  /** The conversation a follow-up review continues, if one is open */
  conversation: ReviewConversation | undefined
  contextWindow: number
}

/** Logged with the decision: never the reviewer's prose, and no key naming a token or an authorization, which the log masks */
export type ReviewFields = Record<string, string | number | boolean>

export type ReviewOutcome =
  | { kind: 'allow'; fields: ReviewFields; conversation: ReviewConversation | undefined }
  | { kind: 'deny'; reason: string; fields: ReviewFields; conversation: ReviewConversation | undefined }
  | { kind: 'failed'; failure: CallFailure; fields: ReviewFields }

export type DenialLimit = 'consecutive' | 'total'

export interface DenialLimiter {
  /** Why every ask is refused unreviewed, while that holds */
  refusal: () => string | undefined
  /** The limit this denial reached, which hands its ask to the human prompt instead */
  recordDenial: () => DenialLimit | undefined
  recordNonDenial: () => void
  resetTurn: () => void
}

export interface Preset {
  policyRevision: string
  /** What `DEFAULTS_ENTRY` stands for in each rule list */
  builtInRules: Readonly<Record<RuleListName, readonly string[]>>
  createLimiter: () => DenialLimiter
  review: (input: ReviewInput, complete: ModelCall) => Promise<ReviewOutcome>
}

export const PRESETS: Readonly<Record<PresetName, Preset>> = {
  codex: CODEX_PRESET,
  'claude-code': CLAUDE_CODE_PRESET,
}
