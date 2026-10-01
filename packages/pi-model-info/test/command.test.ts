import type { ProviderReport } from '../src/provider-apply.js'
import type { Resolution } from '../src/types.js'
import { expect, it } from 'vitest'
import { formatDetail } from '../src/command.js'
import { mergeMetadata } from '../src/merge.js'
import { entry, makeProvider, makeSnapshot } from './helpers.js'

function report(resolution: Resolution): ProviderReport[] {
  const { model, provenance } = mergeMetadata({ snapshot: makeSnapshot(), provider: makeProvider(), resolution })

  return [
    {
      provider: 'relay',
      status: 'applied',
      reason: undefined,
      models: [{ id: 'gpt-5.5', resolution, provenance, model }],
    },
  ]
}

it('lists the candidates of an ambiguous model, so an alias can pick one', () => {
  const candidates = [entry({ provider: 'openai', id: 'gpt-5.5' }), entry({ provider: 'azure', id: 'gpt-5.5' })]
  const text = formatDetail(report({ kind: 'ambiguous', candidates }), 'relay/gpt-5.5', () => undefined)

  expect(text).toContain('ambiguous — nothing was applied')
  expect(text).toContain('  openai/gpt-5.5  (pi.dev)\n  azure/gpt-5.5  (pi.dev)')
  expect(text).toContain('Add an alias')
})

// models.json `modelOverrides` are layered above this extension, so its result is not always what Pi uses.
it('shows what Pi actually uses when it differs from the completion', () => {
  const resolved: Resolution = {
    kind: 'resolved',
    entry: entry({ id: 'openai/gpt-5.5', contextWindow: 400_000 }),
    donor: undefined,
    matchKind: 'exact',
    prefixRule: undefined,
    suffixRule: undefined,
  }
  const effective = makeSnapshot({ contextWindow: 1_000 })

  expect(formatDetail(report(resolved), 'gpt-5.5', () => effective)).toContain('Pi is using different values')
  expect(formatDetail(report(resolved), 'gpt-5.5', () => ({ ...effective, contextWindow: 400_000 }))).not.toContain(
    'Pi is using different values',
  )
})
