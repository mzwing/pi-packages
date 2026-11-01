import type { DenialLimiter } from '../presets.js'

const MAX_CONSECUTIVE_DENIALS = 3
const RECENT_WINDOW_SIZE = 50
const MAX_RECENT_DENIALS = 10
const REFUSAL =
  'Too many denials this turn; further requests are refused unreviewed until the next turn. Ask the user for explicit approval before retrying'

export class DenialCircuitBreaker implements DenialLimiter {
  private consecutiveDenials = 0
  private recentDenials: boolean[] = []

  refusal(): string | undefined {
    const open =
      this.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS ||
      this.recentDenials.filter(Boolean).length >= MAX_RECENT_DENIALS

    return open ? REFUSAL : undefined
  }

  recordDenial(): undefined {
    this.consecutiveDenials += 1
    this.recordRecent(true)

    return undefined
  }

  recordNonDenial(): void {
    this.consecutiveDenials = 0
    this.recordRecent(false)
  }

  resetTurn(): void {
    this.consecutiveDenials = 0
    this.recentDenials = []
  }

  private recordRecent(denied: boolean): void {
    this.recentDenials.push(denied)
    if (this.recentDenials.length > RECENT_WINDOW_SIZE) {
      this.recentDenials.shift()
    }
  }
}
