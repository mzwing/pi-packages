import type { ViteUserConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const config: ViteUserConfig = defineConfig({
  resolve: {
    alias: {
      '@mzwing/pi-polyfill': fileURLToPath(new URL('../pi-polyfill/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})

export default config
