import { createReadStream, statSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { CodexLocations } from './locations'
import { directoryAllocatedSize, fileAllocatedSize } from './fs-size'
import type { SessionItem, SessionLocation, SessionTag } from '../../shared/types'

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
const DATA_IMAGE_PLAIN = Buffer.from('data:image/')
const DATA_IMAGE_ESCAPED = Buffer.from('data:image\\/')

interface ImageScan {
  count: number
  uriBytes: number
  distinctCount: number
  duplicateBytes: number
}

interface SessionMeta {
  id: string | null
  cwd: string | null
}

/** Extract the thread UUID from a rollout filename, falling back to the whole stem. */
function threadIDFromName(name: string): string {
  const match = name.match(UUID_RE)
  return match ? match[0] : name.replace(/\.jsonl(\.zst)?$/, '')
}

function statAllocated(path: string): { bytes: number; modifiedAt: number } {
  try {
    const st = statSync(path)
    const allocated = st.blocks * 512
    return { bytes: allocated > 0 ? allocated : st.size, modifiedAt: st.mtimeMs }
  } catch {
    return { bytes: 0, modifiedAt: 0 }
  }
}

/** Read the first line of a rollout and pull out the session_meta id and cwd. */
function readSessionMeta(path: string): SessionMeta {
  return new Promise((resolve) => {
    const stream = createReadStream(path, { encoding: 'utf8' })
    let buffer = ''
    stream.on('data', (chunk: string | Buffer) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline >= 0) {
        stream.destroy()
        resolve(parseMetaLine(buffer.slice(0, newline)))
      }
      if (buffer.length > 8 * 1024 * 1024) {
        stream.destroy()
        resolve({ id: null, cwd: null })
      }
    })
    stream.on('end', () => resolve(parseMetaLine(buffer)))
    stream.on('error', () => resolve({ id: null, cwd: null }))
  }) as unknown as SessionMeta
}

function parseMetaLine(line: string): SessionMeta {
  try {
    const obj = JSON.parse(line) as { type?: string; payload?: { id?: string; cwd?: string } }
    if (obj.type === 'session_meta' && obj.payload) {
      return { id: obj.payload.id ?? null, cwd: obj.payload.cwd ?? null }
    }
  } catch {
    /* not JSON / wrong shape */
  }
  return { id: null, cwd: null }
}

/**
 * First user message in the rollout, cleaned up so a thread without a title is still
 * recognisable. Skips injected preamble (instructions, AGENTS.md) the way the Swift
 * scanner did.
 */
function readPreview(path: string): string | null {
  return new Promise((resolve) => {
    const stream = createReadStream(path, { encoding: 'utf8' })
    let buffer = ''
    let checkedBytes = 0
    const limit = 2 * 1024 * 1024
    stream.on('data', (chunk: string | Buffer) => {
      buffer += chunk.toString()
      checkedBytes += chunk.length
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const preview = parsePreviewLine(line)
        if (preview !== null) {
          stream.destroy()
          resolve(cleanPreview(preview))
          return
        }
      }
      if (checkedBytes > limit) {
        stream.destroy()
        resolve(null)
      }
    })
    stream.on('end', () => resolve(null))
    stream.on('error', () => resolve(null))
  }) as unknown as string | null
}

function parsePreviewLine(line: string): string | null {
  try {
    const obj = JSON.parse(line) as { type?: string; payload?: { type?: string; message?: string } }
    if (obj.payload?.type === 'user_message' && typeof obj.payload.message === 'string') {
      return obj.payload.message
    }
  } catch {
    /* ignore */
  }
  return null
}

function cleanPreview(text: string): string {
  const stripped = text
    .replace(/^#\s*AGENTS\.md.*$/im, '')
    .replace(/^.*?My request for Codex:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length > 90 ? stripped.slice(0, 89) + '…' : stripped
}

/**
 * Stream a rollout and count embedded `data:image/…;base64,…` URIs: how many, their byte
 * cost, and how many are repeats of a picture already seen earlier in the file. Never
 * materialises a base64 payload — the SHA-256 is updated chunk by chunk.
 */
function scanEmbeddedImages(path: string): Promise<ImageScan> {
  return new Promise((resolve) => {
    const stream = createReadStream(path)
    const result: ImageScan = { count: 0, uriBytes: 0, distinctCount: 0, duplicateBytes: 0 }
    const seen = new Set<string>()

    let carry = Buffer.alloc(0)
    let active: { buffer: Buffer[]; hasher: ReturnType<typeof createHash> } | null = null

    const finishCandidate = (): void => {
      // The file ended inside a data URI: an incomplete URI is not a real image, drop it.
      active = null
    }

    stream.on('data', (chunk: string | Buffer) => {
      const buf = chunk as Buffer
      let data = Buffer.concat([carry, buf])
      carry = Buffer.alloc(0)
      let cursor = 0
      while (cursor < data.length) {
        if (active) {
          const quote = data.indexOf(0x22, cursor) // '"'
          if (quote < 0) {
            active.buffer.push(data.subarray(cursor))
            active.hasher.update(data.subarray(cursor))
            cursor = data.length
          } else {
            const segment = data.subarray(cursor, quote)
            active.buffer.push(segment)
            active.hasher.update(segment)
            const uri = Buffer.concat(active.buffer)
            const comma = uri.indexOf(0x2c)
            if (comma >= 0 && uri.slice(0, comma).toString('utf8').toLowerCase().includes(';base64,')) {
              result.count += 1
              result.uriBytes += uri.length
              const key = active.hasher.digest('hex')
              if (seen.has(key)) result.duplicateBytes += uri.length
              else {
                seen.add(key)
                result.distinctCount += 1
              }
            }
            active = null
            cursor = quote
          }
          continue
        }
        const plain = data.indexOf(DATA_IMAGE_PLAIN, cursor)
        const escaped = data.indexOf(DATA_IMAGE_ESCAPED, cursor)
        const match = earliest(plain, escaped)
        if (match < 0) {
          const keep = Math.min(16, data.length - cursor)
          carry = data.subarray(data.length - keep)
          return
        }
        if (cursor < match) {
          // bytes before the URI are irrelevant once we are not buffering
        }
        active = { buffer: [], hasher: createHash('sha256') }
        cursor = match
      }
    })
    stream.on('end', () => {
      finishCandidate()
      resolve(result)
    })
    stream.on('error', () => resolve(result))
  })
}

function earliest(a: number, b: number): number {
  if (a < 0) return b
  if (b < 0) return a
  return Math.min(a, b)
}

function listRolloutFiles(root: string, location: SessionLocation, out: { url: string; location: SessionLocation }[]): void {
  if (!existsSync(root)) return
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true }).map((d) => d.name)
  } catch {
    return
  }
  for (const name of entries) {
    const path = join(root, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      listRolloutFiles(path, location, out)
    } else if (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst')) {
      out.push({ url: path, location })
    }
  }
}

function assetBytesForThread(locations: CodexLocations, threadID: string): { bytes: number; urls: string[] } {
  const urls: string[] = []
  let bytes = 0
  for (const root of [locations.generatedImages, locations.visualizations]) {
    const dir = join(root, threadID)
    if (existsSync(dir)) {
      urls.push(dir)
      bytes += directoryAllocatedSize(dir)
    }
  }
  return { bytes, urls }
}

/**
 * Scan every rollout under `sessions/` and `archived_sessions/`, producing one row per
 * file with its size, embedded-image cost (and how much of that is duplicate copies),
 * the first user message as a preview, and any generated-image assets tied to the thread.
 */
export async function scanSessions(
  locations: CodexLocations,
  onProgress?: (path: string) => void
): Promise<SessionItem[]> {
  const files: { url: string; location: SessionLocation }[] = []
  listRolloutFiles(locations.sessions, 'active', files)
  listRolloutFiles(locations.archivedSessions, 'archived', files)

  const items: SessionItem[] = []
  for (const file of files) {
    onProgress?.(file.url)
    const name = basename(file.url)
    const compressed = name.endsWith('.zst')
    const { bytes: fileBytes, modifiedAt } = statAllocated(file.url)

    let meta: SessionMeta = { id: null, cwd: null }
    let images: ImageScan = { count: 0, uriBytes: 0, distinctCount: 0, duplicateBytes: 0 }
    let preview: string | null = null
    if (!compressed) {
      meta = await readSessionMeta(file.url)
      images = await scanEmbeddedImages(file.url)
      preview = await readPreview(file.url)
    }

    const threadID = meta.id ?? threadIDFromName(name)
    const assets = assetBytesForThread(locations, threadID)

    const tags: SessionTag[] = []
    if (images.uriBytes > 32 * 1024 * 1024 && fileBytes > 0 && images.uriBytes / fileBytes > 0.4) {
      tags.push('imageHeavy')
    }
    if (assets.urls.length > 0) tags.push('imageGen')

    items.push({
      id: file.url,
      threadID,
      fileURL: file.url,
      location: file.location,
      modifiedAt,
      fileBytes,
      assetBytes: assets.bytes,
      assetURLs: assets.urls,
      embeddedImageBytes: images.uriBytes,
      embeddedImageCount: images.count,
      distinctImageCount: images.distinctCount,
      duplicateImageBytes: images.duplicateBytes,
      workingDirectory: meta.cwd,
      title: null, // titles live in state_*.sqlite, added when SQLite lands
      preview,
      tags,
      isCompressed: compressed,
      isUnstable: false,
      parseWarnings: 0
    })
  }
  return items.sort((a, b) => b.modifiedAt - a.modifiedAt)
}