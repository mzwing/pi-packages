const LEADING_ALLOW = /^<block>\s*no\b/i
const LEADING_BLOCK = /^<block>\s*yes\b/i
const BLOCK_TAG = /<block>\s*(yes|no)\b/gi
const CLOSED_THINKING = /<thinking>[\s\S]*?<\/thinking>/g
const OPEN_THINKING = /<thinking>[\s\S]*$/
const REASON = /<reason>([\s\S]*?)<\/reason>/
const CATEGORY = /<category>([^<]{1,64})<\/category>/
const REASON_CATEGORY = /^\[([^\]]+)\]/

export type ClaudeCodeFastVerdict = 'allow' | 'block' | 'unparseable'

export type ClaudeCodeVerdict = { outcome: 'allow' } | { outcome: 'deny'; category: string; reason: string }

/**
 * Judged by the opening tag alone, as Claude Code's `</block>` stop sequence leaves nothing after it; a reply that
 * opens any other way goes on to the second pass
 */
export function parseFastVerdict(text: string): ClaudeCodeFastVerdict {
  const reply = text.trim()
  if (LEADING_ALLOW.test(reply)) {
    return 'allow'
  }

  return LEADING_BLOCK.test(reply) ? 'block' : 'unparseable'
}

/** Throws on a reply with no verdict, or two that disagree, which retries the call */
export function parseVerdict(text: string): ClaudeCodeVerdict {
  const answer = text.replace(CLOSED_THINKING, '').replace(OPEN_THINKING, '')
  const verdicts = new Set([...answer.matchAll(BLOCK_TAG)].map(match => match[1]?.toLowerCase()))
  if (verdicts.size !== 1) {
    throw new Error('the review gave no single verdict')
  }
  if (verdicts.has('no')) {
    return { outcome: 'allow' }
  }

  const reason = REASON.exec(answer)?.[1]?.trim()
  const category =
    CATEGORY.exec(answer)?.[1]?.trim() ??
    (reason === undefined ? undefined : REASON_CATEGORY.exec(reason)?.[1]?.trim()) ??
    'Unspecified'
  const labelled = reason === undefined ? `[${category}]` : reason.startsWith('[') ? reason : `[${category}] ${reason}`

  return { outcome: 'deny', category, reason: labelled }
}
