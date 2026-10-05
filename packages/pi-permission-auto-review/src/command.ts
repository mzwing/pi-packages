import type { ConfigScope, LoadConfigResult } from './config-store.js'
import type { AutoReviewConfig, AutoReviewConfigFile } from './config.js'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { configPath, loadConfig, readActiveScope, readScope, resetScope, saveScope } from './config-store.js'
import { DEFAULT_CONFIG, DEFAULT_MODEL, DEFAULT_PROVIDER, MAX_TIMEOUT_MS, REASONING_LEVELS } from './config.js'

const COMMAND_NAME = 'permission-auto-review'
const USAGE = `Usage: /${COMMAND_NAME} [show|path|reset [global|project]|help]`
const INHERIT = 'Use inherited value'
const CUSTOM = 'Enter custom value...'
const VALUE_PREFIX = 'Value: '
const SAVE = 'Save changes'
const CANCEL = 'Cancel'
const WHITESPACE = /\s+/

type ConfigField = Exclude<keyof AutoReviewConfig, '$schema'>

type Layers = Record<ConfigScope, AutoReviewConfigFile>

type Editor = (
  ctx: ExtensionCommandContext,
  draft: AutoReviewConfigFile,
  effective: AutoReviewConfig,
) => Promise<AutoReviewConfigFile>

export type ActivationResult = { kind: 'active' } | { kind: 'pending' } | { kind: 'failed'; message: string }

export interface AutoReviewCommandController {
  getActiveConfig: () => AutoReviewConfig | undefined
  applyConfig: (result: LoadConfigResult) => ActivationResult
}

function withField<K extends ConfigField>(
  draft: AutoReviewConfigFile,
  field: K,
  value: AutoReviewConfig[K] | undefined,
): AutoReviewConfigFile {
  const { [field]: _removed, ...rest } = draft

  return value === undefined ? rest : { ...draft, [field]: value }
}

function editString(
  field: 'provider' | 'model',
  title: string,
  known: (effective: AutoReviewConfig, ctx: ExtensionCommandContext) => string[],
): Editor {
  return async (ctx, draft, effective) => {
    const current = effective[field]
    const values = [...new Set([...known(effective, ctx), current])].toSorted((left, right) =>
      left.localeCompare(right),
    )
    const selected = await ctx.ui.select(title, [INHERIT, ...values.map(value => `${VALUE_PREFIX}${value}`), CUSTOM])
    if (selected === INHERIT) {
      return withField(draft, field, undefined)
    }
    if (selected === CUSTOM) {
      const custom = (await ctx.ui.input(title, current))?.trim()

      return custom === undefined || custom === '' ? draft : withField(draft, field, custom)
    }

    return selected?.startsWith(VALUE_PREFIX) === true
      ? withField(draft, field, selected.slice(VALUE_PREFIX.length))
      : draft
  }
}

const EDITORS: Record<ConfigField, { label: string; edit: Editor; format?: (value: unknown) => string }> = {
  provider: {
    label: 'Provider',
    edit: editString('provider', 'Configure Provider', (_effective, ctx) => [
      ...ctx.modelRegistry.getAll().map(model => model.provider),
      DEFAULT_PROVIDER,
    ]),
  },
  model: {
    label: 'Model',
    edit: editString('model', 'Configure Model', (effective, ctx) => [
      ...ctx.modelRegistry
        .getAll()
        .filter(model => model.provider === effective.provider)
        .map(model => model.id),
      ...(effective.provider === DEFAULT_PROVIDER ? [DEFAULT_MODEL] : []),
    ]),
  },
  reasoning: {
    label: 'Reasoning',
    edit: async (ctx, draft) => {
      const selected = await ctx.ui.select('Configure Reasoning', [INHERIT, ...REASONING_LEVELS])
      if (selected === INHERIT) {
        return withField(draft, 'reasoning', undefined)
      }
      const reasoning = REASONING_LEVELS.find(level => level === selected)

      return reasoning === undefined ? draft : withField(draft, 'reasoning', reasoning)
    },
  },
  timeoutMs: {
    label: 'Timeout',
    format: value => (typeof value === 'number' ? `${value} ms` : String(value ?? 'not set')),
    edit: async (ctx, draft, effective) => {
      const action = await ctx.ui.select('Configure Timeout', [INHERIT, 'Enter timeout...'])
      if (action === INHERIT) {
        return withField(draft, 'timeoutMs', undefined)
      }
      const source =
        action === undefined ? undefined : await ctx.ui.input('Timeout in milliseconds', String(effective.timeoutMs))
      if (source === undefined) {
        return draft
      }
      const timeoutMs = Number(source.trim())
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
        ctx.ui.notify(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`, 'warning')

        return draft
      }

      return withField(draft, 'timeoutMs', timeoutMs)
    },
  },
  includeBaselinePolicy: {
    label: 'Baseline policy',
    edit: async (ctx, draft) => {
      const selected = await ctx.ui.select('Configure Baseline Policy', [INHERIT, 'Enabled', 'Disabled'])
      if (selected === INHERIT) {
        return withField(draft, 'includeBaselinePolicy', undefined)
      }

      return selected === undefined ? draft : withField(draft, 'includeBaselinePolicy', selected === 'Enabled')
    },
  },
  additionalPolicy: {
    label: 'Additional policy',
    format: value => (typeof value === 'string' && value.length > 0 ? 'configured' : 'not set'),
    edit: async (ctx, draft, effective) => {
      const selected = await ctx.ui.select('Configure Additional Policy', ['Edit policy...', INHERIT])
      if (selected === INHERIT) {
        return withField(draft, 'additionalPolicy', undefined)
      }
      const value =
        selected === undefined
          ? undefined
          : await ctx.ui.editor('Additional review policy', effective.additionalPolicy ?? '')
      if (value === undefined) {
        return draft
      }

      return withField(draft, 'additionalPolicy', value.trim() === '' ? undefined : value.trim())
    },
  },
}

const FIELDS = Object.keys(EDITORS) as ConfigField[]

function originOf(layers: Layers, field: ConfigField): ConfigScope | 'default' {
  if (Object.hasOwn(layers.project, field)) {
    return 'project'
  }

  return Object.hasOwn(layers.global, field) ? 'global' : 'default'
}

function formatValue(field: ConfigField, value: unknown): string {
  return EDITORS[field].format?.(value) ?? String(value ?? 'not set')
}

/** Layer precedence without the schema, which rejects a draft that still breaks the cross-field rule. */
function effectiveConfig(layers: Layers): AutoReviewConfig {
  const effective = { ...DEFAULT_CONFIG }
  for (const field of FIELDS) {
    const value = layers.project[field] ?? layers.global[field]
    if (value !== undefined) {
      Object.assign(effective, { [field]: value })
    }
  }

  return effective
}

async function chooseScope(ctx: ExtensionCommandContext, title: string): Promise<ConfigScope | undefined> {
  const selected = await ctx.ui.select(title, ['Global configuration', 'Project configuration'])
  if (selected === undefined) {
    return undefined
  }

  return selected === 'Global configuration' ? 'global' : 'project'
}

function notifyActivation(
  ctx: ExtensionCommandContext,
  activation: ActivationResult,
  messages: { failed: string; pending: string; active: string },
): void {
  if (activation.kind === 'failed') {
    ctx.ui.notify(`${messages.failed}: ${activation.message}`, 'error')
  } else if (activation.kind === 'pending') {
    ctx.ui.notify(messages.pending, 'warning')
  } else {
    ctx.ui.notify(messages.active, 'info')
  }
}

async function openSettingsMenu(ctx: ExtensionCommandContext, controller: AutoReviewCommandController): Promise<void> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify(`/${COMMAND_NAME} requires interactive TUI mode.`, 'warning')

    return
  }
  await ctx.waitForIdle()
  const scope = await chooseScope(ctx, 'Select configuration scope')
  if (scope === undefined) {
    return
  }
  const projectTrusted = ctx.isProjectTrusted()
  if (scope === 'project' && !projectTrusted) {
    ctx.ui.notify('Project config is ignored until Pi trusts this project.', 'warning')

    return
  }

  const selected = readScope(ctx.cwd, scope)
  const other = readActiveScope(ctx.cwd, scope === 'global' ? 'project' : 'global', projectTrusted)
  const cannotEdit = (snapshot: { path: string; issue: string }): void => {
    ctx.ui.notify(
      `Cannot edit config at '${snapshot.path}': ${snapshot.issue}. Use reset to remove it or fix it manually.`,
      'error',
    )
  }
  if (!selected.valid) {
    cannotEdit(selected)

    return
  }
  if (!other.valid) {
    cannotEdit(other)

    return
  }

  let draft = selected.config
  for (;;) {
    const layers: Layers =
      scope === 'global' ? { global: draft, project: other.config } : { global: other.config, project: draft }
    const effective = effectiveConfig(layers)
    const options = FIELDS.map(field => {
      const state = Object.hasOwn(draft, field) ? 'override' : 'inherit'

      return `${EDITORS[field].label}: ${formatValue(field, effective[field])} (source: ${originOf(layers, field)}; ${scope}: ${state})`
    })
    const choice = await ctx.ui.select(`Permission auto-review settings (${scope})`, [...options, SAVE, CANCEL])
    if (choice === undefined || choice === CANCEL) {
      return
    }
    if (choice === SAVE) {
      const saved = saveScope(selected, draft, projectTrusted)
      if (!saved.ok) {
        ctx.ui.notify(saved.message, 'error')
        continue
      }
      notifyActivation(ctx, controller.applyConfig(saved.loadResult), {
        failed: 'Config saved, but the current reviewer could not be replaced',
        pending: 'Config saved. It will become active when pi-permission-system is ready.',
        active: 'Config saved and applied without reloading the Pi session.',
      })

      return
    }
    const field = FIELDS[options.indexOf(choice)]
    if (field !== undefined) {
      draft = await EDITORS[field].edit(ctx, draft, effective)
    }
  }
}

function showConfig(ctx: ExtensionCommandContext, active: AutoReviewConfig | undefined): void {
  const projectTrusted = ctx.isProjectTrusted()
  const global = readScope(ctx.cwd, 'global')
  const project = readActiveScope(ctx.cwd, 'project', projectTrusted)
  if (active === undefined || !global.valid || !project.valid) {
    const issues = loadConfig(ctx.cwd, projectTrusted)
      .issues.map(issue => `\n${issue}`)
      .join('')
    ctx.ui.notify(`Automatic review is disabled because the active config is invalid.${issues}`, 'warning')

    return
  }

  const layers = { global: global.config, project: project.config }
  const lines = FIELDS.map(field => `${field}=${formatValue(field, active[field])} (${originOf(layers, field)})`)
  const ignored = projectTrusted ? '' : ' (ignored until Pi trusts this project)'
  ctx.ui.notify(
    `permission-auto-review:\n${lines.join('\n')}\nglobal=${global.path}\nproject=${project.path}${ignored}`,
    'info',
  )
}

async function resetConfig(
  ctx: ExtensionCommandContext,
  controller: AutoReviewCommandController,
  requested: string | undefined,
): Promise<void> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify(`/${COMMAND_NAME} reset requires interactive TUI mode.`, 'warning')

    return
  }
  await ctx.waitForIdle()
  if (requested !== undefined && requested !== 'global' && requested !== 'project') {
    ctx.ui.notify(USAGE, 'warning')

    return
  }
  const scope = requested ?? (await chooseScope(ctx, 'Select configuration scope to reset'))
  if (scope === undefined) {
    return
  }

  const snapshot = readScope(ctx.cwd, scope)
  const confirmed = await ctx.ui.confirm(
    `Reset ${scope} auto-review config?`,
    `Delete '${snapshot.path}' and immediately apply inherited values?`,
  )
  if (!confirmed) {
    return
  }
  const reset = resetScope(snapshot, ctx.isProjectTrusted())
  if (!reset.ok) {
    ctx.ui.notify(reset.message, 'error')

    return
  }
  notifyActivation(ctx, controller.applyConfig(reset.loadResult), {
    failed: 'Config reset, but the current reviewer could not be replaced',
    pending: `${scope} config reset. The inherited config will activate when pi-permission-system is ready.`,
    active: `${scope} config reset and inherited values applied without reloading the Pi session.`,
  })
}

const SUBCOMMANDS = [
  { value: 'show', label: 'Show active config', description: 'Display effective values and their origins' },
  { value: 'path', label: 'Show config paths', description: 'Display global and project config paths' },
  { value: 'reset', label: 'Reset config', description: 'Delete one config layer and apply inherited values' },
  { value: 'help', label: 'Show help', description: 'Display command usage' },
]

const RESET_SCOPES = [
  { value: 'reset global', label: 'Reset global config', description: 'Delete the global auto-review config' },
  { value: 'reset project', label: 'Reset project config', description: 'Delete the project auto-review config' },
]

export function registerAutoReviewCommand(pi: ExtensionAPI, controller: AutoReviewCommandController): void {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Configure pi-permission-auto-review without reloading the Pi session',
    getArgumentCompletions(prefix) {
      const normalized = prefix.trimStart().toLowerCase()
      const matches = (normalized.startsWith('reset ') ? RESET_SCOPES : SUBCOMMANDS).filter(item =>
        item.value.startsWith(normalized),
      )

      return matches.length > 0 ? matches : null
    },
    async handler(args, ctx) {
      const normalized = args.trim().toLowerCase()
      if (normalized === '') {
        await openSettingsMenu(ctx, controller)
      } else if (normalized === 'show') {
        showConfig(ctx, controller.getActiveConfig())
      } else if (normalized === 'path') {
        ctx.ui.notify(
          `permission-auto-review config paths:\nglobal=${configPath(ctx.cwd, 'global')}\nproject=${configPath(ctx.cwd, 'project')}`,
          'info',
        )
      } else if (normalized === 'help') {
        ctx.ui.notify(USAGE, 'info')
      } else if (normalized === 'reset' || normalized.startsWith('reset ')) {
        await resetConfig(ctx, controller, normalized.split(WHITESPACE)[1])
      } else {
        ctx.ui.notify(USAGE, 'warning')
      }
    },
  })
}
