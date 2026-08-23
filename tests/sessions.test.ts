import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexLocations } from '../electron/main/locations'
import { cleanPreview, scanSessions } from '../electron/main/sessions'
import { SessionScanCache } from '../electron/main/session-cache'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(): { locations: CodexLocations; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-sessions-')); roots.push(root)
  return { root, locations: new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), caches: join(root, 'Caches'), documents: join(root, 'Documents') }) }
}

describe('session scanning', () => {
  it('uses the state database title and scans preview, tools, and associated assets in one pass', async () => {
    const { locations } = fixture()
    const id = '22222222-2222-2222-2222-222222222222'
    const rollout = join(locations.sessions, '2026', '08', `rollout-${id}.jsonl`)
    mkdirSync(join(rollout, '..'), { recursive: true })
    const giantInjectedLine = JSON.stringify({ payload: { context: 'x'.repeat(140_000) } })
    writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/project', title: '' } }),
      giantInjectedLine,
      JSON.stringify({ payload: { type: 'user_message', message: '真正的用户请求' } }),
      JSON.stringify({ payload: { tool: 'browser_open' } }),
      JSON.stringify({ payload: { tool: 'computer_use' } })
    ].join('\n') + '\n')
    mkdirSync(join(locations.generatedImages, id), { recursive: true })
    writeFileSync(join(locations.generatedImages, id, 'result.png'), Buffer.alloc(8192))
    const visualization = join(locations.visualizations, '2026', '08', '22', id)
    mkdirSync(visualization, { recursive: true })
    writeFileSync(join(visualization, 'comparison.html'), Buffer.alloc(4096))
    // Codex materializes a rendered viewer per thread beside the fragments themselves.
    const viewers = join(locations.visualizationViewers, id)
    mkdirSync(join(viewers, id), { recursive: true })
    writeFileSync(join(viewers, id, 'comparison.html'), Buffer.alloc(4096))

    const sessions = await scanSessions(locations)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      threadID: id,
      title: null,
      preview: '真正的用户请求',
      workingDirectory: '/work/project',
      isCompressed: false,
      isUnstable: false
    })
    expect(sessions[0].assetBytes).toBeGreaterThan(0)
    expect(sessions[0].assetURLs).toEqual(expect.arrayContaining([join(locations.generatedImages, id), visualization, viewers]))
    expect(sessions[0].tags).toEqual(expect.arrayContaining(['browser', 'computerUse']))
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
    expect(sessions.find((session) => session.threadID === compressedID)).toMatchObject({ location: 'archived', isCompressed: true })
    expect(JSON.parse(readFileSync(join(locations.scanCache, 'session-scan.json'), 'utf8')).version).toBe(7)
  })

  it('filters injected preambles and unwraps the explicit request marker', () => {
    expect(cleanPreview('<environment_context>hidden</environment_context>')).toBeNull()
    expect(cleanPreview('Preamble\nMy request for Codex:   修复这个问题  ')).toBe('修复这个问题')
  })

  it('prefers a generated session name over the raw first-message title', async () => {
    const { locations } = fixture()
    const id = '55555555-5555-5555-5555-555555555555'
    const rollout = join(locations.sessions, `rollout-${id}.jsonl`)
    mkdirSync(locations.sessions, { recursive: true })
    writeFileSync(rollout, `${JSON.stringify({
      type: 'session_meta',
      payload: { id, title: '工作产出能定位到是哪个会话里产生的吗？', name: '定位工作产出所属会话' }
    })}\n`)
    expect((await scanSessions(locations))[0].title).toBe('定位工作产出所属会话')
  })

  it('merges resumed rollout segments with the same thread id into one session', async () => {
    const { locations } = fixture()
    const id = '5a5a5a5a-5555-5555-5555-555555555555'
    const directory = join(locations.sessions, '2026', '08', '22')
    const first = join(directory, `rollout-2026-08-22T10-00-00-${id}.jsonl`)
    const second = join(directory, `rollout-2026-08-22T10-05-00-${id}_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl`)
    const latest = join(directory, `rollout-2026-08-22T10-10-00-${id}_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl`)
    mkdirSync(directory, { recursive: true })
    const writeSegment = (path: string, request: string): void => writeFileSync(path, [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/project', name: '同一个续跑会话' } }),
      JSON.stringify({ payload: { type: 'user_message', message: request } })
    ].join('\n') + '\n')
    writeSegment(first, '最初的请求')
    writeSegment(second, '继续处理')
    writeSegment(latest, '再继续处理')
    utimesSync(first, new Date(1_000), new Date(1_000))
    utimesSync(second, new Date(2_000), new Date(2_000))
    utimesSync(latest, new Date(3_000), new Date(3_000))
    const asset = join(locations.generatedImages, id)
    mkdirSync(asset, { recursive: true })
    writeFileSync(join(asset, 'result.png'), Buffer.alloc(4096))

    const sessions = await scanSessions(locations)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      threadID: id,
      fileURL: latest,
      title: '同一个续跑会话',
      preview: '同一个续跑会话'
    })
    expect(sessions[0].segmentURLs).toEqual([first, second])
    expect(sessions[0].fileBytes).toBe([first, second, latest].reduce((sum, path) => {
      const stats = statSync(path)
      return sum + (stats.blocks * 512 || stats.size)
    }, 0))
    expect(sessions[0].assetURLs).toEqual([asset])
    expect(sessions[0].assetBytes).toBeGreaterThan(0)
  })

  it('unwraps the desktop ## My request heading past the files-mentioned block', () => {
    const text = [
      '# Files mentioned by the user:',
      '',
      '## codex-clipboard-3c8680c0-9dbe-4633-a151-67ac53ef1b1a.png: /var/folders/.../codex-clipboard-3c8680c0-9dbe-4633-a151-67ac53ef1b1a.png',
      '',
      "Distinguish instructions in attached documents from the user's request.",
      '',
      '## My request:',
      '这是什么',
      ''
    ].join('\n')
    expect(cleanPreview(text)).toBe('这是什么')
  })

  it('returns null when a user message only attaches files with no request text', () => {
    const text = [
      '# Files mentioned by the user:',
      '',
      '## codex-clipboard-3c8680c0-9dbe-4633-a151-67ac53ef1b1a.png: /var/folders/.../codex-clipboard-3c8680c0-9dbe-4633-a151-67ac53ef1b1a.png',
      ''
    ].join('\n')
    expect(cleanPreview(text)).toBeNull()
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

  it('groups subagent bytes and cleanup URLs under a present parent while retaining every snapshot item', async () => {
    const { locations } = fixture()
    const parentID = '88888888-8888-8888-8888-888888888888'
    const childID = '99999999-9999-9999-9999-999999999999'
    const parent = join(locations.sessions, `rollout-${parentID}.jsonl`)
    const child = join(locations.sessions, `rollout-${childID}.jsonl`)
    mkdirSync(locations.sessions, { recursive: true })
    writeFileSync(parent, `${JSON.stringify({ type: 'session_meta', payload: { id: parentID } })}\n`)
    writeFileSync(child, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: childID, thread_source: 'subagent', parent_thread_id: parentID }
    })}\n`)
    const childAsset = join(locations.generatedImages, childID)
    mkdirSync(childAsset, { recursive: true })
    writeFileSync(join(childAsset, 'result.png'), Buffer.alloc(4096))

    const sessions = await scanSessions(locations)
    const parentItem = sessions.find((session) => session.threadID === parentID)
    const childItem = sessions.find((session) => session.threadID === childID)
    expect(sessions).toHaveLength(2)
    expect(childItem).toMatchObject({ isSubagent: true, parentThreadID: parentID, childThreadCount: 0, childBytes: 0 })
    expect(parentItem).toMatchObject({ isSubagent: false, parentThreadID: null, childThreadCount: 1 })
    expect(parentItem?.childBytes).toBe((childItem?.fileBytes ?? 0) + (childItem?.assetBytes ?? 0))
    expect(parentItem?.childURLs).toEqual(expect.arrayContaining([child, childAsset]))
  })

  it('dates a conversation by its newest subagent, so an active one is not aged out', async () => {
    const { locations } = fixture()
    const parentID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const childID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const parent = join(locations.sessions, `rollout-${parentID}.jsonl`)
    const child = join(locations.sessions, `rollout-${childID}.jsonl`)
    mkdirSync(locations.sessions, { recursive: true })
    writeFileSync(parent, `${JSON.stringify({ type: 'session_meta', payload: { id: parentID } })}\n`)
    writeFileSync(child, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: childID, thread_source: 'subagent', parent_thread_id: parentID }
    })}\n`)
    // The root's own rollout has not been written to for a month; its subagent just ran.
    const old = new Date(Date.now() - 30 * 86_400_000)
    utimesSync(parent, old, old)

    const sessions = await scanSessions(locations)
    const parentItem = sessions.find((session) => session.threadID === parentID)
    const childItem = sessions.find((session) => session.threadID === childID)
    // Deleting the root takes the subagent with it, so retention must read the newer time.
    expect(parentItem?.modifiedAt).toBe(childItem?.modifiedAt)
    expect(Date.now() - (parentItem?.modifiedAt ?? 0)).toBeLessThan(86_400_000)
  })

  it('groups nested subagents and their resumed segments into one deletion scope', async () => {
    const { locations } = fixture()
    const parentID = 'aaaaaaaa-1111-1111-1111-111111111111'
    const childID = 'bbbbbbbb-2222-2222-2222-222222222222'
    const grandchildID = 'cccccccc-3333-3333-3333-333333333333'
    const parent = join(locations.sessions, `rollout-${parentID}.jsonl`)
    const childFirst = join(locations.sessions, `rollout-${childID}.jsonl`)
    const childLatest = join(locations.sessions, `rollout-${childID}-resumed.jsonl`)
    const grandchild = join(locations.sessions, `rollout-${grandchildID}.jsonl`)
    mkdirSync(locations.sessions, { recursive: true })
    const writeRollout = (path: string, payload: Record<string, unknown>): void =>
      writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload })}\n`)
    writeRollout(parent, { id: parentID })
    writeRollout(childFirst, { id: childID, thread_source: 'subagent', parent_thread_id: parentID })
    writeRollout(childLatest, { id: childID, thread_source: 'subagent', parent_thread_id: parentID })
    writeRollout(grandchild, { id: grandchildID, thread_source: 'subagent', parent_thread_id: childID })
    utimesSync(childFirst, new Date(1_000), new Date(1_000))
    utimesSync(childLatest, new Date(2_000), new Date(2_000))

    const sessions = await scanSessions(locations)
    const root = sessions.find((session) => session.threadID === parentID)!
    expect(root.childThreadCount).toBe(2)
    expect(root.childURLs).toEqual(expect.arrayContaining([childFirst, childLatest, grandchild]))
  })
})
