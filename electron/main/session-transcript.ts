import { createReadStream, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import * as zlib from 'node:zlib'
import { cleanUserMessage } from './preview'
import type { GeneratedImagePreview, SessionTranscript, TranscriptMessage } from '../../shared/types'

/**
 * Reads a conversation back out of its rollout segments so it can be previewed before
 * it is deleted. Only user and assistant text is kept; tool calls are counted, and
 * everything else a rollout carries (reasoning, tool output, context injection) is left
 * out. Nothing here writes to disk.
 */

const MAX_MESSAGES = 400
const MAX_MESSAGE_CHARS = 8000
/** A line with a pasted screenshot can run to many megabytes; beyond this it is tool output. */
const MAX_LINE_CHARS = 64 * 1024 * 1024
/** Images cross IPC as data URLs, so their total size per preview is bounded. */
const MAX_IMAGE_CHARS = 48 * 1024 * 1024
const IMAGE_TAG_RE = /<\/?image\b[^>]*>/gi
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'])

interface SegmentMessages {
  items: TranscriptMessage[]
  events: TranscriptMessage[]
  toolCalls: number
  /** Image characters still allowed into `items` / `events`, so a screenshot-heavy rollout is never held whole. */
  itemImageBudget: number
  eventImageBudget: number
}
interface MessageContent { text: string | null; images: string[] }

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.length ? value : null }

function imageURL(value: unknown): string | null {
  const url = stringValue(value)
  return url && /^data:image\/[a-z0-9.+-]+;base64,/i.test(url) ? url : null
}

/**
 * Codex stores a pasted image as an `input_image` part holding the whole picture as a
 * data URL, framed by `<image name=… path=…>` / `</image>` text parts. The path is a
 * temporary clipboard file that is usually gone by now, so the frame text is dropped
 * and the embedded data is what gets shown.
 */
function messageContent(content: unknown): MessageContent {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: null, images: [] }
  const texts: string[] = []
  const images: string[] = []
  for (const part of content) {
    const value = objectValue(part)
    if (!value) continue
    const image = imageURL(value['image_url'])
    if (image) { images.push(image); continue }
    const text = stringValue(value['text'])?.replace(IMAGE_TAG_RE, '').trim()
    if (text) texts.push(text)
  }
  return { text: texts.length ? texts.join('\n\n') : null, images }
}

function message(role: TranscriptMessage['role'], content: MessageContent, timestamp: number | null): TranscriptMessage | null {
  const raw = content.text?.replace(IMAGE_TAG_RE, '') ?? null
  const text = (role === 'user' ? cleanUserMessage(raw) : raw?.trim() || null) ?? ''
  // A message that is only Codex scaffolding is skipped, unless it carries an image.
  if (!text && !content.images.length) return null
  return {
    role, timestamp, images: content.images, omittedImages: 0,
    text: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text
  }
}

function withinBudget<K extends string>(item: TranscriptMessage, budgets: Record<K, number>, key: K): TranscriptMessage {
  const kept = item.images.filter((image) => {
    if (image.length > budgets[key]) return false
    budgets[key] -= image.length
    return true
  })
  return { ...item, images: kept, omittedImages: item.omittedImages + item.images.length - kept.length }
}

/**
 * Codex records each turn twice: as a `response_item` message (what the model saw) and
 * as an `event_msg` (what the UI showed). Response items are preferred; events are the
 * fallback for rollouts that only carry one of them. Very old rollouts have no wrapper,
 * so the line itself is the payload.
 */
function parseTranscriptLine(line: string, into: SegmentMessages): void {
  if (!line || line.length > MAX_LINE_CHARS) return
  let root: Record<string, unknown>
  try { root = JSON.parse(line) as Record<string, unknown> } catch { return }
  const payload = objectValue(root['payload']) ?? root
  const parsedTime = Date.parse(stringValue(root['timestamp']) ?? '')
  const timestamp = Number.isNaN(parsedTime) ? null : parsedTime
  const type = payload['type']
  if (root['type'] === 'event_msg') {
    if (type === 'user_message') {
      const images = Array.isArray(payload['images']) ? payload['images'].flatMap((value) => imageURL(value) ?? []) : []
      const item = message('user', { text: stringValue(payload['message']), images }, timestamp)
      if (item) into.events.push(withinBudget(item, into, 'eventImageBudget'))
    } else if (type === 'agent_message') {
      const item = message('assistant', { text: stringValue(payload['message']), images: [] }, timestamp)
      if (item) into.events.push(item)
    }
    return
  }
  if (type === 'message' && (payload['role'] === 'user' || payload['role'] === 'assistant')) {
    const item = message(payload['role'], messageContent(payload['content']), timestamp)
    if (item) into.items.push(withinBudget(item, into, 'itemImageBudget'))
  } else if (typeof type === 'string' && TOOL_CALL_TYPES.has(type)) into.toolCalls += 1
}

function openSegment(path: string): Readable {
  if (!path.endsWith('.zst')) return createReadStream(path, { encoding: 'utf8' })
  const decompress = (zlib as unknown as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync
  if (!decompress) throw new Error('zstd is not available')
  return Readable.from([decompress(readFileSync(path)).toString('utf8')])
}

async function readSegment(path: string): Promise<SegmentMessages> {
  const result: SegmentMessages = { items: [], events: [], toolCalls: 0, itemImageBudget: MAX_IMAGE_CHARS, eventImageBudget: MAX_IMAGE_CHARS }
  const lines = createInterface({ input: openSegment(path), crlfDelay: Infinity })
  for await (const line of lines) parseTranscriptLine(line, result)
  return result
}

/** Image files under a thread's generated-images directory, oldest first; symlinks are never followed. */
function generatedImageFiles(directory: string): Array<{ path: string; name: string; type: string; size: number; modifiedAt: number }> {
  const files: Array<{ path: string; name: string; type: string; size: number; modifiedAt: number }> = []
  const stack = [directory]
  while (stack.length) {
    const current = stack.pop()!
    let entries: string[]
    try { entries = readdirSync(current) } catch { continue }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const path = join(current, name)
      let stats
      try { stats = lstatSync(path) } catch { continue }
      if (stats.isDirectory()) { stack.push(path); continue }
      const type = IMAGE_TYPES[extname(name).slice(1).toLowerCase()]
      if (stats.isFile() && type) files.push({ path, name, type, size: stats.size, modifiedAt: stats.mtimeMs })
    }
  }
  return files.sort((a, b) => a.modifiedAt - b.modifiedAt || a.name.localeCompare(b.name))
}

function readGeneratedImages(directories: string[], budget: { images: number }): { images: GeneratedImagePreview[]; omitted: number } {
  const images: GeneratedImagePreview[] = []
  let omitted = 0
  for (const file of directories.flatMap(generatedImageFiles)) {
    // Base64 grows a file by a third; check before reading so an oversized file is never loaded.
    const encodedLength = Math.ceil(file.size / 3) * 4
    if (encodedLength > budget.images) { omitted += 1; continue }
    let data: Buffer
    try { data = readFileSync(file.path) } catch { omitted += 1; continue }
    const src = `data:${file.type};base64,${data.toString('base64')}`
    budget.images -= src.length
    images.push({ name: file.name, src, modifiedAt: file.modifiedAt })
  }
  return { images, omitted }
}

/**
 * `paths` are the conversation's rollout segments, oldest first; `generatedImageDirectories`
 * are the thread's `generated_images` directories the scan attributed to it.
 */
export async function readSessionTranscript(paths: string[], generatedImageDirectories: string[] = []): Promise<SessionTranscript> {
  const messages: TranscriptMessage[] = []
  let toolCalls = 0
  let unreadableSegments = 0
  for (const path of paths) {
    let segment: SegmentMessages
    try { segment = await readSegment(path) } catch { unreadableSegments += 1; continue }
    messages.push(...(segment.items.length ? segment.items : segment.events))
    toolCalls += segment.toolCalls
  }
  const shown = messages.slice(0, MAX_MESSAGES)
  const budget = { images: MAX_IMAGE_CHARS }
  for (const [index, item] of shown.entries()) shown[index] = withinBudget(item, budget, 'images')
  const generated = readGeneratedImages(generatedImageDirectories, budget)
  return {
    messages: shown,
    toolCalls,
    truncated: messages.length > MAX_MESSAGES,
    unreadableSegments,
    generatedImages: generated.images,
    omittedGeneratedImages: generated.omitted
  }
}
