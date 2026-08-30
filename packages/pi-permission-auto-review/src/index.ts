import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createAutoReviewExtension } from './extension.js'

export default function permissionAutoReviewExtension(pi: ExtensionAPI): void {
  createAutoReviewExtension(pi)
}
