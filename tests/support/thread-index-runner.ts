import { app } from 'electron'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexLocations } from '../../electron/main/locations'
import { scanSessions } from '../../electron/main/sessions'

app.whenReady().then(async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-thread-index-'))
  try {
    const locations = new CodexLocations({ home: join(root, '.codex'), library: join(root, 'Library'), documents: join(root, 'Documents') })
    const id = '55555555-5555-5555-5555-555555555555'
    const rollout = join(locations.sessions, `rollout-${id}.jsonl`)
    mkdirSync(locations.sessions, { recursive: true })
    writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id, title: '旧标题' } })}\n`)
    const stale = new Database(join(locations.home, 'state_6.sqlite'))
    stale.exec('CREATE TABLE threads (id TEXT, title TEXT, rollout_path TEXT)')
    stale.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(id, '旧状态库标题', rollout)
    stale.close()
    const db = new Database(join(locations.home, 'state_7.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, rollout_path TEXT)')
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(null, '状态库标题', rollout)
    db.close()
    const sessions = await scanSessions(locations)
    if (sessions[0]?.title !== '状态库标题') throw new Error(`标题索引未生效：${sessions[0]?.title}`)
    console.log('THREAD_INDEX_OK')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}).catch((error) => { console.error(error); app.exit(1) })
