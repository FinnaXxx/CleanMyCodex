import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexLocations } from '../electron/main/locations'
import { cleanPreview, scanSessions } from '../electron/main/sessions'
import { SessionScanCache } from '../electron/main/session-cache'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(): { locations: CodexLocations; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-sessions-')); roots.push(root)
  return { root, locations: new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') }) }
}

describe('session scanning', () => {
  it('uses the state database title and scans preview, tools, assets, and duplicate images in one pass', async () => {
    const { locations } = fixture()
    const id = '22222222-2222-2222-2222-222222222222'
    const rollout = join(locations.sessions, '2026', '08', `rollout-${id}.jsonl`)
    mkdirSync(join(rollout, '..'), { recursive: true })
    const image = `data:image/png;base64,${Buffer.alloc(4096, 4).toString('base64')}`
    const giantInjectedLine = JSON.stringify({ payload: { context: 'x'.repeat(140_000) } })
    writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/project', title: '' } }),
      giantInjectedLine,
      JSON.stringify({ payload: { type: 'user_message', message: '真正的用户请求' } }),
      JSON.stringify({ payload: { tool: 'browser_open', image } }),
      JSON.stringify({ payload: { tool: 'computer_use', image } }),
      JSON.stringify({ payload: { tool: 'image_gen' } })
    ].join('\n') + '\n')
    mkdirSync(join(locations.generatedImages, id), { recursive: true })
    writeFileSync(join(locations.generatedImages, id, 'result.png'), Buffer.alloc(8192))

    const sessions = await scanSessions(locations)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      threadID: id,
      title: null,
      preview: '真正的用户请求',
      workingDirectory: '/work/project',
      embeddedImageCount: 2,
      distinctImageCount: 1,
      isCompressed: false,
      isUnstable: false
    })
    expect(sessions[0].duplicateImageBytes).toBeGreaterThan(0)
    expect(sessions[0].assetBytes).toBeGreaterThan(0)
    expect(sessions[0].tags).toEqual(expect.arrayContaining(['browser', 'computerUse', 'imageGen']))
    expect(sessions[0].parseWarnings).toBe(1)
    expect(existsSync(join(locations.scanCache, 'session-scan.json'))).toBe(true)
  })

  it('reads response-item user content and falls back to the filename for compressed rollouts', async () => {
    const { locations } = fixture()
    const activeID = '33333333-3333-3333-3333-333333333333'
    const active = join(locations.sessions, `rollout-${activeID}.jsonl`)
    mkdirSync(locations.sessions, { recursive: true })
    writeFileSync(active, [
      JSON.stringify({ type: 'session_meta', payload: { id: activeID } }),
      JSON.stringify({ payload: { role: 'user', content: [{ type: 'input_text', text: '<environment_context>ignore</environment_context>' }, { type: 'input_text', text: '第二种格式的请求' }] } })
    ].join('\n'))
    const compressedID = '44444444-4444-4444-4444-444444444444'
    const compressed = join(locations.archivedSessions, `rollout-${compressedID}.jsonl.zst`)
    mkdirSync(locations.archivedSessions, { recursive: true })
    writeFileSync(compressed, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))

    const sessions = await scanSessions(locations)
    expect(sessions.find((session) => session.threadID === activeID)?.preview).toBe('第二种格式的请求')
    expect(sessions.find((session) => session.threadID === compressedID)).toMatchObject({ location: 'archived', isCompressed: true, embeddedImageCount: 0 })
    expect(JSON.parse(readFileSync(join(locations.scanCache, 'session-scan.json'), 'utf8')).version).toBe(2)
  })

  it('filters injected preambles and unwraps the explicit request marker', () => {
    expect(cleanPreview('<environment_context>hidden</environment_context>')).toBeNull()
    expect(cleanPreview('Preamble\nMy request for Codex:   修复这个问题  ')).toBe('修复这个问题')
  })

  it('finds an image prefix split across stream chunks', async () => {
    const { locations } = fixture()
    const id = '66666666-6666-6666-6666-666666666666'
    const rollout = join(locations.sessions, `rollout-${id}.jsonl`)
    mkdirSync(locations.sessions, { recursive: true })
    const first = `${JSON.stringify({ type: 'session_meta', payload: { id, title: 'chunk test' } })}\n{"payload":"`
    const padding = 'x'.repeat(1024 * 1024 - Buffer.byteLength(first) - 5)
    writeFileSync(rollout, `${first}${padding}data:image/png;base64,QUJDRA=="}\n`)
    const item = (await scanSessions(locations))[0]
    expect(item.embeddedImageCount).toBe(1)
    expect(item.distinctImageCount).toBe(1)
  })

  it('persists content records keyed by exact size and modification time', async () => {
    const { locations } = fixture()
    const id = '77777777-7777-7777-7777-777777777777'
    const rollout = join(locations.sessions, `rollout-${id}.jsonl`)
    mkdirSync(locations.sessions, { recursive: true })
    writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id } }),
      JSON.stringify({ payload: { type: 'user_message', message: '缓存里的标题' } })
    ].join('\n'))
    await scanSessions(locations)
    const stats = statSync(rollout)
    const cache = SessionScanCache.load(locations.scanCache)
    expect(cache.get(rollout, stats.size, stats.mtimeMs)?.preview).toBe('缓存里的标题')
    expect(cache.get(rollout, stats.size + 1, stats.mtimeMs)).toBeNull()
  })
})
