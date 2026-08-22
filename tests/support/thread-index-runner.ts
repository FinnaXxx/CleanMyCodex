import { app } from 'electron'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexLocations } from '../../electron/main/locations'
import { scanSessions } from '../../electron/main/sessions'
import { CodexThreadIndex } from '../../electron/main/thread-index'

app.whenReady().then(async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-thread-index-'))
  try {
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const id = '55555555-5555-5555-5555-555555555555'
    const rollout = join(locations.sessions, `rollout-${id}.jsonl`)
    mkdirSync(locations.sessions, { recursive: true })
    writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id, title: '旧标题' } })}\n`)
    const stale = new Database(join(locations.home, 'state_6.sqlite'))
    stale.exec('CREATE TABLE threads (id TEXT, title TEXT, rollout_path TEXT, cwd TEXT)')
    stale.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(id, '旧状态库标题', rollout, locations.workspace)
    stale.close()
    const db = new Database(join(locations.home, 'state_7.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, rollout_path TEXT, cwd TEXT, thread_source TEXT, archived INTEGER, updated_at_ms INTEGER, name TEXT)')
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      '工作产出能定位到是哪个会话里产生的吗？只看这个文件名不知道是什么内容',
      rollout,
      join(locations.workspace, '2026-08-21', 'new-chat'),
      'user',
      1,
      1234,
      null
    )
    writeFileSync(join(locations.home, 'session_index.jsonl'), `${JSON.stringify({
      id,
      thread_name: '检查Electron重构功能交互对齐',
      updated_at: '2026-08-22T08:36:39Z'
    })}\n`)
    // Codex Desktop stores the raw "# Files mentioned … ## My request:" wrapper as the
    // thread title; the index must strip it down to the real question.
    const desktopID = '66666666-6666-6666-6666-666666666666'
    const desktopRollout = join(locations.sessions, `rollout-${desktopID}.jsonl`)
    writeFileSync(desktopRollout, `${JSON.stringify({ type: 'session_meta', payload: { id: desktopID } })}\n`)
    const desktopTitle = ['# Files mentioned by the user:', '', '## codex-clipboard-x.png: /var/folders/.../codex-clipboard-x.png', '', '## My request:', '这是什么', ''].join('\n')
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(desktopID, desktopTitle, desktopRollout, null, 'user', 0, 0, null)
    db.close()
    const sessions = await scanSessions(locations)
    const named = sessions.find((session) => session.threadID === id)
    if (named?.title !== '检查Electron重构功能交互对齐') throw new Error(`会话索引标题未优先：${named?.title}`)
    const desktop = sessions.find((session) => session.threadID === desktopID)
    if (desktop?.title !== '这是什么') throw new Error(`桌面端外壳标题未剥离：${desktop?.title}`)
    const workspaceThreads = CodexThreadIndex.load(locations.home).workspaceThreads(locations.workspace)
    if (workspaceThreads[0]?.title !== '检查Electron重构功能交互对齐' || !workspaceThreads[0]?.archived) throw new Error('工作产出关联索引未生效')
    console.log('THREAD_INDEX_OK')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}).catch((error) => { console.error(error); app.exit(1) })
