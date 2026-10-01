import { expect, it } from 'vitest'
import { createIdentityResolver } from '../src/identity.js'

it('resolves a server-side suffix to its longest recorded base and borrows its rank', () => {
  expect(createIdentityResolver({}, [])('gpt-5.4-mini-2026')).toMatchObject({
    known: true,
    base: 'gpt-5.4-mini',
    tier: 25,
  })
})
