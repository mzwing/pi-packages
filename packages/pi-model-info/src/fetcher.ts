export interface CatalogRequest {
  url: string
  etag: string | undefined
  lastModified: string | undefined
  timeoutMs: number
  maxBytes: number
}

export type FetchOutcome =
  | { status: 'ok'; body: unknown; etag: string | undefined; lastModified: string | undefined }
  | { status: 'not-modified' }
  | { status: 'error'; message: string }

export interface CatalogFetcher {
  get: (request: CatalogRequest, signal: AbortSignal) => Promise<FetchOutcome>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reads through the stream so an oversized payload is abandoned rather than buffered whole. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body
  if (body === null) {
    return ''
  }
  // Node's `undici` types reach us as `any`, so the chunk shape is pinned explicitly.
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      size += chunk.value.byteLength
      if (size > maxBytes) {
        throw new Error(`response exceeded ${maxBytes} bytes`)
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
  chunks.push(decoder.decode())

  return chunks.join('')
}

export const catalogFetcher: CatalogFetcher = {
  async get(request, signal) {
    let url: URL
    try {
      url = new URL(request.url)
    } catch (error) {
      return { status: 'error', message: `invalid url: ${describe(error)}` }
    }
    if (url.protocol !== 'https:') {
      return { status: 'error', message: `refusing non-https catalog url '${request.url}'` }
    }

    const headers = new Headers({ accept: 'application/json' })
    if (request.etag !== undefined) {
      headers.set('if-none-match', request.etag)
    }
    if (request.lastModified !== undefined) {
      headers.set('if-modified-since', request.lastModified)
    }

    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs)]),
      })

      if (response.status === 304) {
        await response.body?.cancel()

        return { status: 'not-modified' }
      }
      if (!response.ok) {
        await response.body?.cancel()

        return { status: 'error', message: `HTTP ${response.status}` }
      }

      const text = await readCapped(response, request.maxBytes)
      if (text.length === 0) {
        return { status: 'error', message: 'empty response' }
      }

      return {
        status: 'ok',
        body: JSON.parse(text),
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined,
      }
    } catch (error) {
      return { status: 'error', message: describe(error) }
    }
  },
}
