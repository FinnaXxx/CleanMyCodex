import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { CodexLocations } from './locations'
import { directoryAllocatedSize } from './fs-size'
import { CodexThreadIndex } from './thread-index'
import { SessionScanCache, type CachedSessionContent } from './session-cache'
import { cleanPreview } from './preview'
import { SCAN_STOPPED } from '../../shared/messages'
import type { SessionItem, SessionLocation, SessionTag } from '../../shared/types'
import { sessionTotalBytes } from '../../shared/types'

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const UUID_ONLY_RE = new RegExp(`^${UUID_RE.source}$`, 'i')
const TAG_NEEDLES: Array<[SessionTag, Buffer]> = [
  ['browser', Buffer.from('browser_')],
  ['computerUse', Buffer.from('computer_use')]
]
const CARRY_LENGTH = Math.max(...TAG_NEEDLES.map(([, value]) => value.length)) - 1

interface SessionMeta { id: string | null; cwd: string | null; title: string | null; threadSource: string | null; parentThreadID: string | null }

function abortError(): DOMException { return new DOMException(SCAN_STOPPED, 'AbortError') }
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
  let meta: SessionMeta = { id: null, cwd: null, title: null, threadSource: null, parentThreadID: null }
  let preview: string | null = null
  let parseWarnings = 0
  const tags = new Set<SessionTag>()
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0)

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
    for (const [tag, needle] of TAG_NEEDLES) if (!tags.has(tag) && data.includes(needle)) tags.add(tag)
    carry = data.subarray(Math.max(0, data.length - CARRY_LENGTH))
  }
  if (!headerFinished && !skippingHeaderLine && lineBuffer.length) {
    lines += 1
    const parsed = parseHeaderLine(lineBuffer.toString('utf8'))
    if (parsed.meta && !metadataFound) { meta = parsed.meta; metadataFound = true }
    if (!preview && parsed.preview) preview = parsed.preview
  }
  if (!metadataFound && lines > 0) parseWarnings += 1
  return {
    threadID: meta.id, cwd: meta.cwd, metadataTitle: meta.title, preview,
    tags: [...tags].sort(), parseWarnings,
    isSubagent: meta.threadSource === 'subagent', parentThreadID: meta.parentThreadID
  }
}

function parseHeaderLine(line: string): { meta: SessionMeta | null; preview: string | null } {
  try {
    const root = JSON.parse(line) as Record<string, unknown>
    const payload = objectValue(root['payload']) ?? root
    if (root['type'] === 'session_meta') {
      const title = cleanPreview(stringValue(payload['name']) ?? stringValue(payload['title']))
      return {
        meta: {
          id: stringValue(payload['id']), cwd: stringValue(payload['cwd']), title,
          threadSource: stringValue(payload['thread_source']),
          parentThreadID: stringValue(payload['parent_thread_id'])
        },
        preview: title
      }
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

export { cleanPreview }

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

function visualizationDirectories(root: string): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (UUID_ONLY_RE.test(entry.name)) {
        result.set(entry.name.toLowerCase(), [...(result.get(entry.name.toLowerCase()) ?? []), path])
      } else visit(path)
    }
  }
  visit(root)
  return result
}

function assetBytesForThread(
  locations: CodexLocations,
  threadID: string,
  visualizations: Map<string, string[]>
): { bytes: number; urls: string[] } {
  const urls: string[] = []
  let bytes = 0
  const candidates = [
    join(locations.generatedImages, threadID),
    join(locations.visualizationViewers, threadID),
    ...(visualizations.get(threadID.toLowerCase()) ?? [])
  ]
  for (const dir of new Set(candidates)) {
    if (existsSync(dir)) { urls.push(dir); bytes += directoryAllocatedSize(dir) }
  }
  return { bytes, urls }
}

/**
 * Roll subagent rollouts into their parent session: the parent's `childThreadCount`,
 * `childBytes` (subagent file + asset bytes) and `childURLs` (subagent rollouts + their
 * asset dirs) are filled so the list hides subagents under the parent and deleting the
 * parent cascades to its subagents on disk. Parentless subagents are left as-is so they
 * stay visible and cleanable rather than becoming orphans.
 */
function groupSubagents(items: SessionItem[]): void {
  const byID = new Map(items.map((item) => [item.threadID, item]))
  const childrenByParent = new Map<string, SessionItem[]>()
  for (const item of items) {
    if (!item.isSubagent || !item.parentThreadID || !byID.has(item.parentThreadID)) continue
    childrenByParent.set(item.parentThreadID, [...(childrenByParent.get(item.parentThreadID) ?? []), item])
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.modifiedAt - b.modifiedAt || a.fileURL.localeCompare(b.fileURL))
  }
  const roots = items.filter((item) => !item.isSubagent || !item.parentThreadID || !byID.has(item.parentThreadID))
  for (const root of roots) {
    const descendants: SessionItem[] = []
    const visited = new Set([root.threadID])
    const queue = [...(childrenByParent.get(root.threadID) ?? [])]
    while (queue.length) {
      const child = queue.shift()!
      if (visited.has(child.threadID)) continue
      visited.add(child.threadID)
      descendants.push(child)
      queue.push(...(childrenByParent.get(child.threadID) ?? []))
    }
    if (!descendants.length) continue
    const childRolloutURLs = descendants.flatMap((child) => [...child.segmentURLs, child.fileURL])
    const childAssetURLs = descendants.flatMap((child) => child.assetURLs)
    root.childThreadCount = descendants.length
    root.childBytes = descendants.reduce((sum, child) => sum + child.fileBytes + child.assetBytes, 0)
    root.childURLs = [...new Set([...childRolloutURLs, ...childAssetURLs])]
    root.blocksAutomaticCleanup ||= descendants.some((child) => child.blocksAutomaticCleanup)
    // Deleting the root takes every subagent with it, so the conversation was last active
    // when the newest of them was. Reading only the root's own file would let a retention
    // rule — and "skip conversations active in the last 24 hours" — age out a root whose
    // subagent is still working, and delete that subagent along with it.
    root.modifiedAt = Math.max(root.modifiedAt, ...descendants.map((child) => child.modifiedAt))
  }
}

/**
 * Codex Desktop can continue one thread in several rollout files. The session id in
 * `session_meta` remains stable while the filename gains a turn id suffix, so the
 * scanner must model those files as segments of one conversation rather than separate
 * rows. Physical rollout totals are summed, while thread-scoped asset directories
 * are counted once.
 */
function mergeThreadSegments(items: SessionItem[]): SessionItem[] {
  const groups = new Map<string, SessionItem[]>()
  for (const item of items) {
    const group = groups.get(item.threadID)
    if (group) group.push(item)
    else groups.set(item.threadID, [item])
  }

  return [...groups.values()].map((segments) => {
    if (segments.length === 1) return segments[0]
    const chronological = [...segments].sort((a, b) => a.modifiedAt - b.modifiedAt || a.fileURL.localeCompare(b.fileURL))
    const primary = chronological.at(-1)!
    const firstPreview = chronological.find((segment) => segment.preview)?.preview ?? null
    const assetURLs = [...new Set(segments.flatMap((segment) => segment.assetURLs))]
    return {
      ...primary,
      segmentURLs: chronological.filter((segment) => segment !== primary).map((segment) => segment.fileURL),
      location: segments.some((segment) => segment.location === 'active') ? 'active' : 'archived',
      modifiedAt: Math.max(...segments.map((segment) => segment.modifiedAt)),
      fileBytes: segments.reduce((sum, segment) => sum + segment.fileBytes, 0),
      assetBytes: Math.max(...segments.map((segment) => segment.assetBytes)),
      assetURLs,
      workingDirectory: primary.workingDirectory ?? chronological.find((segment) => segment.workingDirectory)?.workingDirectory ?? null,
      title: primary.title ?? chronological.find((segment) => segment.title)?.title ?? null,
      preview: firstPreview,
      tags: [...new Set(segments.flatMap((segment) => segment.tags))].sort(),
      isCompressed: segments.some((segment) => segment.isCompressed),
      isUnstable: segments.some((segment) => segment.isUnstable),
      parseWarnings: segments.reduce((sum, segment) => sum + segment.parseWarnings, 0),
      blocksAutomaticCleanup: segments.some((segment) => segment.blocksAutomaticCleanup),
      isPinned: segments.some((segment) => segment.isPinned),
      isSubagent: segments.every((segment) => segment.isSubagent),
      parentThreadID: primary.parentThreadID ?? chronological.find((segment) => segment.parentThreadID)?.parentThreadID ?? null
    }
  })
}

export async function scanSessions(
  locations: CodexLocations,
  onProgress?: (path: string, fraction: number) => void,
  signal?: AbortSignal,
  /** Loading the index costs a SQLite read, so a caller that already has one passes it. */
  titles: CodexThreadIndex = CodexThreadIndex.load(locations.home)
): Promise<SessionItem[]> {
  const files: Array<{ url: string; location: SessionLocation }> = []
  listRolloutFiles(locations.sessions, 'active', files)
  listRolloutFiles(locations.archivedSessions, 'archived', files)
  const cache = SessionScanCache.load(locations.scanCache)
  const items: SessionItem[] = []
  const visualizationIndex = visualizationDirectories(locations.visualizations)
  const measured = files.map((file) => ({ ...file, stats: statAllocated(file.url) }))
  const totalBytes = Math.max(1, measured.reduce((sum, file) => sum + file.stats.logicalBytes, 0))
  let processedBytes = 0
  for (const file of measured) {
    checkAbort(signal)
    onProgress?.(file.url, processedBytes / totalBytes)
    const name = basename(file.url)
    const compressed = name.endsWith('.zst')
    const before = file.stats
    let unstable = false
    let content: CachedSessionContent
    const cached = cache.get(file.url, before.logicalBytes, before.modifiedAt)
    if (cached) content = cached
    else if (compressed) content = {
      size: before.logicalBytes, modifiedAt: before.modifiedAt, threadID: null, cwd: null, metadataTitle: null,
      preview: null, tags: [], parseWarnings: 0,
      isSubagent: false, parentThreadID: null
    }
    else {
      let scanned: Omit<CachedSessionContent, 'size' | 'modifiedAt'>
      try { scanned = await scanContent(file.url, signal) }
      catch (error) {
        if (signal?.aborted) throw error
        scanned = {
          threadID: null, cwd: null, metadataTitle: null, preview: null,
          tags: [], parseWarnings: 1,
          isSubagent: false, parentThreadID: null
        }
      }
      const after = statAllocated(file.url)
      unstable = after.logicalBytes !== before.logicalBytes || after.modifiedAt !== before.modifiedAt
      content = { ...scanned, size: before.logicalBytes, modifiedAt: before.modifiedAt }
      if (!unstable) cache.set(file.url, content)
    }
    const threadID = content.threadID ?? threadIDFromName(name)
    const assets = assetBytesForThread(locations, threadID, visualizationIndex)
    const tags = [...content.tags]
    if (assets.urls.includes(join(locations.generatedImages, threadID))) tags.push('imageGen')
    items.push({
      id: file.url, threadID, fileURL: file.url, segmentURLs: [], location: file.location, modifiedAt: before.modifiedAt,
      fileBytes: before.bytes, assetBytes: assets.bytes, assetURLs: assets.urls,
      workingDirectory: content.cwd, title: titles.title(threadID, file.url) ?? content.metadataTitle,
      preview: content.preview, tags, isCompressed: compressed, isUnstable: unstable, parseWarnings: content.parseWarnings,
      blocksAutomaticCleanup: titles.cleanupBlocked(threadID),
      isPinned: titles.isPinned(threadID),
      isSubagent: content.isSubagent, parentThreadID: content.parentThreadID,
      childThreadCount: 0, childBytes: 0, childURLs: []
    })
    processedBytes += before.logicalBytes
  }
  const mergedItems = mergeThreadSegments(items)
  groupSubagents(mergedItems)
  if (!signal?.aborted) cache.save(locations.scanCache)
  return mergedItems.sort((a, b) => sessionTotalBytes(b) - sessionTotalBytes(a))
}
