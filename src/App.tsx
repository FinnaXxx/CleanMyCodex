import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type ScanSnapshot,
  type ScanProgress,
  type CleanupReport,
  type CleanupProgress,
  type CleanupSelection,
  type CleanupPreview,
  type AppInfo,
  type WorkspaceSnapshot,
  reportFreedBytes,
  cleanupStatusLabel,
  cleanupStatusMessage,
  CleanupMethodLabel,
  formatBytes
} from '../shared/types'
import OverviewView from './views/OverviewView'
import SessionsView from './views/SessionsView'
import PluginsView from './views/PluginsView'
import WorkspaceView from './views/WorkspaceView'
import AutomationView from './views/AutomationView'
import SettingsView from './views/SettingsView'
import { usePreferences } from './preferences'
import './App.css'

type Detail = 'sessions' | 'plugins' | 'workspace' | 'settings' | 'automation'

function App() {
  const { t } = usePreferences()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [cleanProgress, setCleanProgress] = useState<CleanupProgress | null>(null)
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null)
  const [dialogReport, setDialogReport] = useState<CleanupReport | null>(null)
  const [restartCodex, setRestartCodex] = useState(false)
  const [forceQuitCodex, setForceQuitCodex] = useState(false)
  const [cleanupStage, setCleanupStage] = useState('')
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const scanInFlight = useRef(false)

  const runScan = useCallback(async () => {
    if (scanInFlight.current) return
    scanInFlight.current = true
    setError(null)
    setProgress({ stage: document.documentElement.lang === 'en' ? 'Scanning' : '扫描中', currentPath: '', scannedBytes: 0, fraction: 0 })
    try {
      const next = await window.cleanmycodex.scan()
      if (next) {
        setSnapshot(next)
        setWorkspace(next.workspace)
        setAppInfo(await window.cleanmycodex.appInfo())
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes('扫描已停止')) setError(message)
    } finally {
      scanInFlight.current = false
      setProgress(null)
    }
  }, [])

  const requestCleanup = useCallback(async (selection: CleanupSelection) => {
    if (cleaning || progress) return
    setError(null)
    try {
      const preview = await window.cleanmycodex.prepareCleanup(selection)
      if (!preview.items.length) return
      setCleanupPreview(preview)
      setDialogReport(null)
      setRestartCodex(preview.canRestartCodex && preview.blockedTitles.length > 0)
      setForceQuitCodex(false)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [cleaning, progress])

  const runCleanup = useCallback(
    async () => {
      if (!cleanupPreview || cleaning) return
      setCleaning(true)
      setDialogReport(null)
      setCleanProgress({ completed: 0, total: cleanupPreview.items.length, currentTitle: '' })
      try {
        const nextReport = await window.cleanmycodex.cleanup({ selection: cleanupPreview.selection, restartCodex, forceQuitCodex })
        await runScan()
        setDialogReport(nextReport)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setCleaning(false)
        setCleanProgress(null)
      }
    },
    [cleaning, cleanupPreview, forceQuitCodex, restartCodex, runScan]
  )

  useEffect(() => {
    const offScan = window.cleanmycodex.onScanProgress(setProgress)
    const offClean = window.cleanmycodex.onCleanupProgress(setCleanProgress)
    const offStage = window.cleanmycodex.onCleanupStage(setCleanupStage)
    void runScan()
    return () => {
      offScan()
      offClean()
      offStage()
    }
  }, [runScan])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || cleaning) return
      if (cleanupPreview) setCleanupPreview(null)
      else if (detail === 'automation') setDetail('settings')
      else if (detail) setDetail(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cleaning, cleanupPreview, detail])

  return (
    <main className="app">
      {!snapshot && <InitialScanView progress={progress} error={error} onRetry={runScan} />}
      {error && snapshot && <p className="error">{t('出错', 'Error')}：{error}</p>}

      {snapshot && <OverviewView snapshot={snapshot} workspace={workspace} appInfo={appInfo} cleaning={cleaning}
        scanning={!!progress} scanProgress={progress} actionsDisabled={!!progress} cleanProgress={cleanProgress} onCleanup={requestCleanup}
        onScan={() => progress ? window.cleanmycodex.cancelScan() : runScan()} onOpenDetail={setDetail} />}
      {detail && <div className="detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !cleaning) setDetail(null) }}>
        <section className="detail-sheet" onMouseDown={(event) => event.stopPropagation()}>
        {snapshot && detail === 'sessions' ? <SessionsView snapshot={snapshot} cleaning={cleaning} actionsDisabled={!!progress} cleanProgress={cleanProgress} onBack={() => setDetail(null)} onCleanup={requestCleanup} />
          : snapshot && detail === 'plugins' ? <PluginsView snapshot={snapshot} cleaning={cleaning} actionsDisabled={!!progress} cleanProgress={cleanProgress} onBack={() => setDetail(null)} onCleanup={requestCleanup} />
          : detail === 'workspace' && workspace ? <WorkspaceView snapshot={workspace} cleaning={cleaning} actionsDisabled={!!progress} cleanProgress={cleanProgress} onBack={() => setDetail(null)} onCleanup={requestCleanup} />
          : detail === 'settings' ? <SettingsView onBack={() => setDetail(null)} onOpenScheduledCleanup={() => setDetail('automation')} />
          : detail === 'automation' ? <AutomationView onBack={() => setDetail('settings')} /> : null}
      </section></div>}
      {cleanupPreview && (cleaning || dialogReport
        ? <CleanupExperience preview={cleanupPreview} report={dialogReport} progress={cleanProgress}
            scanProgress={progress} stage={cleanupStage} onDone={() => setCleanupPreview(null)} />
        : <CleanupDialog preview={cleanupPreview} restart={restartCodex} forceQuit={forceQuitCodex} onRestart={setRestartCodex} onForceQuit={setForceQuitCodex}
            onConfirm={runCleanup} onClose={() => setCleanupPreview(null)} />)}
    </main>
  )
}

function InitialScanView({ progress, error, onRetry }: {
  progress: ScanProgress | null
  error: string | null
  onRetry: () => void
}) {
  const { t, language } = usePreferences()
  const fraction = Math.max(0, Math.min(1, progress?.fraction ?? 0))
  const percent = Math.round(fraction * 100)
  const stage = progress?.stage
    ? (language === 'zh-CN' ? progress.stage : ({
        '扫描中': 'Scanning',
        '缓存与临时文件': 'Caches & temporary files',
        '插件': 'Plugins',
        '会话': 'Sessions',
        '资产目录': 'Asset folders',
        '工作产出': 'Workspace output'
      } as Record<string, string>)[progress.stage] ?? progress.stage)
    : t('正在准备', 'Preparing')

  return <section className={`initial-scan${error ? ' initial-scan-error' : ''}`} aria-live="polite">
    <div className="initial-scan-shell">
      <div className="initial-scan-brand"><strong>Clean My Codex</strong></div>
      <div className="scan-visual" aria-hidden="true">
        <span className="scan-ring scan-ring-one" />
        <span className="scan-ring scan-ring-two" />
        <span className="scan-beam" />
        <span className="scan-core">
          <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="16" cy="8" rx="8.5" ry="3.5"/><path d="M7.5 8v8c0 2 3.8 3.5 8.5 3.5s8.5-1.5 8.5-3.5V8M7.5 16v8c0 2 3.8 3.5 8.5 3.5s8.5-1.5 8.5-3.5v-8"/>
          </svg>
        </span>
      </div>

      {error ? <>
        <span className="initial-scan-kicker">{t('扫描未完成', 'Scan not completed')}</span>
        <h1>{t('暂时没能读取 Codex 空间', 'Could not read Codex storage')}</h1>
        <p className="initial-scan-lead">{error}</p>
        <button className="btn primary btn-large" onClick={onRetry}>{t('重新扫描', 'Try Again')}</button>
      </> : <>
        <span className="initial-scan-kicker">{t('首次空间分析', 'Initial storage analysis')}</span>
        <h1>{t('正在分析 Codex 空间', 'Analyzing Codex storage')}</h1>
        <p className="initial-scan-lead">{t('正在安全地统计缓存、会话与插件，首次扫描可能需要一点时间。', 'Safely measuring caches, sessions, and plugins. The first scan may take a moment.')}</p>
        <div className="initial-scan-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span style={{ width: `${Math.max(fraction * 100, progress ? 2 : 0)}%` }} />
        </div>
        <div className="initial-scan-meta"><strong>{stage}</strong><span>{percent}%</span></div>
        <p className="initial-scan-path" title={progress?.currentPath}>{progress?.currentPath || t('正在建立安全扫描范围…', 'Building a safe scan scope…')}</p>
        <p className="initial-scan-assurance"><span aria-hidden="true">✓</span>{t('扫描过程只读取文件信息，不会修改任何内容', 'Scanning only reads file information and never changes your data')}</p>
      </>}
    </div>
  </section>
}

function CleanupDialog({ preview, restart, forceQuit, onRestart, onForceQuit, onConfirm, onClose }: {
  preview: CleanupPreview; restart: boolean; forceQuit: boolean; onRestart: (value: boolean) => void; onForceQuit: (value: boolean) => void; onConfirm: () => void; onClose: () => void
}) {
  const { t, language } = usePreferences()
  const deletesSessions = preview.selection.kind === 'sessions-delete'
  return <div className="modal-backdrop"><section className="cleanup-dialog" role="dialog" aria-modal="true">
    <><h2>{t(`确认清理 ${preview.items.length} 项`, `Confirm cleanup of ${preview.items.length} items`)}</h2>
      <p className="dialog-lead">{deletesSessions
        ? t(`预计释放 ${formatBytes(preview.expectedBytes)}，会话将永久删除，附属生成资产会移到系统废纸篓。`, `About ${formatBytes(preview.expectedBytes)} will be freed. Sessions will be permanently deleted; generated assets will be moved to the system Trash.`)
        : t(`预计释放 ${formatBytes(preview.expectedBytes)}，文件会移到系统废纸篓。`, `About ${formatBytes(preview.expectedBytes)} will be freed. Files will be moved to the system Trash.`)}</p>
      <ul className="preview-list">{preview.items.map((item) => <li key={item.id}><span><strong>{item.title} <em className="method-badge">{deletesSessions ? t('永久删除', 'Delete Permanently') : language === 'zh-CN' ? CleanupMethodLabel[item.method] : 'Move to Trash'}</em></strong><small>{item.detail}</small></span><b>{formatBytes(item.expectedBytes)}</b></li>)}</ul>
      {preview.warnings.map((warning) => <p className="notice warning" key={warning}>{warning}</p>)}
      {!!preview.blockedTitles.length && <div className="notice warning"><strong>{t('需要 Codex 完全退出', 'Codex must quit completely')}</strong><br/>{preview.blockedTitles.slice(0, 4).join(t('、', ', '))}
        {preview.canRestartCodex ? <><label><input type="checkbox" checked={restart} onChange={(event) => { onRestart(event.target.checked); if (!event.target.checked) onForceQuit(false) }}/> {t('先退出 Codex，清理完成后重新打开', 'Quit Codex first, then reopen it after cleanup')}</label>
          {restart && <label><input type="checkbox" checked={forceQuit} onChange={(event) => onForceQuit(event.target.checked)}/> {t('正常退出超时后强制结束（可能丢失未保存内容）', 'Force quit after timeout (unsaved work may be lost)')}</label>}</>
          : <small>{preview.blockerSummary}{t('，这些项目本次不会执行；退出 Codex 后需重新清理。', '. These items will be skipped. Quit Codex and run cleanup again.')}</small>}</div>}
    </>
    <div className="dialog-actions"><button className="btn" onClick={onClose}>{t('取消', 'Cancel')}</button>
      <button className="btn danger" onClick={onConfirm}>{t('确认执行', 'Confirm')}</button></div>
  </section></div>
}

function CleanupExperience({ preview, report, progress, scanProgress, stage, onDone }: {
  preview: CleanupPreview
  report: CleanupReport | null
  progress: CleanupProgress | null
  scanProgress: ScanProgress | null
  stage: string
  onDone: () => void
}) {
  const { t, language } = usePreferences()
  if (report) {
    const succeeded = report.outcomes.filter((outcome) => outcome.status.kind === 'succeeded').length
    const skipped = report.outcomes.filter((outcome) => outcome.status.kind === 'skipped').length
    const failed = report.outcomes.filter((outcome) => outcome.status.kind === 'failed').length
    const seconds = Math.max(0, (report.finishedAt - report.startedAt) / 1000)
    const duration = seconds < 1 ? t('<1 秒', '<1 sec') : t(`${Math.round(seconds)} 秒`, `${Math.round(seconds)} sec`)
    return <div className="cleanup-flow cleanup-flow-complete" role="dialog" aria-modal="true" aria-labelledby="cleanup-result-title">
      <div className="cleanup-flow-shell">
        <div className="success-visual" aria-hidden="true">
          <span className="success-halo" />
          <span className="success-particle particle-one" />
          <span className="success-particle particle-two" />
          <span className="success-particle particle-three" />
          <svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="36"/><path d="m24 40 10 10 22-23"/></svg>
        </div>
        <span className="cleanup-kicker">{t('清理完成', 'Cleanup complete')}</span>
        <h2 id="cleanup-result-title">{t('空间已释放，轻装继续', 'Space reclaimed. You are good to go.')}</h2>
        <div className="result-bytes"><strong>{formatBytes(reportFreedBytes(report))}</strong><span>{t('成功释放', 'reclaimed')}</span></div>
        <div className="result-stats">
          <div><strong>{succeeded}</strong><span>{t('处理成功', 'Succeeded')}</span></div>
          <div><strong>{duration}</strong><span>{t('清理用时', 'Duration')}</span></div>
          <div className={failed ? 'result-has-problems' : ''}><strong>{skipped + failed}</strong><span>{t('需要留意', 'Needs attention')}</span></div>
        </div>
        <section className="cleanup-result-detail">
          <div className="cleanup-result-heading"><h3>{t('处理明细', 'Details')}</h3><span>{t(`${report.outcomes.length} 项`, `${report.outcomes.length} items`)}</span></div>
          <ul className="report-list">
            {report.outcomes.map((outcome) => <li key={outcome.id} className={`report-row report-${outcome.status.kind}`}>
              <span className="report-row-title">{outcome.title}</span>
              <span className="report-row-status">{language === 'zh-CN' ? cleanupStatusLabel(outcome.status) : ({ succeeded: 'Completed', skipped: 'Skipped', failed: 'Failed' } as const)[outcome.status.kind]}</span>
              {cleanupStatusMessage(outcome.status) && <span className="report-row-msg">{cleanupStatusMessage(outcome.status)}</span>}
            </li>)}
          </ul>
        </section>
        <div className="result-actions"><button className="btn primary btn-large result-done" onClick={onDone}>{t('回到首页', 'Back to Home')}</button></div>
      </div>
    </div>
  }

  const total = progress?.total || preview.items.length || 1
  const completed = progress?.completed ?? 0
  const refreshing = scanProgress !== null
  const fraction = refreshing
    ? 0.88 + Math.max(0, Math.min(1, scanProgress.fraction)) * 0.12
    : Math.max(0, Math.min(0.86, completed / total * 0.86))
  const title = (language === 'zh-CN' ? stage : ({ '正在退出 Codex…': 'Quitting Codex…', '正在重新打开 Codex…': 'Reopening Codex…' } as Record<string, string>)[stage]) || (refreshing ? t('正在核对清理结果', 'Verifying cleanup results') : t('正在为 Codex 减负', 'Cleaning up Codex'))
  const current = refreshing
    ? (scanProgress.currentPath || scanProgress.stage || t('重新统计空间占用', 'Recalculating storage usage'))
    : (progress?.currentTitle || t('正在准备安全清理…', 'Preparing safe cleanup…'))

  return <div className="cleanup-flow cleanup-flow-running" role="dialog" aria-modal="true" aria-labelledby="cleanup-progress-title">
    <div className="cleanup-flow-shell">
      <div className="cleaning-visual" aria-hidden="true">
        <span className="cleaning-orbit orbit-one" />
        <span className="cleaning-orbit orbit-two" />
        <span className="cleaning-core"><strong>{Math.round(fraction * 100)}%</strong></span>
      </div>
      <span className="cleanup-kicker">{t('Clean My Codex 正在工作', 'Clean My Codex is working')}</span>
      <h2 id="cleanup-progress-title">{title}</h2>
      <p className="cleanup-current" title={current}>{current}</p>
      <div className="cleanup-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <span style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="cleanup-progress-meta">
        <span>{t('预计释放', 'Expected')} <strong>{formatBytes(preview.expectedBytes)}</strong></span>
        <span>{refreshing ? t('即将完成', 'Almost done') : t(`${completed} / ${total} 项`, `${completed} / ${total} items`)}</span>
      </div>
      <p className="cleanup-assurance">{t('清理过程遵循安全规则，请保持应用开启', 'Safety rules are active. Keep the app open during cleanup.')}</p>
    </div>
  </div>
}

export default App
