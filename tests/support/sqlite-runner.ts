import { app } from 'electron'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSessionRecords } from '../../electron/main/session-database'

app.whenReady().then(() => {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-sqlite-electron-'))
  try {
    const state = join(root, 'state_5.sqlite')
    const history = join(root, 'thread_history_1.sqlite')
    const segmentID = '01a029a8-909e-7563-858f-3e7d03259acd'
    const stateDB = new Database(state)
    stateDB.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      CREATE TABLE thread_dynamic_tools (thread_id TEXT, position INTEGER);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY);
      INSERT INTO threads VALUES ('parent'), ('child'), ('grandchild'), ('other');
      INSERT INTO thread_dynamic_tools VALUES ('parent', 0), ('child', 0), ('grandchild', 0), ('other', 0);
      INSERT INTO thread_spawn_edges VALUES ('parent', 'child'), ('child', 'grandchild');
    `)
    stateDB.close()
    const historyDB = new Database(history)
    historyDB.exec(`
      CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
      CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, PRIMARY KEY (thread_id, turn_id));
      CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, PRIMARY KEY (thread_id, turn_id, item_id));
      INSERT INTO thread_history_projection_state VALUES ('parent', 1, 1), ('child', 1, 1), ('grandchild', 1, 1), ('${segmentID}', 1, 1), ('other', 1, 1);
      INSERT INTO thread_turns VALUES ('parent', 'p'), ('child', 'c'), ('grandchild', 'g'), ('${segmentID}', 's'), ('other', 'o');
      INSERT INTO thread_items VALUES ('parent', 'p', 'pi'), ('child', 'c', 'ci'), ('grandchild', 'g', 'gi'), ('${segmentID}', 's', 'si'), ('other', 'o', 'oi');
    `)
    historyDB.close()
    const deleted = deleteSessionRecords(root, 'parent', [join(root, `rollout-2026-08-22T21-28-28-parent_${segmentID}.jsonl`)])
    if (deleted.removedRows !== 20) throw new Error(`会话删除行数错误：${deleted.removedRows}`)
    const verifyState = new Database(state, { readonly: true })
    const remainingThreads = verifyState.prepare('SELECT id FROM threads').pluck().all()
    verifyState.close()
    const verifyHistory = new Database(history, { readonly: true })
    const remainingItems = Number(verifyHistory.prepare('SELECT count(*) FROM thread_items').pluck().get())
    verifyHistory.close()
    if (remainingThreads.length !== 1 || remainingThreads[0] !== 'other' || remainingItems !== 1) throw new Error('会话数据库没有完整清理')
    console.log('SQLITE_INTEGRATION_OK')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
