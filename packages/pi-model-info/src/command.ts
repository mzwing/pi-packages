import type { CatalogSnapshot } from './catalog.js'
import type { ConfigIssue } from './config.js'
import type { ModelReport, ProviderReport, ProviderStrategy } from './provider-apply.js'
import type { Resolution, SnapshotModel } from './types.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { COMMAND_NAME } from './config.js'

export interface ModelInfoCommandController {
  getReports: () => ProviderReport[]
  getCatalog: () => CatalogSnapshot | undefined
  getIssues: () => ConfigIssue[]
  /** The model as Pi finally sees it, after models.json `modelOverrides`. */
  getEffectiveModel: (providerId: string, modelId: string) => SnapshotModel | undefined
  refresh: () => Promise<void>
}

const COMPLETION_LIMIT = 50

/** How current each provider's list stays — the one thing you cannot tell from the counts. */
const STRATEGY_NOTE: Record<ProviderStrategy, string> = {
  native: 'list re-read live',
  decorate: 'list re-read on refresh',
  replace: 'list fixed for this session',
}

interface ModelReference {
  providerId: string | undefined
  modelId: string
}

function splitReference(reference: string): ModelReference {
  const separator = reference.indexOf('/')

  return separator > 0
    ? { providerId: reference.slice(0, separator), modelId: reference.slice(separator + 1) }
    : { providerId: undefined, modelId: reference }
}

function age(now: number, fetchedAt: number | undefined): string {
  if (fetchedAt === undefined) {
    return 'never fetched'
  }
  const minutes = Math.max(0, Math.round((now - fetchedAt) / 60_000))

  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

function countByKind(models: ModelReport[]): Record<Resolution['kind'], number> {
  const counts = { resolved: 0, ambiguous: 0, unresolved: 0 }
  for (const model of models) {
    counts[model.resolution.kind] += 1
  }

  return counts
}

export function formatSummary(
  reports: ProviderReport[],
  catalog: CatalogSnapshot | undefined,
  issues: ConfigIssue[],
  now: number,
): string {
  const lines: string[] = []

  if (reports.length === 0) {
    lines.push('No providers opted in. Add one under "providers" in the config to complete its models.')
  }

  for (const report of reports) {
    if (report.status === 'skipped' || report.status === 'failed') {
      lines.push(`${report.provider}: ${report.status} — ${report.reason ?? 'no reason given'}`)
      continue
    }
    const counts = countByKind(report.models)
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
    lines.push('', 'config issues:')
    for (const issue of issues) {
      lines.push(`  ${issue.sourcePath}: ${issue.message}`)
    }
  }

  return lines.join('\n')
}

export function formatDetail(
  reports: ProviderReport[],
  reference: string,
  effective: SnapshotModel | undefined,
): string {
  const { providerId, modelId } = splitReference(reference)
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
    lines.push(`canonical:  ${entry.canonicalId}  (${entry.source})`)
    lines.push(`match:      ${matchKind}`)
    const rules = [prefixRule?.id, suffixRule?.id].filter((id): id is string => id !== undefined)
    if (rules.length > 0) {
      lines.push(`rule:       ${rules.join(', ')}`)
    }
  } else if (model.resolution.kind === 'ambiguous') {
    lines.push('match:      ambiguous — nothing was applied')
    lines.push('candidates:')
    for (const candidate of model.resolution.candidates) {
      lines.push(`  ${candidate.canonicalId}  (${candidate.source})`)
    }
    lines.push('Add an alias for this model to choose one.')
  } else {
    lines.push(`match:      unresolved (${model.resolution.reason})`)
  }

  const source = (field: string): string => {
    const origin = model.provenance.get(field)

    return origin === undefined || origin === 'existing' ? '' : `   from ${origin}`
  }

  lines.push('')
  lines.push(`context:    ${model.model.contextWindow}${source('contextWindow')}`)
  lines.push(`maxTokens:  ${model.model.maxTokens}${source('maxTokens')}`)
  lines.push(`reasoning:  ${model.model.reasoning}${source('reasoning')}`)
  lines.push(`input:      ${model.model.input.join(', ')}${source('input')}`)
  lines.push(`cost:       $${model.model.cost.input}/$${model.model.cost.output} per Mtok${source('cost')}`)

  // models.json `modelOverrides` are layered above this extension, so what we computed is not
  // always what Pi ends up using.
  if (effective !== undefined && diverges(effective, model)) {
    lines.push('')
    lines.push('Pi is using different values (models.json modelOverrides win over this extension):')
    lines.push(`  context: ${effective.contextWindow}   maxTokens: ${effective.maxTokens}`)
    lines.push(`  reasoning: ${effective.reasoning}   cost: $${effective.cost.input}/$${effective.cost.output}`)
  }

  if (model.issues.length > 0) {
    lines.push('')
    for (const issue of model.issues) {
      lines.push(`note: ${issue}`)
    }
  }

  if (matches.length > 1) {
    lines.push('')
    lines.push(
      `'${modelId}' also exists on: ${matches
        .slice(1)
        .map(match => match.report.provider)
        .join(', ')}`,
    )
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

export interface CompletionItem {
  value: string
  label: string
  description: string
}

/** Runs on every keystroke, so it stays a prefix filter over an already-built list. */
export function buildCompletions(reports: ProviderReport[], prefix: string): CompletionItem[] | null {
  const needle = prefix.trim().toLowerCase()
  const items: CompletionItem[] = []

  if ('refresh'.startsWith(needle)) {
    items.push({ value: 'refresh', label: 'refresh', description: 'Re-check the catalogs now' })
  }

  for (const report of reports) {
    for (const model of report.models) {
      const value = `${report.provider}/${model.id}`
      if (needle.length === 0 || value.toLowerCase().includes(needle)) {
        items.push({ value, label: value, description: model.resolution.kind })
      }
      if (items.length >= COMPLETION_LIMIT) {
        return items
      }
    }
  }

  return items.length > 0 ? items : null
}

export function registerModelInfoCommand(pi: ExtensionAPI, controller: ModelInfoCommandController): void {
  try {
    pi.registerCommand(COMMAND_NAME, {
      description: 'Inspect the model metadata pi-model-info resolved for your third-party providers',
      getArgumentCompletions(prefix) {
        return buildCompletions(controller.getReports(), prefix)
      },
      async handler(args, ctx) {
        const argument = args.trim()

        if (argument === 'refresh') {
          await controller.refresh()
        }
        if (argument === 'refresh' || argument.length === 0) {
          const summary = formatSummary(
            controller.getReports(),
            controller.getCatalog(),
            controller.getIssues(),
            Date.now(),
          )
          ctx.ui.notify(summary, 'info')

          return
        }

        const { providerId, modelId } = splitReference(argument)
        const effective = providerId === undefined ? undefined : controller.getEffectiveModel(providerId, modelId)
        ctx.ui.notify(formatDetail(controller.getReports(), argument, effective), 'info')
      },
    })
  } catch (error) {
    // `model-info` is a generic name; a clash must not take the extension down.
    console.warn(
      `[pi-model-info] could not register /${COMMAND_NAME}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
