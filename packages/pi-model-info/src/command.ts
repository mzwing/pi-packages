import type { CatalogSnapshot } from './catalog.js'
import type { ModelReport, ProviderReport, ProviderStrategy } from './provider-apply.js'
import type { Resolution, SnapshotModel } from './types.js'

export const COMMAND_NAME = 'model-info'

const COMPLETION_LIMIT = 50

interface CompletionItem {
  value: string
  label: string
  description: string
}

/** How current each provider's list stays, the one thing the counts cannot tell. */
const STRATEGY_NOTE: Record<ProviderStrategy, string> = {
  native: 'list re-read live',
  decorate: 'list re-read on refresh',
  replace: 'list fixed for this session',
}

function age(now: number, fetchedAt: number | undefined): string {
  if (fetchedAt === undefined) {
    return 'never fetched'
  }
  const minutes = Math.max(0, Math.round((now - fetchedAt) / 60_000))

  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

export function formatSummary(
  reports: ProviderReport[],
  catalog: CatalogSnapshot | undefined,
  issues: string[],
  now: number,
): string {
  const lines: string[] = []
  if (reports.length === 0) {
    lines.push('No providers opted in. Add one under "providers" in the config to complete its models.')
  }

  for (const report of reports) {
    if (report.status === 'skipped' || report.status === 'failed') {
      lines.push(`${report.provider}: ${report.status} — ${report.reason}`)
      continue
    }
    const counts: Record<Resolution['kind'], number> = { resolved: 0, ambiguous: 0, unresolved: 0 }
    for (const model of report.models) {
      counts[model.resolution.kind] += 1
    }
    const note = report.strategy === undefined ? '' : ` · ${STRATEGY_NOTE[report.strategy]}`
    lines.push(
      `${report.provider}: ${counts.resolved} completed, ${counts.ambiguous} ambiguous, ` +
        `${counts.unresolved} unresolved (${report.models.length} models)${note}`,
    )
  }

  if (catalog === undefined) {
    lines.push('', 'catalogs: not loaded yet')
  } else {
    lines.push('', catalog.status === 'ready' ? 'catalogs:' : 'catalogs: unavailable — nothing was applied')
    for (const source of catalog.sources) {
      const error = source.lastError === undefined ? '' : ` — ${source.lastError}`
      lines.push(`  ${source.source}: ${source.entryCount} entries, ${age(now, source.fetchedAt)}${error}`)
    }
  }

  if (issues.length > 0) {
    lines.push('', 'config issues:', ...issues.map(issue => `  ${issue}`))
  }

  return lines.join('\n')
}

function diverges(effective: SnapshotModel, report: ModelReport): boolean {
  return (
    effective.contextWindow !== report.model.contextWindow ||
    effective.maxTokens !== report.model.maxTokens ||
    effective.reasoning !== report.model.reasoning ||
    effective.cost.input !== report.model.cost.input ||
    effective.cost.output !== report.model.cost.output
  )
}

/** `find` reads the model as Pi finally sees it, after models.json `modelOverrides`. */
export function formatDetail(
  reports: ProviderReport[],
  reference: string,
  find: (providerId: string, modelId: string) => SnapshotModel | undefined,
): string {
  const separator = reference.indexOf('/')
  const providerId = separator > 0 ? reference.slice(0, separator) : undefined
  const modelId = separator > 0 ? reference.slice(separator + 1) : reference
  const matches = reports.flatMap(report =>
    report.models
      .filter(model => model.id === modelId && (providerId === undefined || report.provider === providerId))
      .map(model => ({ report, model })),
  )
  const first = matches[0]
  if (first === undefined) {
    return `No completed model matches '${reference}'. Run /${COMMAND_NAME} to see what is covered.`
  }

  const { report, model } = first
  const lines = [`requested:  ${report.provider}/${model.id}`]
  if (model.resolution.kind === 'resolved') {
    const { entry, matchKind, prefixRule, suffixRule } = model.resolution
    lines.push(`canonical:  ${entry.canonicalId}  (${entry.source})`, `match:      ${matchKind}`)
    const rules = [prefixRule?.id, suffixRule?.id].filter(id => id !== undefined)
    if (rules.length > 0) {
      lines.push(`rule:       ${rules.join(', ')}`)
    }
  } else if (model.resolution.kind === 'ambiguous') {
    lines.push(
      'match:      ambiguous — nothing was applied',
      'candidates:',
      ...model.resolution.candidates.map(candidate => `  ${candidate.canonicalId}  (${candidate.source})`),
      'Add an alias for this model to choose one.',
    )
  } else {
    lines.push(`match:      unresolved (${model.resolution.reason})`)
  }

  const source = (field: string): string => {
    const origin = model.provenance.get(field)

    return origin === undefined || origin === 'existing' ? '' : `   from ${origin}`
  }
  lines.push(
    '',
    `context:    ${model.model.contextWindow}${source('contextWindow')}`,
    `maxTokens:  ${model.model.maxTokens}${source('maxTokens')}`,
    `reasoning:  ${model.model.reasoning}${source('reasoning')}`,
    `input:      ${model.model.input.join(', ')}${source('input')}`,
    `cost:       $${model.model.cost.input}/$${model.model.cost.output} per Mtok${source('cost')}`,
  )

  // models.json `modelOverrides` are layered above this extension, so its result is not always what Pi uses.
  const effective = find(report.provider, model.id)
  if (effective !== undefined && diverges(effective, model)) {
    lines.push(
      '',
      'Pi is using different values (models.json modelOverrides win over this extension):',
      `  context: ${effective.contextWindow}   maxTokens: ${effective.maxTokens}`,
      `  reasoning: ${effective.reasoning}   cost: $${effective.cost.input}/$${effective.cost.output}`,
    )
  }

  if (matches.length > 1) {
    lines.push(
      '',
      `'${modelId}' also exists on: ${matches
        .slice(1)
        .map(match => match.report.provider)
        .join(', ')}`,
    )
  }

  return lines.join('\n')
}

/** Runs on every keystroke, so it only filters what the reports already hold. */
export function buildCompletions(reports: ProviderReport[], prefix: string): CompletionItem[] | null {
  const needle = prefix.trim().toLowerCase()
  const items: CompletionItem[] = []
  if ('refresh'.startsWith(needle)) {
    items.push({ value: 'refresh', label: 'refresh', description: 'Re-check the catalogs now' })
  }
  for (const report of reports) {
    for (const model of report.models) {
      const value = `${report.provider}/${model.id}`
      if (value.toLowerCase().includes(needle)) {
        items.push({ value, label: value, description: model.resolution.kind })
      }
      if (items.length >= COMPLETION_LIMIT) {
        return items
      }
    }
  }

  return items.length > 0 ? items : null
}
