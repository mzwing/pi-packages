import { expect, it } from 'vitest'
import { DenialCounter } from '../../../src/presets/claude-code/denial-counter.js'

it('hands the twentieth denial of the session to the human prompt, however spread out, then counts afresh', () => {
  const counter = new DenialCounter()
  const limits = Array.from({ length: 20 }, () => {
    const limit = counter.recordDenial()
    counter.recordNonDenial()

    return limit
  })

  expect(limits.slice(0, 19).every(limit => limit === undefined)).toBe(true)
  expect(limits[19]).toBe('total')
  expect(counter.recordDenial()).toBeUndefined()
})
