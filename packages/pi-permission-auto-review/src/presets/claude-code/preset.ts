import type { ReviewConversation } from '../../reviewer/conversation.js'
import type { ModelRequest } from '../../reviewer/model-call.js'
import type { Preset } from '../presets.js'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { nextConversation, prepareReview, userMessage } from '../../reviewer/conversation.js'
import { replyText } from '../../reviewer/model-call.js'
import { approximateTokens } from '../../text.js'
import { DenialCounter } from './denial-counter.js'
import { BUILT_IN_RULES, buildSystemPrompt, POLICY_REVISION } from './policy.js'
import { buildFollowUpMessage, buildReviewMessage, THINKING_PROMPT } from './review-prompt.js'
import { renderTranscript } from './transcript.js'
import { parseFastVerdict, parseVerdict } from './verdict.js'

// The verdict tag needs a handful of tokens, but some models reason first whatever they are asked, and their
// reasoning counts toward the cap; Claude Code adds the thinking budget to its 64 tokens for the same reason
const FAST_MAX_TOKENS = 1024
const DENIAL_GUIDANCE =
  'Do not reach the same result another way, such as by rewording, splitting or encoding the action or running it through another tool. Carry on with work that does not depend on it; if it is essential, stop and tell the user what you need and why, so they can approve it.'

export const CLAUDE_CODE_PRESET: Preset = {
  policyRevision: POLICY_REVISION,
  builtInRules: BUILT_IN_RULES,
  createLimiter: () => new DenialCounter(),
  async review(input, complete) {
    const { config, branch, details, contextFiles } = input
    const systemPrompt = buildSystemPrompt(config.autoMode, contextFiles)
    const prepared = prepareReview(input, { systemPrompt, reasoning: 'off', maxTokens: FAST_MAX_TOKENS }, after => {
      const rendered = renderTranscript(branch, details, after?.cursor)

      return {
        content: after === undefined ? buildReviewMessage(rendered) : buildFollowUpMessage(rendered),
        transcript: rendered,
      }
    })
    const { request: fastRequest, transcript, priorReviews } = prepared
    const fields = { ...transcript.stats, contextFileCount: contextFiles.length, priorReviews }
    const fast = await complete(fastRequest, parseFastVerdict)
    if (!fast.ok) {
      return { kind: 'failed', failure: fast.failure, fields }
    }
    const conversationAfter = (request: ModelRequest, lastReply: AssistantMessage): ReviewConversation | undefined =>
      nextConversation(config, { priorReviews, request, firstReply: fast.reply, lastReply, cursor: transcript.cursor })
    if (fast.value === 'allow') {
      return {
        kind: 'allow',
        fields: { ...fields, stage: 'fast' },
        conversation: conversationAfter(fastRequest, fast.reply),
      }
    }

    // Continuing the fast pass's exchange lets a provider's prompt cache serve the transcript a second time
    const thinkingRequest: ModelRequest = {
      systemPrompt,
      messages: [...fastRequest.messages, fast.reply, userMessage(THINKING_PROMPT)],
      tokens: fastRequest.tokens + approximateTokens(replyText(fast.reply) + THINKING_PROMPT),
      reasoning: config.reasoning,
    }
    const escalated = { ...fields, stage: 'thinking', fastVerdict: fast.value }
    const thinking = await complete(thinkingRequest, parseVerdict)
    if (!thinking.ok) {
      return { kind: 'failed', failure: thinking.failure, fields: escalated }
    }
    const next = conversationAfter(thinkingRequest, thinking.reply)
    const verdict = thinking.value
    if (verdict.outcome === 'allow') {
      return { kind: 'allow', fields: escalated, conversation: next }
    }

    return {
      kind: 'deny',
      reason: `${verdict.reason} ${DENIAL_GUIDANCE}`,
      fields: { ...escalated, category: verdict.category },
      conversation: next,
    }
  },
}
