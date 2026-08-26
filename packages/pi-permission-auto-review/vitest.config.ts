import type { ViteUserConfig } from 'vitest/config'
import { defineConfig } from 'vitest/config'

const config: ViteUserConfig = defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})

export default config
