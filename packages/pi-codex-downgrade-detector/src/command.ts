import type { DetectorConfig, DetectorConfigPaths } from './config.js'
import type { Verdict } from './verdict.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { COMMAND_NAME, EXTENSION_ID } from './config.js'
import { renderReport } from './render.js'

interface CompletionItem {
  value: string
  label: string
  description: string
}

const USAGE = `Usage: /${COMMAND_NAME} [show]`
const SUBCOMMANDS: CompletionItem[] = [
  { value: 'show', label: 'show', description: 'Show the resolved config and where it came from' },
]

export interface DetectorCommandController {
  getVerdicts: () => readonly Verdict[]
  getConfig: () => DetectorConfig
  getPaths: () => DetectorConfigPaths | undefined
}

function formatConfig(config: DetectorConfig, paths: DetectorConfigPaths | undefined): string {
  const tiers = Object.entries(config.tiers)

  return [
    `providers   : ${config.providers.length > 0 ? config.providers.join(', ') : '(every provider)'}`,
    `checkEffort : ${config.checkEffort}`,
    `notify      : ${config.notify}`,
    `tiers       : ${tiers.length > 0 ? tiers.map(([slug, rank]) => `${slug}=${rank}`).join(', ') : '(built-in only)'}`,
    '',
    `global  : ${paths?.globalPath ?? '(unknown until the session starts)'}`,
    `project : ${paths?.projectPath ?? '(unknown until the session starts)'}`,
  ].join('\n')
}

export function registerDetectorCommand(pi: ExtensionAPI, controller: DetectorCommandController): void {
  try {
    pi.registerCommand(COMMAND_NAME, {
      description: 'Report which model actually served each turn in this session',
      getArgumentCompletions(prefix) {
        const matches = SUBCOMMANDS.filter(item => item.value.startsWith(prefix.trim()))

        return matches.length > 0 ? matches : null
      },
      handler: async (args, ctx) => {
        const argument = args.trim().toLowerCase()
        if (argument.length === 0) {
          ctx.ui.notify(renderReport(controller.getVerdicts()), 'info')

          return
        }
        if (argument === 'show') {
          ctx.ui.notify(formatConfig(controller.getConfig(), controller.getPaths()), 'info')

          return
        }
        ctx.ui.notify(USAGE, 'warning')
      },
    })
  } catch (error) {
    // `codex-downgrade` is a plausible name for someone else's command; a clash must not take
    // the extension down, because the footer is the part that matters.
    console.warn(
      `[${EXTENSION_ID}] could not register /${COMMAND_NAME}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
