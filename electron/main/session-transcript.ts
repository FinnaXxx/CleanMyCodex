import { createReadStream, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import * as zlib from 'node:zlib'
import { cleanUserMessage } from './preview'
import type { SessionTranscript, TranscriptMessage } from '../../shared/types'

/**
 * Reads a conversation back out of its rollout segments so it can be previewed before
 * it is deleted. Only user and assistant text is kept; tool calls are counted, and
 * everything else a rollout carries (reasoning, tool output, context injection) is left
 * out. Nothing here writes to disk.
 */

const MAX_MESSAGES = 400
const MAX_MESSAGE_CHARS = 8000
/** Lines this long are tool output or embedded images, never a message worth parsing. */
const MAX_LINE_CHARS = 4 * 1024 * 1024
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'])

interface SegmentMessages { items: TranscriptMessage[]; events: TranscriptMessage[]; toolCalls: number }

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.length ? value : null }

function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content.flatMap((part) => {
    const value = objectValue(part)
    const text = value ? stringValue(value['text']) : null
    return text ? [text] : []
  })
  return parts.length ? parts.join('\n\n') : null
}

function message(role: TranscriptMessage['role'], raw: string | null, timestamp: number | null): TranscriptMessage | null {
  const text = role === 'user' ? cleanUserMessage(raw) : raw?.trim() || null
  if (!text) return null
  return { role, timestamp, text: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text }
}

/**
 * Codex records each turn twice: as a `response_item` message (what the model saw) and
 * as an `event_msg` (what the UI showed). Response items are preferred; events are the
 * fallback for rollouts that only carry one of them. Very old rollouts have no wrapper,
 * so the line itself is the payload.
 */
export function parseTranscriptLine(line: string, into: SegmentMessages): void {
  if (!line || line.length > MAX_LINE_CHARS) return
  let root: Record<string, unknown>
  try { root = JSON.parse(line) as Record<string, unknown> } catch { return }
  const payload = objectValue(root['payload']) ?? root
  const parsedTime = Date.parse(stringValue(root['timestamp']) ?? '')
  const timestamp = Number.isNaN(parsedTime) ? null : parsedTime
  const type = payload['type']
  if (root['type'] === 'event_msg') {
    if (type === 'user_message') {
      const item = message('user', stringValue(payload['message']), timestamp)
      if (item) into.events.push(item)
    } else if (type === 'agent_message') {
      const item = message('assistant', stringValue(payload['message']), timestamp)
      if (item) into.events.push(item)
    }
    return
  }
  if (type === 'message' && (payload['role'] === 'user' || payload['role'] === 'assistant')) {
    const item = message(payload['role'], contentText(payload['content']), timestamp)
    if (item) into.items.push(item)
  } else if (typeof type === 'string' && TOOL_CALL_TYPES.has(type)) into.toolCalls += 1
}

function openSegment(path: string): Readable {
  if (!path.endsWith('.zst')) return createReadStream(path, { encoding: 'utf8' })
  const decompress = (zlib as unknown as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync
  if (!decompress) throw new Error('zstd is not available')
  return Readable.from([decompress(readFileSync(path)).toString('utf8')])
}

async function readSegment(path: string): Promise<SegmentMessages> {
  const result: SegmentMessages = { items: [], events: [], toolCalls: 0 }
  const lines = createInterface({ input: openSegment(path), crlfDelay: Infinity })
  for await (const line of lines) parseTranscriptLine(line, result)
  return result
}

/** `paths` are the conversation's rollout segments, oldest first. */
export async function readSessionTranscript(paths: string[]): Promise<SessionTranscript> {
  const messages: TranscriptMessage[] = []
  let toolCalls = 0
  let unreadableSegments = 0
  for (const path of paths) {
    let segment: SegmentMessages
    try { segment = await readSegment(path) } catch { unreadableSegments += 1; continue }
    messages.push(...(segment.items.length ? segment.items : segment.events))
    toolCalls += segment.toolCalls
  }
  return {
    messages: messages.slice(0, MAX_MESSAGES),
    toolCalls,
    truncated: messages.length > MAX_MESSAGES,
    unreadableSegments
  }
}
