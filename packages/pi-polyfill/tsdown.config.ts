import type { UserConfig } from 'tsdown'
import { defineConfig } from 'tsdown'

const config: UserConfig = defineConfig({
  clean: true,
  deps: {
    neverBundle: ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'],
  },
  dts: true,
  entry: ['src/index.ts'],
  fixedExtension: false,
  format: 'esm',
  minify: false,
  platform: 'node',
  sourcemap: true,
  target: 'node24',
})

export default config
