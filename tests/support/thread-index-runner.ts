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
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, rollout_path TEXT, cwd TEXT, thread_source TEXT, archived INTEGER, updated_at_ms INTEGER)')
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(null, '状态库标题', rollout, null, null, 0, 0)
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, '工作产出来源', `${rollout}.other`, join(locations.workspace, '2026-08-21', 'new-chat'), 'user', 1, 1234)
    db.close()
    const sessions = await scanSessions(locations)
    if (sessions[0]?.title !== '状态库标题') throw new Error(`标题索引未生效：${sessions[0]?.title}`)
    const workspaceThreads = CodexThreadIndex.load(locations.home).workspaceThreads(locations.workspace)
    if (workspaceThreads[0]?.title !== '工作产出来源' || !workspaceThreads[0]?.archived) throw new Error('工作产出关联索引未生效')
    console.log('THREAD_INDEX_OK')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}).catch((error) => { console.error(error); app.exit(1) })
