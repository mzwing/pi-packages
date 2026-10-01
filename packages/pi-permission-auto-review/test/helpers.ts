import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'

/** A throwaway project and agent dir, with `PI_CODING_AGENT_DIR` pointed at the latter. */
export function useWorkspace(): { cwd: string } {
  const workspace = { cwd: '' }
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-permission-auto-review-'))
    workspace.cwd = join(root, 'project')
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  return workspace
}

export function writeFile(path: string, contents: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
}

export function permissionDetails(overrides: Partial<PromptPermissionDetails> = {}): PromptPermissionDetails {
  return {
    requestId: 'request-1',
    source: 'tool_call',
    agentName: null,
    payload: {
      kind: 'bash',
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: 'bash',
        toolName: 'bash',
        invokedToolName: null,
        value: 'pnpm publish',
        matchedPattern: 'pnpm publish*',
        commandContext: null,
        executedUnit: null,
      },
      evidence: [{ label: 'command', text: 'pnpm publish', detail: null }],
      annotations: [],
    },
    toolName: 'bash',
    command: 'pnpm publish',
    surface: 'bash',
    ...overrides,
  }
}
