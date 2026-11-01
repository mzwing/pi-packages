const TRUNCATION_TAG = '\n...[truncated]...\n'

export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function serializeUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function truncateToCharacters(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text
  }
  const available = Math.max(0, maxCharacters - TRUNCATION_TAG.length)
  const headLength = Math.floor(available * 0.7)
  const tailLength = available - headLength

  // `slice(-0)` would return the whole string when the budget leaves no tail
  return `${text.slice(0, headLength)}${TRUNCATION_TAG}${text.slice(text.length - tailLength)}`
}

/**
 * Keeps the head and tail of `text` so that `render(text)` fits `maxCharacters`. Measured after rendering, since JSON
 * escaping can multiply the length, so the cap holds on the wire
 */
export function truncateToFit(text: string, maxCharacters: number, render: (text: string) => string): string {
  if (render(text).length <= maxCharacters) {
    return text
  }

  let lower = 0
  let upper = Math.min(text.length, maxCharacters)
  let fitted = truncateToCharacters(text, 0)
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2)
    const candidate = truncateToCharacters(text, middle)
    if (render(candidate).length <= maxCharacters) {
      fitted = candidate
      lower = middle + 1
    } else {
      upper = middle - 1
    }
  }

  return fitted
}
