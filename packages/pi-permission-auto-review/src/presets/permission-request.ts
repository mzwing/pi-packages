import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'

const PERMISSION_FIELDS = [
  'requestId',
  'source',
  'agentName',
  'payload',
  'toolCallId',
  'toolName',
  'skillName',
  'path',
  'command',
  'target',
  'toolInputPreview',
  'sessionLabel',
  'surface',
  'value',
  'forwarding',
  'sessionApproval',
  'accessIntent',
] as const

/** The ask as the reviewer sees it, never truncated: a reviewer must not approve an action it saw only in part */
export function permissionRequest(details: PromptPermissionDetails): Record<string, unknown> {
  return Object.fromEntries(
    PERMISSION_FIELDS.flatMap(field => (details[field] === undefined ? [] : [[field, details[field]]])),
  )
}
