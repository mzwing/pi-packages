import type { CatalogEntry, NormalizedSource, SourceId } from './types.js'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultModelInfoAgentDir, EXTENSION_ID } from './config.js'

export const CACHE_VERSION = 1

export interface CachedEnvelope {
  version: number
  source: SourceId
  etag: string | undefined
  lastModified: string | undefined
  fetchedAt: number
  entryCount: number
  entries: CatalogEntry[]
  /** `Map` does not survive JSON, so the vendor oracle is persisted as pairs. */
  vendors: [string, string][]
}

export interface CatalogCacheFileSystem {
  readFile: (path: string) => string | undefined
  writeFile: (path: string, data: string) => void
  rename: (from: string, to: string) => void
  mkdir: (path: string) => void
  unlink: (path: string) => void
}

export interface CatalogCacheOptions {
  dir?: string | undefined
  agentDir?: string | undefined
  fileSystem?: CatalogCacheFileSystem | undefined
}

const FILE_NAMES: Record<SourceId, string> = {
  'pi.dev': 'pi-dev.json',
  'models.dev': 'models-dev.json',
}

const defaultFileSystem: CatalogCacheFileSystem = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    }
  },
  writeFile(path, data) {
    writeFileSync(path, data, 'utf8')
  },
  rename(from, to) {
    renameSync(from, to)
  },
  mkdir(path) {
    mkdirSync(path, { recursive: true })
  },
  unlink(path) {
    unlinkSync(path)
  },
}

export function toNormalizedSource(envelope: CachedEnvelope): NormalizedSource {
  return {
    source: envelope.source,
    entries: envelope.entries,
    vendors: new Map(envelope.vendors),
  }
}

export class CatalogCache {
  private readonly dir: string
  private readonly fileSystem: CatalogCacheFileSystem

  constructor(options: CatalogCacheOptions = {}) {
    const agentDir = options.agentDir ?? defaultModelInfoAgentDir()
    this.dir = options.dir ?? join(agentDir, 'extensions', EXTENSION_ID, 'cache')
    this.fileSystem = options.fileSystem ?? defaultFileSystem
  }

  /**
   * A corrupt or half-written envelope reads as absent and is left on disk: the next successful
   * fetch replaces it, and until then a copy another machine can still read is not worth destroying.
   */
  read(source: SourceId): CachedEnvelope | undefined {
    let raw: string | undefined
    try {
      raw = this.fileSystem.readFile(this.path(source))
    } catch {
      return undefined
    }
    if (raw === undefined) {
      return undefined
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined
    }

    const envelope = parsed as Partial<CachedEnvelope>
    const usable =
      envelope.version === CACHE_VERSION &&
      envelope.source === source &&
      Array.isArray(envelope.entries) &&
      Array.isArray(envelope.vendors) &&
      typeof envelope.fetchedAt === 'number' &&
      envelope.entries.length === envelope.entryCount

    return usable ? (envelope as CachedEnvelope) : undefined
  }

  write(envelope: CachedEnvelope): void {
    const path = this.path(envelope.source)
    const temporary = `${path}.tmp`
    try {
      this.fileSystem.mkdir(dirname(path))
      this.fileSystem.writeFile(temporary, `${JSON.stringify(envelope)}\n`)
      this.fileSystem.rename(temporary, path)
    } catch (error) {
      try {
        this.fileSystem.unlink(temporary)
      } catch {
        // The write error is the actionable one; a failed cleanup is not.
      }
      throw error
    }
  }

  private path(source: SourceId): string {
    return join(this.dir, FILE_NAMES[source])
  }
}
