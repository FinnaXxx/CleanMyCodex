import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SessionSlimMode } from '../../shared/types'
import { fileAllocatedSize } from './fs-size'

export const SESSION_IMAGE_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export interface SessionSlimReport {
  originalBytes: number
  newBytes: number
  freedBytes: number
  replacedCount: number
  keptCount: number
}

interface RewriteResult {
  replacedCount: number
  keptCount: number
  lineCount: number
}

const prefixes = [Buffer.from('data:image/'), Buffer.from('data:image\\/')]
const carryLength = Math.max(...prefixes.map((prefix) => prefix.length)) - 1

function earliestPrefix(data: Buffer, from: number): number {
  const matches = prefixes.map((prefix) => data.indexOf(prefix, from)).filter((index) => index >= 0)
  return matches.length ? Math.min(...matches) : -1
}

class StreamingImageRewriter {
  readonly result: RewriteResult = { replacedCount: 0, keptCount: 0, lineCount: 0 }
  private carry: Buffer = Buffer.alloc(0)
  private candidate: Buffer[] | null = null
  private candidateBytes = 0
  private oversized = false
  private readonly seen = new Set<string>()

  constructor(
    private readonly mode: SessionSlimMode,
    private readonly maximumURIBytes: number,
    private readonly write: (data: Buffer) => Promise<void>
  ) {}

  async consume(chunk: Buffer): Promise<void> {
    for (const byte of chunk) if (byte === 0x0a) this.result.lineCount += 1
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk
    this.carry = Buffer.alloc(0)
    let cursor = 0
    let passthrough = 0

    while (cursor < data.length) {
      if (this.candidate) {
        const quote = data.indexOf(0x22, cursor)
        if (quote < 0) {
          await this.appendCandidate(data.subarray(cursor))
          return
        }
        await this.appendCandidate(data.subarray(cursor, quote))
        await this.emitCandidate()
        cursor = quote
        passthrough = quote
        continue
      }

      if (this.oversized) {
        const quote = data.indexOf(0x22, cursor)
        if (quote < 0) {
          await this.write(data.subarray(cursor))
          return
        }
        await this.write(data.subarray(cursor, quote))
        this.oversized = false
        cursor = quote
        passthrough = quote
        continue
      }

      const match = earliestPrefix(data, cursor)
      if (match < 0) {
        const preserved = Math.min(carryLength, data.length - cursor)
        const end = data.length - preserved
        if (end > passthrough) await this.write(data.subarray(passthrough, end))
        this.carry = data.subarray(end)
        return
      }
      if (match > passthrough) await this.write(data.subarray(passthrough, match))
      this.candidate = []
      this.candidateBytes = 0
      cursor = match
      passthrough = match
    }

    if (!this.candidate && !this.oversized && passthrough < data.length) {
      await this.write(data.subarray(passthrough))
    }
  }

  async finish(): Promise<void> {
    if (this.candidate) {
      for (const part of this.candidate) await this.write(part)
      this.result.keptCount += 1
      this.candidate = null
    }
    if (this.carry.length) await this.write(this.carry)
    this.carry = Buffer.alloc(0)
  }

  private async appendCandidate(bytes: Buffer): Promise<void> {
    if (!this.candidate) return
    if (this.candidateBytes + bytes.length > this.maximumURIBytes) {
      for (const part of this.candidate) await this.write(part)
      await this.write(bytes)
      this.candidate = null
      this.candidateBytes = 0
      this.oversized = true
      this.result.keptCount += 1
      return
    }
    this.candidate.push(bytes)
    this.candidateBytes += bytes.length
  }

  private async emitCandidate(): Promise<void> {
    if (!this.candidate) return
    const uri = Buffer.concat(this.candidate, this.candidateBytes)
    this.candidate = null
    this.candidateBytes = 0
    const comma = uri.indexOf(0x2c)
    const header = comma < 0 ? '' : uri.subarray(0, comma + 1).toString('utf8').toLowerCase()
    if (comma < 0 || !header.includes(';base64,')) {
      await this.write(uri)
      return
    }
    const digest = createHash('sha256').update(uri.subarray(comma + 1)).digest('hex')
    const keep = this.mode === 'deduplicate' && !this.seen.has(digest)
    this.seen.add(digest)
    if (keep) {
      this.result.keptCount += 1
      await this.write(uri)
    } else {
      this.result.replacedCount += 1
      await this.write(Buffer.from(SESSION_IMAGE_PLACEHOLDER))
    }
  }
}

async function rewrite(source: string, destination: string, mode: SessionSlimMode): Promise<RewriteResult> {
  const output = await open(destination, 'wx')
  try {
    const rewriter = new StreamingImageRewriter(mode, 96 * 1024 * 1024, async (data) => {
      if (data.length) await output.write(data)
    })
    for await (const chunk of createReadStream(source, { highWaterMark: 1024 * 1024 })) {
      await rewriter.consume(chunk as Buffer)
    }
    await rewriter.finish()
    await output.sync()
    return rewriter.result
  } finally {
    await output.close()
  }
}

async function verifyJSONLines(path: string, lineLimit = 1024 * 1024): Promise<number> {
  let lines = 0
  let current: Buffer[] = []
  let currentBytes = 0
  let oversized = false
  for await (const raw of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const chunk = raw as Buffer
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(0x0a, start)
      if (newline < 0) break
      if (!oversized) {
        const part = chunk.subarray(start, newline)
        current.push(part)
        currentBytes += part.length
        if (currentBytes <= lineLimit && currentBytes > 0) {
          try { JSON.parse(Buffer.concat(current, currentBytes).toString('utf8')) } catch {
            throw new Error(`校验没通过：第 ${lines + 1} 行不是合法 JSON`)
          }
        }
      }
      lines += 1
      current = []
      currentBytes = 0
      oversized = false
      start = newline + 1
    }
    if (!oversized && start < chunk.length) {
      const part = chunk.subarray(start)
      current.push(part)
      currentBytes += part.length
      if (currentBytes > lineLimit) {
        current = []
        currentBytes = 0
        oversized = true
      }
    }
  }
  if (!oversized && currentBytes > 0) {
    try { JSON.parse(Buffer.concat(current, currentBytes).toString('utf8')) } catch {
      throw new Error(`校验没通过：第 ${lines + 1} 行不是合法 JSON`)
    }
  }
  return lines
}

/** Safely replace a rollout after streaming rewrite and verification. */
export async function slimSession(
  path: string,
  mode: SessionSlimMode,
  trashOriginal: (path: string) => Promise<void>
): Promise<SessionSlimReport> {
  if (path.endsWith('.zst')) throw new Error(`${basename(path)} 是压缩会话，暂不支持瘦身`)
  const before = await stat(path)
  const originalBytes = fileAllocatedSize(path)
  const temporary = join(dirname(path), `.cleanmycodex-${randomUUID()}.jsonl`)
  let moved = false
  try {
    const result = await rewrite(path, temporary, mode)
    if (result.replacedCount === 0) throw new Error(`${basename(path)} 里没有可以回收的内嵌图片`)
    const after = await stat(path)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`${basename(path)} 在处理过程中被写入，已放弃`)
    }
    const originalLines = await verifyJSONLines(path)
    const rewrittenLines = await verifyJSONLines(temporary)
    if (originalLines !== rewrittenLines || rewrittenLines !== result.lineCount) {
      throw new Error(`校验没通过：行数不一致（${originalLines} → ${rewrittenLines}）`)
    }
    if ((await stat(temporary)).size === 0) throw new Error('校验没通过：新文件是空的')
    await trashOriginal(path)
    await rename(temporary, path)
    moved = true
    await utimes(path, before.atime, before.mtime).catch(() => undefined)
    const newBytes = fileAllocatedSize(path)
    return {
      originalBytes,
      newBytes,
      freedBytes: Math.max(0, originalBytes - newBytes),
      replacedCount: result.replacedCount,
      keptCount: result.keptCount
    }
  } finally {
    if (!moved) await rm(temporary, { force: true }).catch(() => undefined)
  }
}
