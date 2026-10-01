import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readUserAuthoredFields } from '../src/models-json.js'
import { useWorkspace, writeFile } from './helpers.js'

const workspace = useWorkspace()

// A definition with no tracked field still says models.json defines the provider's list, which rules out
// completing it through a lazy wrapper.
it('records the overwritable fields each definition hand-writes, and every definition even with none', () => {
  writeFile(join(workspace.agentDir, 'models.json'), {
    providers: {
      relay: {
        models: [{ id: 'gpt-5.5', contextWindow: 200_000, baseUrl: 'ignored', api: 'ignored' }, { id: 'bare' }],
      },
    },
  })

  expect(readUserAuthoredFields()).toEqual(
    new Map([
      [
        'relay',
        new Map([
          ['gpt-5.5', new Set(['contextWindow'])],
          ['bare', new Set()],
        ]),
      ],
    ]),
  )
})
