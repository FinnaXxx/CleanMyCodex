import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { CodexLocations } from './locations'
import { directoryAllocatedSize } from './fs-size'
import { CodexThreadIndex } from './thread-index'
import { SessionScanCache, type CachedSessionContent } from './session-cache'
import type { SessionItem, SessionLocation, SessionTag } from '../../shared/types'

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const PREFIXES = [Buffer.from('data:image/'), Buffer.from('data:image\\/')]
const TAG_NEEDLES: Array<[SessionTag, Buffer]> = [
  ['browser', Buffer.from('browser_')],
  ['computerUse', Buffer.from('computer_use')],
  ['imageGen', Buffer.from('image_gen')]
]
const CARRY_LENGTH = Math.max(...PREFIXES.map((value) => value.length), ...TAG_NEEDLES.map(([, value]) => value.length)) - 1

interface ImageScan { count: number; uriBytes: number; distinctCount: number; duplicateBytes: number; truncated: number }
interface SessionMeta { id: string | null; cwd: string | null; title: string | null }

function abortError(): DOMException { return new DOMException('扫描已停止', 'AbortError') }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError() }

function threadIDFromName(name: string): string {
  const match = name.match(UUID_RE)
  return match ? match[0] : name.replace(/\.jsonl(\.zst)?$/, '')
}

function statAllocated(path: string): { bytes: number; logicalBytes: number; modifiedAt: number } {
  try {
    const st = statSync(path)
    const allocated = st.blocks * 512
    return { bytes: allocated > 0 ? allocated : st.size, logicalBytes: st.size, modifiedAt: st.mtimeMs }
  } catch { return { bytes: 0, logicalBytes: 0, modifiedAt: 0 } }
}

async function scanContent(path: string, signal?: AbortSignal): Promise<Omit<CachedSessionContent, 'size' | 'modifiedAt'>> {
  let lineBuffer = Buffer.alloc(0)
  let headerFinished = false
  let skippingHeaderLine = false
  let metadataFound = false
  let lines = 0
  let meta: SessionMeta = { id: null, cwd: null, title: null }
  let preview: string | null = null
  let parseWarnings = 0
  const tags = new Set<SessionTag>()
  const images: ImageScan = { count: 0, uriBytes: 0, distinctCount: 0, duplicateBytes: 0, truncated: 0 }
  const seen = new Set<string>()
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let candidate: { rawBytes: number; header: Buffer; sawComma: boolean; hasher: ReturnType<typeof createHash> } | null = null

  const appendCandidate = (bytes: Buffer): void => {
    if (!candidate || !bytes.length) return
    candidate.rawBytes += bytes.length
    if (!candidate.sawComma) {
      const comma = bytes.indexOf(0x2c)
      const headerPart = comma < 0 ? bytes : bytes.subarray(0, comma + 1)
      if (candidate.header.length < 256) candidate.header = Buffer.concat([candidate.header, headerPart.subarray(0, 256 - candidate.header.length)])
      if (comma < 0) return
      candidate.sawComma = true
      candidate.hasher.update(bytes.subarray(comma + 1))
    } else candidate.hasher.update(bytes)
  }
  const finishCandidate = (): void => {
    if (!candidate) return
    if (candidate.sawComma && candidate.header.toString('utf8').toLowerCase().includes(';base64,')) {
      images.count += 1
      images.uriBytes += candidate.rawBytes
      const digest = candidate.hasher.digest('hex')
      if (seen.has(digest)) images.duplicateBytes += candidate.rawBytes
      else { seen.add(digest); images.distinctCount += 1 }
    }
    candidate = null
  }

  for await (const raw of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    checkAbort(signal)
    const chunk = raw as Buffer
    if (!headerFinished) {
      let offset = 0
      while (offset < chunk.length && !headerFinished) {
        const newline = chunk.indexOf(0x0a, offset)
        const end = newline < 0 ? chunk.length : newline
        if (!skippingHeaderLine) {
          const segment = chunk.subarray(offset, end)
          if (lineBuffer.length + segment.length <= 128 * 1024) lineBuffer = Buffer.concat([lineBuffer, segment])
          else { lineBuffer = Buffer.alloc(0); skippingHeaderLine = true; parseWarnings += 1 }
        }
        if (newline < 0) break
        lines += 1
        if (!skippingHeaderLine && lineBuffer.length) {
          const parsed = parseHeaderLine(lineBuffer.toString('utf8'))
          if (parsed.meta && !metadataFound) { meta = parsed.meta; metadataFound = true }
          if (!preview && parsed.preview) preview = parsed.preview
        }
        lineBuffer = Buffer.alloc(0)
        skippingHeaderLine = false
        if ((metadataFound && preview) || lines >= 60) headerFinished = true
        offset = newline + 1
      }
    }

    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
    carry = Buffer.alloc(0)
    for (const [tag, needle] of TAG_NEEDLES) if (!tags.has(tag) && data.includes(needle)) tags.add(tag)
    let cursor = 0
    while (cursor < data.length) {
      if (candidate) {
        const quote = data.indexOf(0x22, cursor)
        if (quote < 0) { appendCandidate(data.subarray(cursor)); cursor = data.length }
        else { appendCandidate(data.subarray(cursor, quote)); finishCandidate(); cursor = quote + 1 }
        continue
      }
      const matches = PREFIXES.map((prefix) => data.indexOf(prefix, cursor)).filter((index) => index >= 0)
      if (!matches.length) {
        const keep = Math.min(CARRY_LENGTH, data.length - cursor)
        carry = data.subarray(data.length - keep)
        break
      }
      candidate = { rawBytes: 0, header: Buffer.alloc(0), sawComma: false, hasher: createHash('sha256') }
      cursor = Math.min(...matches)
    }
  }
  if (!headerFinished && !skippingHeaderLine && lineBuffer.length) {
    lines += 1
    const parsed = parseHeaderLine(lineBuffer.toString('utf8'))
    if (parsed.meta && !metadataFound) { meta = parsed.meta; metadataFound = true }
    if (!preview && parsed.preview) preview = parsed.preview
  }
  if (candidate) images.truncated += 1
  if (!metadataFound && lines > 0) parseWarnings += 1
  return {
    threadID: meta.id, cwd: meta.cwd, metadataTitle: meta.title, preview,
    imageCount: images.count, imageBytes: images.uriBytes, distinctCount: images.distinctCount,
    duplicateBytes: images.duplicateBytes, tags: [...tags].sort(), parseWarnings: parseWarnings + images.truncated
  }
}

function parseHeaderLine(line: string): { meta: SessionMeta | null; preview: string | null } {
  try {
    const root = JSON.parse(line) as Record<string, unknown>
    const payload = objectValue(root['payload']) ?? root
    if (root['type'] === 'session_meta') {
      const title = cleanPreview(stringValue(payload['title']) ?? stringValue(payload['name']))
      return { meta: { id: stringValue(payload['id']), cwd: stringValue(payload['cwd']), title }, preview: title }
    }
    let text: string | null = null
    if (payload['type'] === 'user_message') text = stringValue(payload['message']) ?? stringValue(payload['text'])
    if (!text && payload['role'] === 'user') {
      if (Array.isArray(payload['content'])) {
        for (const item of payload['content']) {
          const value = objectValue(item)
          const candidate = cleanPreview(value ? stringValue(value['text']) : null)
          if (candidate) { text = candidate; break }
        }
      } else text = stringValue(payload['content'])
    }
    return { meta: null, preview: cleanPreview(text) }
  } catch { return { meta: null, preview: null } }
}

const PREAMBLE_MARKERS = ['<environment_context', '<user_instructions', '<user_shell', '<agents', '# agents.md', 'you are a coding agent']
export function cleanPreview(text: string | null): string | null {
  if (!text) return null
  let value = text.trim()
  const marker = value.toLowerCase().indexOf('my request for codex:')
  if (marker >= 0) value = value.slice(marker + 'my request for codex:'.length).trim()
  if (!value || value.startsWith('<')) return null
  const head = value.slice(0, 400).toLowerCase()
  if (PREAMBLE_MARKERS.some((item) => head.includes(item))) return null
  value = value.replace(/\s+/g, ' ')
  return value.length > 90 ? `${value.slice(0, 90)}…` : value
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.length ? value : null }

function listRolloutFiles(root: string, location: SessionLocation, out: Array<{ url: string; location: SessionLocation }>): void {
  if (!existsSync(root)) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const item of entries) {
    if (item.name.startsWith('.')) continue
    const path = join(root, item.name)
    if (item.isDirectory()) listRolloutFiles(path, location, out)
    else if (item.isFile() && (item.name.endsWith('.jsonl') || item.name.endsWith('.jsonl.zst'))) out.push({ url: path, location })
  }
}

function assetBytesForThread(locations: CodexLocations, threadID: string): { bytes: number; urls: string[] } {
  const urls: string[] = []
  let bytes = 0
  for (const root of [locations.generatedImages, locations.visualizations]) {
    const dir = join(root, threadID)
    if (existsSync(dir)) { urls.push(dir); bytes += directoryAllocatedSize(dir) }
  }
  return { bytes, urls }
}

export async function scanSessions(
  locations: CodexLocations,
  onProgress?: (path: string, fraction: number) => void,
  signal?: AbortSignal
): Promise<SessionItem[]> {
  const files: Array<{ url: string; location: SessionLocation }> = []
  listRolloutFiles(locations.sessions, 'active', files)
  listRolloutFiles(locations.archivedSessions, 'archived', files)
  const titles = CodexThreadIndex.load(locations.home)
  const cache = SessionScanCache.load(locations.scanCache)
  const items: SessionItem[] = []
  const totalBytes = Math.max(1, files.reduce((sum, file) => sum + statAllocated(file.url).logicalBytes, 0))
  let processedBytes = 0
  for (const file of files) {
    checkAbort(signal)
    onProgress?.(file.url, processedBytes / totalBytes)
    const name = basename(file.url)
    const compressed = name.endsWith('.zst')
    const before = statAllocated(file.url)
    let unstable = false
    let content: CachedSessionContent
    const cached = cache.get(file.url, before.logicalBytes, before.modifiedAt)
    if (cached) content = cached
    else if (compressed) content = {
      size: before.logicalBytes, modifiedAt: before.modifiedAt, threadID: null, cwd: null, metadataTitle: null,
      preview: null, imageCount: 0, imageBytes: 0, distinctCount: 0, duplicateBytes: 0, tags: [], parseWarnings: 0
    }
    else {
      let scanned: Omit<CachedSessionContent, 'size' | 'modifiedAt'>
      try { scanned = await scanContent(file.url, signal) }
      catch (error) {
        if (signal?.aborted) throw error
        scanned = {
          threadID: null, cwd: null, metadataTitle: null, preview: null,
          imageCount: 0, imageBytes: 0, distinctCount: 0, duplicateBytes: 0, tags: [], parseWarnings: 1
        }
      }
      const after = statAllocated(file.url)
      unstable = after.logicalBytes !== before.logicalBytes || after.modifiedAt !== before.modifiedAt
      content = { ...scanned, size: before.logicalBytes, modifiedAt: before.modifiedAt }
      if (!unstable) cache.set(file.url, content)
    }
    const threadID = content.threadID ?? threadIDFromName(name)
    const assets = assetBytesForThread(locations, threadID)
    const tags = [...content.tags]
    if (content.imageBytes > 32 * 1024 * 1024 && before.bytes > 0 && content.imageBytes / before.bytes > 0.4) tags.unshift('imageHeavy')
    items.push({
      id: file.url, threadID, fileURL: file.url, location: file.location, modifiedAt: before.modifiedAt,
      fileBytes: before.bytes, assetBytes: assets.bytes, assetURLs: assets.urls,
      embeddedImageBytes: content.imageBytes, embeddedImageCount: content.imageCount,
      distinctImageCount: content.distinctCount, duplicateImageBytes: content.duplicateBytes,
      workingDirectory: content.cwd, title: titles.title(threadID, file.url) ?? content.metadataTitle,
      preview: content.preview, tags, isCompressed: compressed, isUnstable: unstable, parseWarnings: content.parseWarnings
    })
    processedBytes += before.logicalBytes
  }
  if (!signal?.aborted) cache.save(locations.scanCache)
  return items.sort((a, b) => (b.fileBytes + b.assetBytes) - (a.fileBytes + a.assetBytes))
}
