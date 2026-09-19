import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createEnhancerExtension } from './extension.js'

export default function codexEnhancerExtension(pi: ExtensionAPI): void {
  createEnhancerExtension(pi)
}
