import { app } from 'electron'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteOrphanSessionRecords,
  deleteSessionRecords,
  findOrphanSessionRecords,
  sessionProtocolThreadIDs
} from '../../electron/main/session-database'

const roots: string[] = []

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-sqlite-electron-'))
  roots.push(root)
  return root
}

function assert(condition: boolean, description: string): void {
  if (!condition) throw new Error(description)
}

function rolloutPath(root: string, id: string, stamp = '2026-08-22T21-28-28'): string {
  return join(root, 'sessions', `rollout-${stamp}-${id}.jsonl`)
}

function writeRollout(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '{"type":"session_meta"}\n')
  return path
}

/** The original closure: root thread, spawned descendants and continuation segments. */
function threadClosure(): void {
  const root = newRoot()
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
  writeFileSync(join(root, 'session_index.jsonl'), [
    JSON.stringify({ id: 'parent', thread_name: 'Parent' }),
    JSON.stringify({ id: 'child', thread_name: 'Child' }),
    JSON.stringify({ id: 'grandchild', thread_name: 'Grandchild' }),
    JSON.stringify({ id: segmentID, thread_name: 'Continuation' }),
    '{malformed index row',
    JSON.stringify({ id: 'other', thread_name: 'Other' })
  ].join('\n') + '\n')
  const protocolParent = '01a02a7f-6000-7000-8000-000000000001'
  const protocolSegment = '01a02a7f-6000-7000-8000-000000000002'
  const protocolChild = '01a02a7f-6000-7000-8000-000000000003'
  const protocolIDs = sessionProtocolThreadIDs(root, protocolParent, [
    join(root, `rollout-2026-08-23T01-00-00-${protocolParent}.jsonl`),
    join(root, `rollout-2026-08-23T01-01-00-${protocolParent}_${protocolSegment}.jsonl`),
    join(root, `rollout-2026-08-23T01-02-00-${protocolChild}.jsonl`),
    join(root, 'generated_images', protocolChild)
  ])
  assert(protocolIDs.join(',') === `${protocolChild},${protocolParent}`, `协议会话 ID 闭包错误：${protocolIDs.join(',')}`)
  const deleted = deleteSessionRecords(root, 'parent', [join(root, `rollout-2026-08-22T21-28-28-parent_${segmentID}.jsonl`)])
  assert(deleted.removedRows === 24, `会话删除行数错误：${deleted.removedRows}`)
  const verifyState = new Database(state, { readonly: true })
  const remainingThreads = verifyState.prepare('SELECT id FROM threads').pluck().all()
  verifyState.close()
  const verifyHistory = new Database(history, { readonly: true })
  const remainingItems = Number(verifyHistory.prepare('SELECT count(*) FROM thread_items').pluck().get())
  verifyHistory.close()
  const remainingIndex = readFileSync(join(root, 'session_index.jsonl'), 'utf8')
  assert(remainingThreads.length === 1 && remainingThreads[0] === 'other' && remainingItems === 1, '会话数据库没有完整清理')
  assert(!remainingIndex.includes('parent') && !remainingIndex.includes('child') && !remainingIndex.includes(segmentID), '会话索引元数据没有完整清理')
  assert(remainingIndex.includes('{malformed index row') && remainingIndex.includes('"id":"other"'), '会话索引误删了无关元数据')
}

/**
 * A desktop thread carries an id of its own and points at a rollout named after the
 * session id. Nothing in the filename reveals that id, so both the protocol request and
 * the local deletion have to resolve it through the rollout path.
 */
function desktopThreadRow(): void {
  const root = newRoot()
  const sessionID = '01a029ec-eb25-7803-be8e-12e53f21cf79'
  const desktopID = '01a02a7e-4f6b-7d22-96be-31630feaf495'
  const keptID = '01a02b00-1111-7000-8000-000000000001'
  const rollout = writeRollout(rolloutPath(root, sessionID))
  const keptRollout = writeRollout(rolloutPath(root, keptID))
  const stateDB = new Database(join(root, 'state_5.sqlite'))
  stateDB.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at_ms INTEGER);
    CREATE TABLE thread_dynamic_tools (thread_id TEXT, position INTEGER);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY);
    INSERT INTO threads VALUES ('${desktopID}', '${rollout}', 1), ('${keptID}', '${keptRollout}', 1);
  `)
  stateDB.close()
  const historyDB = new Database(join(root, 'thread_history_1.sqlite'))
  historyDB.exec(`
    CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, PRIMARY KEY (thread_id, turn_id, item_id));
    INSERT INTO thread_items VALUES ('${desktopID}', 't', 'i'), ('${keptID}', 't', 'i');
  `)
  historyDB.close()
  writeFileSync(join(root, 'session_index.jsonl'), [
    JSON.stringify({ id: desktopID, thread_name: 'Deleted' }),
    JSON.stringify({ id: keptID, thread_name: 'Kept' })
  ].join('\n') + '\n')

  const protocolIDs = sessionProtocolThreadIDs(root, sessionID, [rollout])
  assert(protocolIDs.includes(desktopID), `协议请求缺少桌面会话 ID：${protocolIDs.join(',')}`)
  assert(!protocolIDs.includes(keptID), `协议请求包含了无关会话：${protocolIDs.join(',')}`)

  rmSync(rollout)
  deleteSessionRecords(root, sessionID, [rollout])
  const verify = new Database(join(root, 'state_5.sqlite'), { readonly: true })
  const remaining = verify.prepare('SELECT id FROM threads').pluck().all()
  verify.close()
  assert(remaining.length === 1 && remaining[0] === keptID, `桌面会话记录没有删除：${remaining.join(',')}`)
  const index = readFileSync(join(root, 'session_index.jsonl'), 'utf8')
  assert(!index.includes(desktopID) && index.includes(keptID), '会话索引没有跟着桌面会话记录删除')
}

/** Rows left behind by an earlier incomplete deletion, and what repairing them removes. */
function leftoverRepair(): void {
  const root = newRoot()
  const ghostID = '01a02a7e-4f6b-7d22-96be-31630feaf495'
  const liveID = '01a02b00-2222-7000-8000-000000000002'
  const freshID = '01a02b00-3333-7000-8000-000000000003'
  const missing = rolloutPath(root, ghostID)
  const live = writeRollout(rolloutPath(root, liveID))
  const stateDB = new Database(join(root, 'state_5.sqlite'))
  stateDB.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at_ms INTEGER);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY);
    INSERT INTO threads VALUES
      ('${ghostID}', '${missing}', 1),
      ('${liveID}', '${live}', 1),
      ('${freshID}', '${rolloutPath(root, freshID)}', ${Date.now()});
  `)
  stateDB.close()
  const historyDB = new Database(join(root, 'thread_history_1.sqlite'))
  historyDB.exec(`
    CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, PRIMARY KEY (thread_id, turn_id, item_id));
    INSERT INTO thread_items VALUES ('${ghostID}', 't', 'i'), ('${liveID}', 't', 'i');
  `)
  historyDB.close()
  writeFileSync(join(root, 'session_index.jsonl'), JSON.stringify({ id: ghostID, thread_name: 'Ghost' }) + '\n')

  const orphans = findOrphanSessionRecords(root)
  assert(orphans.length === 1 && orphans[0].threadID === ghostID,
    `残留会话识别错误：${orphans.map((orphan) => orphan.threadID).join(',')}`)

  const repaired = deleteOrphanSessionRecords(root)
  assert(repaired.threadIDs.length === 1 && repaired.removedRows >= 3, `残留会话清理不完整：${JSON.stringify(repaired)}`)
  const verify = new Database(join(root, 'state_5.sqlite'), { readonly: true })
  const remaining = (verify.prepare('SELECT id FROM threads').pluck().all() as string[]).sort()
  verify.close()
  assert(remaining.join(',') === [freshID, liveID].sort().join(','), `残留会话清理误删：${remaining.join(',')}`)
  assert(!readFileSync(join(root, 'session_index.jsonl'), 'utf8').includes(ghostID), '残留会话索引没有清理')
  assert(findOrphanSessionRecords(root).length === 0, '残留会话清理后仍有残留')
}

/** Paths this code cannot interpret must never be read as "every session is a leftover". */
function unfamiliarPathsAreLeftAlone(): void {
  const root = newRoot()
  writeRollout(rolloutPath(root, '01a02b00-4444-7000-8000-000000000004'))
  const stateDB = new Database(join(root, 'state_5.sqlite'))
  stateDB.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);
    INSERT INTO threads VALUES ('a', '/somewhere/else/rollout-2026-08-22T21-28-28-a.jsonl');
  `)
  stateDB.close()
  assert(findOrphanSessionRecords(root).length === 0, '无法解释的 rollout 路径被误判为残留')
}

app.whenReady().then(() => {
  try {
    threadClosure()
    desktopThreadRow()
    leftoverRepair()
    unfamiliarPathsAreLeftAlone()
    console.log('SQLITE_INTEGRATION_OK')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
