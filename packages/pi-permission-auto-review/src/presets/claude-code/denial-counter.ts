import type { DenialLimit, DenialLimiter } from '../presets.js'

const MAX_CONSECUTIVE_DENIALS = 3
const MAX_TOTAL_DENIALS = 20

/** Hands the denial that reaches a limit to the human prompt, then counts that limit afresh */
export class DenialCounter implements DenialLimiter {
  private consecutiveDenials = 0
  private totalDenials = 0

  refusal(): undefined {
    return undefined
  }

  recordDenial(): DenialLimit | undefined {
    this.consecutiveDenials += 1
    this.totalDenials += 1
    const totalReached = this.totalDenials >= MAX_TOTAL_DENIALS
    const consecutiveReached = this.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS
    if (totalReached) {
      this.totalDenials = 0
    }
    if (consecutiveReached) {
      this.consecutiveDenials = 0
    }

    return totalReached ? 'total' : consecutiveReached ? 'consecutive' : undefined
  }

  recordNonDenial(): void {
    this.consecutiveDenials = 0
  }

  // The counts span the session, as Claude Code's do
  resetTurn(): void {}
}
