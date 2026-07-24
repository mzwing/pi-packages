import type { AutoReviewConfigFileSystem } from '../src/config-store.js'
import { describe, expect, it, vi } from 'vitest'
import { AutoReviewConfigStore } from '../src/config-store.js'

function createFileSystem(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const readFile = vi.fn((path: string) => files.get(path))
  const writeFile = vi.fn((path: string, source: string) => {
    files.set(path, source)
  })
  const rename = vi.fn((sourcePath: string, destinationPath: string) => {
    const source = files.get(sourcePath)
    if (source === undefined) {
      throw new Error(`missing source ${sourcePath}`)
    }
    files.set(destinationPath, source)
    files.delete(sourcePath)
  })
  const mkdir = vi.fn((_path: string) => {})
  const unlink = vi.fn((path: string) => {
    if (!files.delete(path)) {
      const error = new Error(`missing file ${path}`)
      Object.assign(error, { code: 'ENOENT' })
      throw error
    }
  })
  const fileSystem: AutoReviewConfigFileSystem = {
    readFile,
    writeFile,
    rename,
    mkdir,
    unlink,
  }
  return { files, fileSystem, mkdir, rename, writeFile }
}

const globalPath = '/agent/extensions/pi-permission-auto-review/config.json'
const projectPath = '/project/.pi/extensions/pi-permission-auto-review/config.json'

describe('autoReviewConfigStore', () => {
  it('atomically saves a scoped override and returns the merged config', () => {
    const { files, fileSystem, mkdir, rename, writeFile } = createFileSystem({
      [globalPath]: JSON.stringify({ provider: 'global-provider', timeoutMs: 10_000 }),
    })
    const store = new AutoReviewConfigStore({ agentDir: '/agent', fileSystem })
    const snapshot = store.readScope('/project', 'project')

    const result = store.save(snapshot, {
      model: 'project-model',
      timeoutMs: 20_000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.loadResult.config).toMatchObject({
      provider: 'global-provider',
      model: 'project-model',
      timeoutMs: 20_000,
    })
    expect(mkdir).toHaveBeenCalledWith('/project/.pi/extensions/pi-permission-auto-review')
    expect(writeFile).toHaveBeenCalledWith(`${projectPath}.tmp`, expect.any(String))
    expect(rename).toHaveBeenCalledWith(`${projectPath}.tmp`, projectPath)
    const stored: unknown = JSON.parse(files.get(projectPath) ?? '')
    expect(stored).toEqual({
      $schema:
        'https://raw.githubusercontent.com/mzwing/pi-packages/main/packages/pi-permission-auto-review/schemas/config.schema.json',
      model: 'project-model',
      timeoutMs: 20_000,
    })
    expect(files.get(projectPath)).toMatch(/\n$/)
  })

  it('removes a project override by saving a draft without the field', () => {
    const { files, fileSystem } = createFileSystem({
      [globalPath]: JSON.stringify({ model: 'global-model' }),
      [projectPath]: JSON.stringify({ model: 'project-model', reasoning: 'high' }),
    })
    const store = new AutoReviewConfigStore({ agentDir: '/agent', fileSystem })
    const snapshot = store.readScope('/project', 'project')

    const result = store.save(snapshot, { reasoning: 'high' })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.loadResult.config).toMatchObject({
      model: 'global-model',
      reasoning: 'high',
    })
    const stored: unknown = JSON.parse(files.get(projectPath) ?? '')
    expect(stored).not.toHaveProperty('model')
  })

  it('rejects a merged config that violates the cross-field policy invariant', () => {
    const { fileSystem, writeFile } = createFileSystem()
    const store = new AutoReviewConfigStore({ agentDir: '/agent', fileSystem })
    const snapshot = store.readScope('/project', 'global')

    const result = store.save(snapshot, { includeBaselinePolicy: false })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('additionalPolicy is required')
    }
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('detects an external edit before writing', () => {
    const { files, fileSystem, writeFile } = createFileSystem({
      [globalPath]: JSON.stringify({ reasoning: 'low' }),
    })
    const store = new AutoReviewConfigStore({ agentDir: '/agent', fileSystem })
    const snapshot = store.readScope('/project', 'global')
    files.set(globalPath, JSON.stringify({ reasoning: 'high' }))

    const result = store.save(snapshot, { reasoning: 'medium' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('changed while it was being edited')
    }
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('blocks ordinary saves for an invalid file but allows reset to repair it', () => {
    const { files, fileSystem } = createFileSystem({
      [projectPath]: JSON.stringify({ apiKey: 'not-allowed' }),
    })
    const store = new AutoReviewConfigStore({ agentDir: '/agent', fileSystem })
    const snapshot = store.readScope('/project', 'project')

    expect(snapshot.valid).toBe(false)
    const saved = store.save(snapshot, {})
    expect(saved.ok).toBe(false)
    if (!saved.ok) {
      expect(saved.message).toContain('Cannot save invalid config')
    }

    const reset = store.reset(snapshot)
    expect(reset.ok).toBe(true)
    expect(files.has(projectPath)).toBe(false)
    if (reset.ok) {
      expect(reset.loadResult.config).toMatchObject({
        provider: 'openai-codex',
        model: 'codex-auto-review',
      })
    }
  })

  it('cleans up the temporary file when rename fails', () => {
    const { files, fileSystem, rename } = createFileSystem()
    rename.mockImplementation(() => {
      throw new Error('rename failed')
    })
    const store = new AutoReviewConfigStore({ agentDir: '/agent', fileSystem })
    const snapshot = store.readScope('/project', 'global')

    const result = store.save(snapshot, { reasoning: 'high' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('rename failed')
    }
    expect(files.has(`${globalPath}.tmp`)).toBe(false)
  })
})
