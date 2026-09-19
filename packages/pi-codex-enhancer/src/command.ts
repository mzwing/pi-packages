import type { ReportView } from './render.js'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { COMMAND_NAME, EXTENSION_ID } from './config.js'
import { renderReport } from './render.js'

interface CompletionItem {
  value: string
  label: string
  description: string
}

const USAGE = `Usage: /${COMMAND_NAME} [refresh|forget]`
const SUBCOMMANDS: CompletionItem[] = [
  { value: 'refresh', label: 'refresh', description: 'Mint a new turn state now, ignoring the probe interval' },
  { value: 'forget', label: 'forget', description: 'Drop the stored turn state, for instance after switching account' },
]

export interface EnhancerCommandController {
  getReport: () => ReportView
  refresh: (context: ExtensionContext) => Promise<string>
  forget: (context: ExtensionContext) => string
}

export function registerEnhancerCommand(pi: ExtensionAPI, controller: EnhancerCommandController): void {
  try {
    pi.registerCommand(COMMAND_NAME, {
      description: 'Report and control the Codex turn state this session puts on its requests',
      getArgumentCompletions(prefix) {
        const matches = SUBCOMMANDS.filter(item => item.value.startsWith(prefix.trim()))

        return matches.length > 0 ? matches : null
      },
      handler: async (args, ctx) => {
        const argument = args.trim().toLowerCase()
        if (argument.length === 0) {
          ctx.ui.notify(renderReport(controller.getReport()), 'info')

          return
        }
        if (argument === 'refresh') {
          ctx.ui.notify(await controller.refresh(ctx), 'info')

          return
        }
        if (argument === 'forget') {
          ctx.ui.notify(controller.forget(ctx), 'info')

          return
        }
        ctx.ui.notify(USAGE, 'warning')
      },
    })
  } catch (error) {
    // `codex-enhancer` is a plausible name for someone else's command; a clash must not take the
    // extension down, because the header injection is the part that matters.
    console.warn(
      `[${EXTENSION_ID}] could not register /${COMMAND_NAME}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
