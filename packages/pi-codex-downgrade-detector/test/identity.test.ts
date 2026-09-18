import { describe, expect, it } from 'vitest'
import { compareVersions, createIdentityResolver, describeIdentity, parseSlug } from '../src/identity.js'

describe('parseSlug', () => {
  it('splits a versioned OpenAI slug into family, version and variant', () => {
    expect(parseSlug('gpt-5.6-sol')).toMatchObject({
      vendor: 'openai',
      family: 'gpt',
      line: 'gpt',
      version: [5, 6],
      variant: 'sol',
    })
  })

  it('reads a size marker without the slug appearing in any list', () => {
    expect(parseSlug('gpt-5.7-mini')).toMatchObject({ vendor: 'openai', version: [5, 7], sizeMarker: 'mini' })
  })

  it('finds a size marker mid-slug, not only in the tail', () => {
    expect(parseSlug('claude-opus-5')).toMatchObject({ vendor: 'other', family: 'claude', largeMarker: 'opus' })
    expect(parseSlug('claude-haiku-5')).toMatchObject({ vendor: 'other', sizeMarker: 'haiku' })
  })

  it('keeps a trailing letter on a version as a variant token', () => {
    expect(parseSlug('gpt-4o')).toMatchObject({ version: [4], variant: 'o' })
  })

  it('reports an empty shape for an empty slug', () => {
    expect(parseSlug('   ')).toMatchObject({ vendor: undefined, family: undefined, version: [] })
  })
})

describe('compareVersions', () => {
  it('orders by the first differing component and pads the shorter side', () => {
    expect(compareVersions([5, 6], [5, 4])).toBeGreaterThan(0)
    expect(compareVersions([5], [5, 1])).toBeLessThan(0)
    expect(compareVersions([6], [6, 0])).toBe(0)
  })
})

describe('createIdentityResolver', () => {
  it('ranks a slug from the built-in table', () => {
    const identity = createIdentityResolver().identify('gpt-6-astra')

    expect(identity).toMatchObject({ known: true, source: 'builtin', tier: 100, tierSource: 'builtin' })
  })

  it('lets configured tiers outrank the built-in table', () => {
    const identity = createIdentityResolver({ tiers: { 'gpt-6-astra': 1 } }).identify('gpt-6-astra')

    expect(identity).toMatchObject({ tier: 1, tierSource: 'config', source: 'config' })
  })

  it('resolves a server-side suffix to its longest recorded base', () => {
    const identity = createIdentityResolver().identify('gpt-5.6-sol-codex-abuse-1p-ev3')

    expect(identity).toMatchObject({ known: true, base: 'gpt-5.6-sol', suffix: 'codex-abuse-1p-ev3', tier: 90 })
  })

  it('treats a slug the provider offers as recorded even with no rank', () => {
    const identity = createIdentityResolver({ registrySlugs: ['codex-auto-review'] }).identify('codex-auto-review')

    expect(identity).toMatchObject({ known: true, source: 'registry', tier: undefined })
  })

  it('infers a shape for a slug nothing records', () => {
    const identity = createIdentityResolver().identify('gpt-5.9-quasar')

    expect(identity).toMatchObject({ known: false, source: 'inferred', version: [5, 9] })
    expect(describeIdentity(identity!)).toContain('unrecorded, inferred from the slug')
  })

  it('leaves a bare slug with no version and no variant to the ladder to reject', () => {
    const identity = createIdentityResolver().identify('housemodel')

    expect(identity).toMatchObject({ known: false, version: [], variant: undefined })
  })

  it('returns undefined for an absent or blank slug', () => {
    const resolver = createIdentityResolver()

    expect(resolver.identify(undefined)).toBeUndefined()
    expect(resolver.identify('  ')).toBeUndefined()
  })
})
