import { DEFAULTS_ENTRY } from '../config/config.js'

/** A rule list with the preset's built-in entries spliced in where `DEFAULTS_ENTRY` stands */
export function expandRules(entries: readonly string[], builtIns: readonly string[]): string[] {
  return entries.flatMap(entry => (entry === DEFAULTS_ENTRY ? builtIns : [entry]))
}

/** One bullet per rule, a multi-line rule indented under its own */
export function bulletList(rules: readonly string[]): string {
  return rules.map(rule => `- ${rule.replaceAll('\n', '\n  ')}`).join('\n')
}
