import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createDetectorExtension } from './extension.js'

export default function codexDowngradeDetectorExtension(pi: ExtensionAPI): void {
  createDetectorExtension(pi)
}
