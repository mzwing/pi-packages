import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createModelInfoExtension } from './extension.js'

export default function modelInfoExtension(pi: ExtensionAPI): void {
  createModelInfoExtension(pi)
}
