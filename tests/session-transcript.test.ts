import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionTranscript } from '../electron/main/session-transcript'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function rollout(lines: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-transcript-')); roots.push(root)
  const path = join(root, `rollout-${roots.length}.jsonl`)
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return path
}

const item = (role: string, text: string, timestamp = '2026-08-01T10:00:00Z') =>
  ({ timestamp, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } })

describe('session transcript', () => {
  it('keeps user and assistant messages, strips scaffolding and counts tool calls', async () => {
    const path = rollout([
      { type: 'session_meta', payload: { id: 'x', cwd: '/work' } },
      item('developer', 'system rules'),
      item('user', '<environment_context>cwd</environment_context>'),
      item('user', '# Files mentioned by the user:\n- a.ts\n## My request:\n修复登录 bug'),
      { type: 'event_msg', payload: { type: 'user_message', message: '修复登录 bug' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
      item('assistant', '已经修好了。'),
      { type: 'event_msg', payload: { type: 'agent_message', message: '已经修好了。' } }
    ])
    const transcript = await readSessionTranscript([path])
    expect(transcript.messages.map(({ role, text }) => [role, text])).toEqual([['user', '修复登录 bug'], ['assistant', '已经修好了。']])
    expect(transcript.messages[0].timestamp).toBe(Date.parse('2026-08-01T10:00:00Z'))
    expect(transcript.toolCalls).toBe(1)
    expect(transcript.truncated).toBe(false)
  })

  it('falls back to UI events and reads segments in order, counting unreadable ones', async () => {
    const first = rollout([{ type: 'event_msg', payload: { type: 'user_message', message: 'first' } }])
    const second = rollout([item('user', 'second')])
    const transcript = await readSessionTranscript([first, join(tmpdir(), 'missing-rollout.jsonl'), second])
    expect(transcript.messages.map((message) => message.text)).toEqual(['first', 'second'])
    expect(transcript.unreadableSegments).toBe(1)
  })

  it('caps long conversations', async () => {
    const path = rollout(Array.from({ length: 450 }, (_, index) => item('user', `message ${index}`)))
    const transcript = await readSessionTranscript([path])
    expect(transcript.messages).toHaveLength(400)
    expect(transcript.truncated).toBe(true)
  })
})
