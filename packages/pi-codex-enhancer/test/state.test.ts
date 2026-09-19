import { describe, expect, it } from 'vitest'
import {
  classifyTurnState,
  describeTurnState,
  isUsable,
  mintTicket,
  needsRefresh,
  newerTicket,
  TICKET_TTL_MS,
  ticketKey,
} from '../src/state.js'
import { degradedState, goodState } from './helpers.js'

function mint(value: string, capturedAt = 0): ReturnType<typeof mintTicket> {
  return mintTicket({ accountId: 'acct-1', model: 'gpt-6-astra', value, capturedAt, source: 'probe' })
}

describe('classifyTurnState', () => {
  it('calls a 292-character value that starts with gAAAAA good', () => {
    expect(classifyTurnState(goodState())).toBe('good')
  })

  it('calls a 312-character value degraded', () => {
    expect(classifyTurnState(degradedState())).toBe('degraded')
  })

  it('calls a 292-character value with the wrong prefix degraded, because both conditions must hold', () => {
    expect(classifyTurnState('z'.repeat(292))).toBe('degraded')
  })

  it('calls a missing or blank header absent', () => {
    expect(classifyTurnState(undefined)).toBe('absent')
    expect(classifyTurnState('   ')).toBe('absent')
  })

  it('trims surrounding whitespace before measuring the length', () => {
    expect(classifyTurnState(`  ${goodState()}  `)).toBe('good')
  })
})

describe('describeTurnState', () => {
  it('reports the length and the verdict without printing the value', () => {
    expect(describeTurnState(goodState())).toBe('292 chars, good')
    expect(describeTurnState(degradedState())).toBe('312 chars, degraded')
  })

  it('reports an absent value as absent', () => {
    expect(describeTurnState(undefined)).toBe('absent')
  })
})

describe('mintTicket', () => {
  it('mints no ticket from a degraded value', () => {
    expect(mint(degradedState())).toBeUndefined()
  })

  it('stores the trimmed value', () => {
    expect(mint(` ${goodState()} `)?.value).toBe(goodState())
  })
})

describe('isUsable', () => {
  it('holds until the hour is up and not after it', () => {
    const ticket = mint(goodState())
    expect(isUsable(ticket, TICKET_TTL_MS - 1)).toBe(true)
    expect(isUsable(ticket, TICKET_TTL_MS)).toBe(false)
  })

  it('rejects a ticket that is missing', () => {
    expect(isUsable(undefined, 0)).toBe(false)
  })
})

describe('needsRefresh', () => {
  it('asks for a refresh in the last ten minutes while the ticket is still usable', () => {
    const ticket = mint(goodState())
    expect(needsRefresh(ticket, 3_000_000 - 1)).toBe(false)
    expect(needsRefresh(ticket, 3_000_000)).toBe(true)
    expect(isUsable(ticket, 3_000_000)).toBe(true)
  })

  it('asks for a refresh when there is no ticket at all', () => {
    expect(needsRefresh(undefined, 0)).toBe(true)
  })
})

describe('newerTicket', () => {
  it('prefers the later capture', () => {
    expect(newerTicket(mint(goodState(), 10), mint(goodState(), 20))?.capturedAt).toBe(20)
    expect(newerTicket(mint(goodState(), 30), mint(goodState(), 20))?.capturedAt).toBe(30)
  })

  it('takes whichever side exists', () => {
    expect(newerTicket(undefined, mint(goodState(), 5))?.capturedAt).toBe(5)
    expect(newerTicket(mint(goodState(), 5), undefined)?.capturedAt).toBe(5)
    expect(newerTicket(undefined, undefined)).toBeUndefined()
  })
})

describe('ticketKey', () => {
  it('separates the account from the model', () => {
    expect(ticketKey('acct-1', 'gpt-6-astra')).not.toBe(ticketKey('acct-1', 'gpt-5.6-sol'))
  })
})
