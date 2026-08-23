import { app } from 'electron'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteOrphanSessionRecords,
  deleteSessionRecords,
  findOrphanDesktopRecords,
  findOrphanSessionRecords,
  sessionProtocolThreadIDs
} from '../../electron/main/session-database'
import { deleteDesktopThreadRows, pruneDesktopState } from '../../electron/main/desktop-store'

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


/**
 * The desktop keeps its own conversation list in ~/.codex/sqlite. Deleting a session has
 * to clear it, without touching rows that merely have an `id` column.
 */
function desktopStoreSweep(): void {
  const root = newRoot()
  const doomed = '01a02dc9-083a-7150-aaf6-90183e827e35'
  const kept = '01a02dc9-1111-7000-8000-000000000001'
  mkdirSync(join(root, 'sqlite'), { recursive: true })
  const desktop = new Database(join(root, 'sqlite', 'codex-dev.db'))
  desktop.exec(`
    CREATE TABLE local_thread_catalog (host TEXT, thread_id TEXT, title TEXT, created_at REAL, updated_at REAL);
    CREATE TABLE thread_timeline_ledger (thread_id TEXT, position INTEGER);
    CREATE TABLE automations (id TEXT, name TEXT);
    INSERT INTO local_thread_catalog VALUES ('local', '${doomed}', 'Respond to greeting', 1787474544.0, 1787474551.0);
    INSERT INTO local_thread_catalog VALUES ('local', '${kept}', 'Kept', 1787474544.0, 1787474551.0);
    INSERT INTO thread_timeline_ledger VALUES ('${doomed}', 1), ('${kept}', 1);
    INSERT INTO automations VALUES ('${doomed}', 'an automation that merely shares an id');
  `)
  desktop.close()
  const summaries = new Database(join(root, 'sqlite', 'codex-thread-summaries-dev.db'))
  summaries.exec(`
    CREATE TABLE thread_summaries (id TEXT PRIMARY KEY, summary TEXT);
    INSERT INTO thread_summaries VALUES ('${doomed}', 'summary'), ('${kept}', 'summary');
  `)
  summaries.close()

  const report = deleteDesktopThreadRows(root, [doomed])
  assert(report.removedRows === 3, `桌面记录删除行数错误：${report.removedRows} (${report.locations.join(' ')})`)
  const verify = new Database(join(root, 'sqlite', 'codex-dev.db'), { readonly: true })
  const catalog = verify.prepare('SELECT thread_id FROM local_thread_catalog').pluck().all()
  const automations = verify.prepare('SELECT id FROM automations').pluck().all()
  verify.close()
  assert(catalog.length === 1 && catalog[0] === kept, `桌面会话列表没有清理：${catalog.join(',')}`)
  assert(automations.length === 1, '与会话无关的表被误删')
  const verifySummaries = new Database(join(root, 'sqlite', 'codex-thread-summaries-dev.db'), { readonly: true })
  const remaining = verifySummaries.prepare('SELECT id FROM thread_summaries').pluck().all()
  verifySummaries.close()
  assert(remaining.length === 1 && remaining[0] === kept, `会话摘要没有清理：${remaining.join(',')}`)
}

/** The desktop's persisted state, where threads appear as map keys, list items and fields. */
function desktopStatePrune(): void {
  const root = newRoot()
  const doomed = '01a02dc9-083a-7150-aaf6-90183e827e35'
  const kept = '01a02dc9-1111-7000-8000-000000000001'
  const state = {
    'electron-main-window-bounds': { width: 1180, height: 800 },
    'pinned-thread-ids': [doomed, kept],
    'thread-project-assignments': {
      [doomed]: { projectKind: 'local', projectId: 'local-a' },
      [kept]: { projectKind: 'local', projectId: 'local-b' }
    },
    'queued-follow-ups': [{ threadId: doomed, text: 'go on' }, { threadId: kept, text: 'stay' }],
    'electron-persisted-atom-state': { 'composer-draft': { [doomed]: 'untouched interface state' } }
  }
  writeFileSync(join(root, '.codex-global-state.json'), JSON.stringify(state))
  writeFileSync(join(root, '.codex-global-state.json.bak'), JSON.stringify(state))
  const backups = join(root, 'backups')

  const report = pruneDesktopState(root, [doomed], backups)
  assert(report.removed === 6, `桌面状态清理条数错误：${report.removed} (${report.files.join(' ')})`)
  const written = JSON.parse(readFileSync(join(root, '.codex-global-state.json'), 'utf8')) as Record<string, any>
  assert(written['pinned-thread-ids'].join(',') === kept, '置顶会话没有清理')
  assert(!(doomed in written['thread-project-assignments']) && kept in written['thread-project-assignments'], '会话项目归属没有清理')
  assert(written['queued-follow-ups'].length === 1 && written['queued-follow-ups'][0].threadId === kept, '排队任务没有清理')
  assert(written['electron-main-window-bounds'].width === 1180, '无关状态被改写')
  assert(doomed in written['electron-persisted-atom-state']['composer-draft'], '界面状态不应改动')
  const backedUp = JSON.parse(readFileSync(join(root, '.codex-global-state.json.bak'), 'utf8')) as Record<string, any>
  assert(backedUp['pinned-thread-ids'].join(',') === kept, '备份状态没有一起清理')
  assert(readdirSync(backups).length === 2, `没有留下改写前的副本：${readdirSync(backups).join(',')}`)
}

/** A desktop list entry Codex no longer knows about is what survives thread/delete. */
function desktopLeftovers(): void {
  const root = newRoot()
  const liveID = '01a02dc9-2222-7000-8000-000000000002'
  const ghostID = '01a02dc9-083a-7150-aaf6-90183e827e35'
  const remoteID = '01a02dc9-3333-7000-8000-000000000003'
  writeRollout(rolloutPath(root, liveID))
  mkdirSync(join(root, 'sqlite'), { recursive: true })
  const desktop = new Database(join(root, 'sqlite', 'codex-dev.db'))
  desktop.exec(`
    CREATE TABLE local_thread_catalog (host TEXT, thread_id TEXT, title TEXT, updated_at REAL);
    INSERT INTO local_thread_catalog VALUES
      ('local', '${liveID}', 'Live', 1787000000.0),
      ('local', '${ghostID}', 'Respond to greeting', ${Math.floor(Date.now() / 1000)}.0),
      ('remote-1', '${remoteID}', 'On another host', 1787000000.0);
  `)
  desktop.close()

  const orphans = findOrphanDesktopRecords(root)
  assert(orphans.length === 1 && orphans[0].threadID === ghostID,
    `桌面残留识别错误：${orphans.map((orphan) => `${orphan.threadID}:${orphan.title}`).join(',')}`)

  const repaired = deleteOrphanSessionRecords(root, join(root, 'backups'))
  assert(repaired.threadIDs.includes(ghostID), `桌面残留没有进入清理集合：${repaired.threadIDs.join(',')}`)
  const verify = new Database(join(root, 'sqlite', 'codex-dev.db'), { readonly: true })
  const remaining = (verify.prepare('SELECT thread_id FROM local_thread_catalog').pluck().all() as string[]).sort()
  verify.close()
  assert(remaining.join(',') === [liveID, remoteID].sort().join(','), `桌面残留清理错误：${remaining.join(',')}`)
  assert(findOrphanDesktopRecords(root).length === 0, '桌面残留清理后仍有残留')
}

app.whenReady().then(() => {
  try {
    threadClosure()
    desktopThreadRow()
    leftoverRepair()
    unfamiliarPathsAreLeftAlone()
    desktopStoreSweep()
    desktopStatePrune()
    desktopLeftovers()
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
