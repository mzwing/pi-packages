import type { Preset } from '../presets.js'
import { nextConversation, prepareReview } from '../../reviewer/conversation.js'
import { findToolCallInput } from '../session.js'
import { DenialCircuitBreaker } from './circuit-breaker.js'
import { BUILT_IN_RULES, buildSystemPrompt, POLICY_REVISION } from './policy.js'
import { buildFollowUpPrompt, buildUserPrompt } from './review-prompt.js'
import { renderTranscript } from './transcript.js'
import { parseReviewAssessment } from './verdict.js'

// Verbatim `REJECTION_INSTRUCTIONS` from openai/codex `codex-rs/prompts/src/model_messages/guardian.rs`
const REJECTION_INSTRUCTIONS =
  'The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input'

export const CODEX_PRESET: Preset = {
  policyRevision: POLICY_REVISION,
  builtInRules: BUILT_IN_RULES,
  createLimiter: () => new DenialCircuitBreaker(),
  async review(input, complete) {
    const { config, branch, details } = input
    const toolInput = findToolCallInput(branch, details.toolCallId)
    const { request, transcript, priorReviews } = prepareReview(
      input,
      { systemPrompt: buildSystemPrompt(config), reasoning: config.reasoning },
      after => {
        if (after === undefined) {
          const full = renderTranscript(branch)

          return { content: buildUserPrompt(full, details, toolInput), transcript: full }
        }
        const delta = renderTranscript(branch, after.entryIndex + 1)

        return { content: buildFollowUpPrompt(delta, details, toolInput), transcript: delta }
      },
    )
    const fields = { toolInputIncluded: toolInput !== undefined, ...transcript.stats, priorReviews }
    const result = await complete(request, parseReviewAssessment)
    if (!result.ok) {
      return { kind: 'failed', failure: result.failure, fields }
    }

    const assessment = result.value
    const lastEntry = branch.at(-1)
    const next = nextConversation(config, {
      priorReviews,
      request,
      firstReply: result.reply,
      lastReply: result.reply,
      cursor: lastEntry === undefined ? undefined : { entryId: lastEntry.id },
    })
    // Under a key naming an authorization, the review log would mask the grade
    const graded = { ...fields, riskLevel: assessment.riskLevel, userApproval: assessment.userAuthorization }
    if (assessment.outcome === 'allow') {
      return { kind: 'allow', fields: graded, conversation: next }
    }

    // The host already prefixes its own attribution sentence, so this carries the why, the two grades and upstream's
    // instruction against working around the denial
    return {
      kind: 'deny',
      reason: `${assessment.rationale} (risk: ${assessment.riskLevel}, user authorization: ${assessment.userAuthorization}). ${REJECTION_INSTRUCTIONS}`,
      fields: graded,
      conversation: next,
    }
  },
}
