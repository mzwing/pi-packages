import type { OxlintConfig } from 'oxlint'
import oxlint from '@mzwing/oxc-config'

const config: OxlintConfig = oxlint({
  type: 'lib',
  typescript: true,
})

export default config
