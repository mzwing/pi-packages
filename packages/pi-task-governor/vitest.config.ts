import type { ViteUserConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const config: ViteUserConfig = defineConfig({
  resolve: {
    // Unit tests run against the hub's sources, so they need no build of it.
    alias: {
      '@mzwing/pi-session-hub/api': fileURLToPath(new URL('../pi-session-hub/src/api.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})

export default config
