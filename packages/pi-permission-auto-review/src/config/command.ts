import type { AutoReviewConfig, AutoReviewConfigFile, RuleListName } from './config.js'
import type { ConfigScope, LoadConfigResult } from './store.js'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { PRESETS } from '../presets/presets.js'
import {
  DEFAULT_CONFIG,
  DEFAULTS_ENTRY,
  FOLLOW_UP_REVIEW_MODES,
  mergeConfig,
  PRESET_DEFAULTS,
  PRESET_NAMES,
  REASONING_LEVELS,
  RULE_LISTS,
  validateConfigFile,
} from './config.js'
import { configPath, loadConfig, readActiveScope, readScope, resetScope, saveScope } from './store.js'

const COMMAND_NAME = 'permission-auto-review'
const USAGE = `Usage: /${COMMAND_NAME} [show|path|defaults|reset [global|project]|help]`
const INHERIT = 'Use inherited value'
const CUSTOM = 'Enter custom value...'
const EDIT_RULES = 'Edit rules...'
const VALUE_PREFIX = 'Value: '
const SAVE = 'Save changes'
const CANCEL = 'Cancel'
const WHITESPACE = /\s+/
const PARAGRAPH_BREAK = /\n\s*\n/
const HEADING_MARK = /^#+\s*/
const LABEL_END = /[[:]/
const MAX_LABEL_LENGTH = 60

type ConfigField = Exclude<keyof AutoReviewConfig, '$schema' | 'autoMode'>

type Layers = Record<ConfigScope, AutoReviewConfigFile>

type Editor = (
  ctx: ExtensionCommandContext,
  draft: AutoReviewConfigFile,
  effective: AutoReviewConfig,
) => Promise<AutoReviewConfigFile>

interface Setting {
  /** The name `show` prints, spelled as in the config file */
  key: string
  label: string
  isSetIn: (file: AutoReviewConfigFile) => boolean
  format: (config: AutoReviewConfig) => string
  edit: Editor
}

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

function withRules(draft: AutoReviewConfigFile, list: RuleListName, rules: string[] | undefined): AutoReviewConfigFile {
  const { autoMode: { [list]: _removed, ...others } = {}, ...rest } = draft
  const autoMode = rules === undefined ? others : { ...others, [list]: rules }

  return Object.keys(autoMode).length === 0 ? rest : { ...rest, autoMode }
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

function editChoice<K extends 'preset' | 'reasoning' | 'followUpReviews'>(
  field: K,
  title: string,
  choices: readonly AutoReviewConfig[K][],
): Editor {
  return async (ctx, draft) => {
    const selected = await ctx.ui.select(title, [INHERIT, ...choices])
    if (selected === INHERIT) {
      return withField(draft, field, undefined)
    }
    const choice = choices.find(candidate => candidate === selected)

    return choice === undefined ? draft : withField(draft, field, choice)
  }
}

function editInteger(field: 'timeoutMs' | 'maxRetries' | 'attemptTimeoutMs', title: string, prompt: string): Editor {
  return async (ctx, draft, effective) => {
    const selected = await ctx.ui.select(title, [INHERIT, CUSTOM])
    if (selected === INHERIT) {
      return withField(draft, field, undefined)
    }
    const input =
      selected === undefined ? undefined : (await ctx.ui.input(prompt, String(effective[field] ?? '')))?.trim()
    if (input === undefined || input === '') {
      return draft
    }
    const value = Number(input)
    const validated = validateConfigFile({ [field]: value })
    if (!validated.ok) {
      ctx.ui.notify(validated.issue, 'warning')

      return draft
    }

    return withField(draft, field, value)
  }
}

function editRules(list: RuleListName, title: string): Editor {
  return async (ctx, draft, effective) => {
    const selected = await ctx.ui.select(title, [EDIT_RULES, INHERIT])
    if (selected === INHERIT) {
      return withRules(draft, list, undefined)
    }
    // Rules copied from Claude Code span several lines, so a blank line is what separates two of them
    const text =
      selected === undefined
        ? undefined
        : await ctx.ui.editor(
            `${title}: one rule per paragraph, and ${DEFAULTS_ENTRY} for the built-in ones`,
            effective.autoMode[list].join('\n\n'),
          )
    if (text === undefined) {
      return draft
    }
    const rules = text
      .split(PARAGRAPH_BREAK)
      .map(rule => rule.trim())
      .filter(rule => rule !== '')

    return withRules(draft, list, rules)
  }
}

function formatMilliseconds(value: number): string {
  return `${value} ms`
}

/** The lists' rules stay out of the menu and `show`, like any policy text */
function summarizeRules(rules: readonly string[]): string {
  const custom = rules.filter(rule => rule !== DEFAULTS_ENTRY).length
  const parts = [
    ...(rules.includes(DEFAULTS_ENTRY) ? [DEFAULTS_ENTRY] : []),
    ...(custom > 0 ? [`${custom} custom`] : []),
  ]

  return parts.length > 0 ? parts.join(' + ') : 'none'
}

function fieldSetting<K extends ConfigField>(
  field: K,
  label: string,
  edit: Editor,
  format: (value: NonNullable<AutoReviewConfig[K]>) => string = String,
): Setting {
  return {
    key: field,
    label,
    isSetIn: file => Object.hasOwn(file, field),
    format: config => {
      const value = config[field]

      return value === undefined ? 'not set' : format(value)
    },
    edit,
  }
}

function ruleSetting(list: RuleListName, label: string): Setting {
  return {
    key: `autoMode.${list}`,
    label,
    isSetIn: file => file.autoMode !== undefined && Object.hasOwn(file.autoMode, list),
    format: config => summarizeRules(config.autoMode[list]),
    edit: editRules(list, `Configure ${label}`),
  }
}

const PRESET_DEFAULT_VALUES = Object.values(PRESET_DEFAULTS)

const SETTINGS: readonly Setting[] = [
  fieldSetting('preset', 'Preset', editChoice('preset', 'Configure Preset', PRESET_NAMES)),
  fieldSetting(
    'provider',
    'Provider',
    editString('provider', 'Configure Provider', (_effective, ctx) => [
      ...ctx.modelRegistry.getAll().map(model => model.provider),
      ...PRESET_DEFAULT_VALUES.map(defaults => defaults.provider),
    ]),
  ),
  fieldSetting(
    'model',
    'Model',
    editString('model', 'Configure Model', (effective, ctx) => [
      ...ctx.modelRegistry
        .getAll()
        .filter(model => model.provider === effective.provider)
        .map(model => model.id),
      // A preset's own model, like `codex-auto-review`, may be missing from the registry
      ...PRESET_DEFAULT_VALUES.filter(defaults => defaults.provider === effective.provider).map(
        defaults => defaults.model,
      ),
    ]),
  ),
  fieldSetting('reasoning', 'Reasoning', editChoice('reasoning', 'Configure Reasoning', REASONING_LEVELS)),
  fieldSetting(
    'timeoutMs',
    'Timeout',
    editInteger('timeoutMs', 'Configure Timeout', 'Timeout in milliseconds'),
    formatMilliseconds,
  ),
  fieldSetting('maxRetries', 'Retries', editInteger('maxRetries', 'Configure Retries', 'Retries after the first call')),
  fieldSetting(
    'attemptTimeoutMs',
    'Attempt timeout',
    editInteger('attemptTimeoutMs', 'Configure Attempt Timeout', 'Attempt timeout in milliseconds'),
    formatMilliseconds,
  ),
  fieldSetting(
    'followUpReviews',
    'Follow-up reviews',
    editChoice('followUpReviews', 'Configure Follow-up Reviews', FOLLOW_UP_REVIEW_MODES),
  ),
  ruleSetting('environment', 'Environment'),
  ruleSetting('allow', 'Allow rules'),
  ruleSetting('soft_deny', 'Soft deny rules'),
  ruleSetting('hard_deny', 'Hard deny rules'),
]

function originOf(layers: Layers, setting: Setting): ConfigScope | 'default' {
  if (setting.isSetIn(layers.project)) {
    return 'project'
  }

  return setting.isSetIn(layers.global) ? 'global' : 'default'
}

/** A built-in rule's name: its first line up to a `[` or `:`, without a Markdown heading mark */
function ruleLabel(rule: string): string {
  const label = ((rule.split('\n', 1)[0] ?? '').replace(HEADING_MARK, '').split(LABEL_END, 1)[0] ?? '').trim()

  return label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…` : label
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
    const effective = mergeConfig(layers.global, layers.project)
    const options = SETTINGS.map(setting => {
      const state = setting.isSetIn(draft) ? 'override' : 'inherit'

      return `${setting.label}: ${setting.format(effective)} (source: ${originOf(layers, setting)}; ${scope}: ${state})`
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
    const setting = SETTINGS[options.indexOf(choice)]
    if (setting !== undefined) {
      draft = await setting.edit(ctx, draft, effective)
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
  const lines = SETTINGS.map(setting => `${setting.key}=${setting.format(active)} (${originOf(layers, setting)})`)
  const ignored = projectTrusted ? '' : ' (ignored until Pi trusts this project)'
  ctx.ui.notify(
    `permission-auto-review:\n${lines.join('\n')}\nglobal=${global.path}\nproject=${project.path}${ignored}`,
    'info',
  )
}

function showDefaults(ctx: ExtensionCommandContext, active: AutoReviewConfig | undefined): void {
  const { preset } = active ?? DEFAULT_CONFIG
  const { builtInRules } = PRESETS[preset]
  const lines = RULE_LISTS.map(list => `${list}: ${builtInRules[list].map(ruleLabel).join(', ') || 'none'}`)
  ctx.ui.notify(
    `Built-in rules of the ${preset} preset, which ${DEFAULTS_ENTRY} stands for:\n${lines.join('\n')}`,
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
  { value: 'defaults', label: 'Show built-in rules', description: `List the rules ${DEFAULTS_ENTRY} stands for` },
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
      } else if (normalized === 'defaults') {
        showDefaults(ctx, controller.getActiveConfig())
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
