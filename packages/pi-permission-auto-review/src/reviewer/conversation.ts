import type { AutoReviewConfig } from '../config/config.js'
import type { ModelRequest } from './model-call.js'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { calculateContextTokens } from '@earendil-works/pi-coding-agent'
import { approximateTokens } from '../text.js'
import { OUTPUT_RESERVE_TOKENS, replyText } from './model-call.js'

/** Past this a conversation starts over even where the context window holds more, since every review rereads it */
const MAX_CONVERSATION_TOKENS = 256_000

/** Where a review's transcript ended: an entry, and the tool call in it the review judged, if any */
export interface TranscriptCursor {
  entryId: string
  toolCallId?: string | undefined
}

/** The reviews of a session so far, which a follow-up review continues with what the session added since */
export interface ReviewConversation {
  /** Each review's prompts and the replies to them */
  messages: Message[]
  cursor: TranscriptCursor
  tokens: number
  reviews: number
}

/** What a follow-up renders after: the conversation's cursor, whose entry sits at `entryIndex` in the branch */
interface Continuation {
  cursor: TranscriptCursor
  entryIndex: number
}

interface PreparedReview<T> {
  request: ModelRequest
  transcript: T
  priorReviews: number
}

/** A review's last request, and the replies to its first and last calls */
interface FinishedReview {
  priorReviews: number
  request: ModelRequest
  firstReply: AssistantMessage
  lastReply: AssistantMessage
  cursor: TranscriptCursor | undefined
}

export function userMessage(content: string): Message {
  return { role: 'user', content, timestamp: Date.now() }
}

/**
 * A follow-up while the conversation still lies on the branch and has room for it, otherwise a full review; `render`
 * builds the review's message, and gets no continuation for a full one
 */
export function prepareReview<T>(
  input: { conversation: ReviewConversation | undefined; branch: SessionEntry[]; contextWindow: number },
  options: Pick<ModelRequest, 'systemPrompt' | 'reasoning' | 'maxTokens'>,
  render: (after: Continuation | undefined) => { content: string; transcript: T },
): PreparedReview<T> {
  const { conversation, branch, contextWindow } = input
  const entryIndex =
    conversation === undefined ? -1 : branch.findIndex(entry => entry.id === conversation.cursor.entryId)
  if (conversation !== undefined && entryIndex >= 0) {
    const followUp = render({ cursor: conversation.cursor, entryIndex })
    const tokens = conversation.tokens + approximateTokens(followUp.content)
    if (tokens + OUTPUT_RESERVE_TOKENS <= Math.min(contextWindow, MAX_CONVERSATION_TOKENS)) {
      return {
        request: { ...options, messages: [...conversation.messages, userMessage(followUp.content)], tokens },
        transcript: followUp.transcript,
        priorReviews: conversation.reviews,
      }
    }
  }
  const full = render(undefined)

  return {
    request: {
      ...options,
      messages: [userMessage(full.content)],
      tokens: approximateTokens(options.systemPrompt + full.content),
    },
    transcript: full.transcript,
    priorReviews: 0,
  }
}

/** In `auto`, a follow-up served without a cache hit ends the conversation, which an uncached provider would resend whole */
export function nextConversation(config: AutoReviewConfig, review: FinishedReview): ReviewConversation | undefined {
  const continues =
    config.followUpReviews === 'always' ||
    (config.followUpReviews === 'auto' && (review.priorReviews === 0 || review.firstReply.usage.cacheRead > 0))
  if (!continues || review.cursor === undefined) {
    return undefined
  }

  return {
    messages: [...review.request.messages, review.lastReply],
    cursor: review.cursor,
    // A provider reporting no usage leaves an estimate, blind to hidden reasoning
    tokens:
      calculateContextTokens(review.lastReply.usage) ||
      review.request.tokens + approximateTokens(replyText(review.lastReply)),
    reviews: review.priorReviews + 1,
  }
}
