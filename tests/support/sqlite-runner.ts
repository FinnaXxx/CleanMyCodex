import { app } from 'electron'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactDatabase, inspectDatabase } from '../../electron/main/sqlite-maintenance'

app.whenReady().then(() => {
  const root = mkdtempSync(join(tmpdir(), 'cleanmycodex-sqlite-electron-'))
  try {
    const path = join(root, 'logs_test.sqlite')
    const db = new Database(path)
    db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, payload BLOB);')
    const insert = db.prepare('INSERT INTO logs(payload) VALUES (randomblob(8192))')
    db.transaction(() => { for (let index = 0; index < 600; index += 1) insert.run() })()
    db.exec('DELETE FROM logs WHERE id <= 500;')
    db.close()

    const inspection = inspectDatabase(path)
    if (inspection.reclaimableBytes <= 1024 * 1024) throw new Error('没有检测到预期的空闲页')
    const report = compactDatabase(path)
    if (!report.integrityOK || report.afterBytes >= report.beforeBytes) throw new Error('VACUUM 没有回收空间')

    const verify = new Database(path, { readonly: true })
    const retained = (verify.prepare('SELECT count(*) AS count FROM logs').get() as { count: number }).count
    verify.close()
    if (retained !== 100) throw new Error(`保留行数错误：${retained}`)
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
