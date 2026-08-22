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
import './App.css'

type Detail = 'sessions' | 'plugins' | 'workspace' | 'automation'

function App() {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [cleanProgress, setCleanProgress] = useState<CleanupProgress | null>(null)
  const [report, setReport] = useState<CleanupReport | null>(null)
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null)
  const [dialogReport, setDialogReport] = useState<CleanupReport | null>(null)
  const [restartCodex, setRestartCodex] = useState(false)
  const [cleanupStage, setCleanupStage] = useState('')
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const [workspaceScanning, setWorkspaceScanning] = useState(false)
  const [workspaceAttempted, setWorkspaceAttempted] = useState(false)
  const scanInFlight = useRef(false)
  const workspaceScanInFlight = useRef(false)

  const runScan = useCallback(async () => {
    if (scanInFlight.current) return
    scanInFlight.current = true
    setError(null)
    setReport(null)
    setProgress({ stage: '扫描中', currentPath: '', scannedBytes: 0, fraction: 0 })
    try {
      const next = await window.cleanmycodex.scan()
      if (next) {
        setSnapshot(next)
        setWorkspace(next.workspace)
        setWorkspaceAttempted(false)
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

  const runWorkspaceScan = useCallback(async () => {
    if (workspaceScanInFlight.current) return
    workspaceScanInFlight.current = true
    setWorkspaceAttempted(true)
    setWorkspaceScanning(true)
    setProgress({ stage: '工作产出', currentPath: '', scannedBytes: 0, fraction: 0 })
    setError(null)
    try {
      const next = await window.cleanmycodex.scanWorkspace()
      if (next) setWorkspace(next)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes('扫描已停止')) setError(message)
    }
    finally { workspaceScanInFlight.current = false; setWorkspaceScanning(false); setProgress(null) }
  }, [])

  const requestCleanup = useCallback(async (selection: CleanupSelection) => {
    if (cleaning || progress) return
    setError(null)
    try {
      const preview = await window.cleanmycodex.prepareCleanup(selection)
      if (!preview.items.length) return
      setCleanupPreview(preview)
      setDialogReport(null)
      setRestartCodex(false)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [cleaning, progress])

  const runCleanup = useCallback(
    async () => {
      if (!cleanupPreview || cleaning) return
      setCleaning(true)
      setReport(null)
      setDialogReport(null)
      setCleanProgress({ completed: 0, total: cleanupPreview.items.length, currentTitle: '' })
      try {
        const nextReport = await window.cleanmycodex.cleanup({ selection: cleanupPreview.selection, restartCodex })
        await runScan()
        if (cleanupPreview.selection.kind === 'workspace') await runWorkspaceScan()
        setReport(nextReport)
        setDialogReport(nextReport)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setCleaning(false)
        setCleanProgress(null)
      }
    },
    [cleaning, cleanupPreview, restartCodex, runScan, runWorkspaceScan]
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
    if (!cleaning && detail === 'workspace' && workspace && !workspace.isScanned && !workspaceScanning && !workspaceAttempted) void runWorkspaceScan()
  }, [cleaning, runWorkspaceScan, detail, workspace, workspaceAttempted, workspaceScanning])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || cleaning) return
      if (cleanupPreview) setCleanupPreview(null)
      else if (detail) setDetail(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cleaning, cleanupPreview, detail])

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>CleanMyCodex</h1>
          <p className="subtitle">Codex 空间扫描与清理工具</p>
        </div>
        <div className="action-buttons">
          <button className="btn" onClick={() => setDetail('automation')}>自动清理</button>
          {progress ? <button className="btn" onClick={() => window.cleanmycodex.cancelScan()}>停止扫描</button>
            : <button className="btn" onClick={runScan} disabled={cleaning}>重新扫描</button>}
        </div>
      </header>

      {progress && <div className="progress"><progress value={progress.fraction} max={1}/><span>{progress.stage} · {progress.currentPath}</span></div>}
      {error && <p className="error">出错：{error}</p>}

      {report && <CleanupBanner report={report} />}

      {snapshot && <OverviewView snapshot={snapshot} workspace={workspace} appInfo={appInfo} cleaning={cleaning}
        actionsDisabled={!!progress} cleanProgress={cleanProgress} onCleanup={requestCleanup} onOpenDetail={setDetail} />}
      {detail && <div className="detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !cleaning) setDetail(null) }}>
        <section className="detail-sheet" onMouseDown={(event) => event.stopPropagation()}>
        <div className="detail-toolbar"><button className="btn" onClick={() => setDetail(null)}><span className="back-arrow">‹</span>返回</button></div>
        {snapshot && detail === 'sessions' ? <SessionsView snapshot={snapshot} appServerAvailable={!!appInfo?.appServerAvailable} cleaning={cleaning} actionsDisabled={!!progress} cleanProgress={cleanProgress} onCleanup={requestCleanup} />
          : snapshot && detail === 'plugins' ? <PluginsView snapshot={snapshot} cleaning={cleaning} actionsDisabled={!!progress} cleanProgress={cleanProgress} onCleanup={requestCleanup} />
          : detail === 'workspace' && workspace ? <WorkspaceView snapshot={workspace} scanning={workspaceScanning} cleaning={cleaning} actionsDisabled={!!progress} cleanProgress={cleanProgress} onScan={runWorkspaceScan} onCleanup={requestCleanup} />
          : detail === 'automation' ? <AutomationView /> : null}
      </section></div>}
      {cleanupPreview && <CleanupDialog preview={cleanupPreview} report={dialogReport} cleaning={cleaning}
        progress={cleanProgress} stage={cleanupStage} restart={restartCodex} onRestart={setRestartCodex}
        onConfirm={runCleanup} onClose={() => !cleaning && setCleanupPreview(null)} />}
    </main>
  )
}

function CleanupDialog({ preview, report, cleaning, progress, stage, restart, onRestart, onConfirm, onClose }: {
  preview: CleanupPreview; report: CleanupReport | null; cleaning: boolean; progress: CleanupProgress | null;
  stage: string; restart: boolean; onRestart: (value: boolean) => void; onConfirm: () => void; onClose: () => void
}) {
  return <div className="modal-backdrop"><section className="cleanup-dialog" role="dialog" aria-modal="true">
    {report ? <><h2>清理结果</h2><CleanupBanner report={report}/></> : cleaning ? <>
      <h2>{stage || '正在清理…'}</h2><progress value={progress?.completed ?? 0} max={progress?.total || 1}/>
      <p>{progress?.currentTitle || '准备中…'} · {progress?.completed ?? 0}/{progress?.total ?? preview.items.length}</p>
    </> : <><h2>确认清理 {preview.items.length} 项</h2>
      <p className="dialog-lead">预计释放 {formatBytes(preview.expectedBytes)}，文件会移到系统废纸篓。</p>
      <ul className="preview-list">{preview.items.map((item) => <li key={item.id}><span><strong>{item.title} <em className="method-badge">{CleanupMethodLabel[item.method]}</em></strong><small>{item.detail}</small></span><b>{formatBytes(item.expectedBytes)}</b></li>)}</ul>
      {preview.warnings.map((warning) => <p className="notice warning" key={warning}>{warning}</p>)}
      {!!preview.blockedTitles.length && <div className="notice warning"><strong>{preview.blockedTitles.length} 项需要 Codex 完全退出</strong><br/>{preview.blockedTitles.slice(0, 4).join('、')}
        {preview.canRestartCodex ? <label><input type="checkbox" checked={restart} onChange={(event) => onRestart(event.target.checked)}/> 先退出 Codex，清理完成后重新打开</label>
          : <small>{preview.blockerSummary}，这些项目本次不会执行；退出 Codex 后需重新清理。</small>}</div>}
    </>}
    <div className="dialog-actions">{!cleaning && <button className="btn" onClick={onClose}>{report ? '完成' : '取消'}</button>}
      {!report && !cleaning && <button className="btn danger" onClick={onConfirm}>确认执行</button>}</div>
  </section></div>
}

function CleanupBanner({ report }: { report: CleanupReport }) {
  const skipped = report.outcomes.filter((outcome) => outcome.status.kind === 'skipped').length
  const failed = report.outcomes.filter((outcome) => outcome.status.kind === 'failed').length
  return (
    <section className="report">
      <p className="report-summary">
        已释放 <b>{formatBytes(reportFreedBytes(report))}</b>
        {skipped > 0 && `，${skipped} 项跳过`}
        {failed > 0 && `，${failed} 项失败`}
      </p>
      <ul className="report-list">
        {report.outcomes.map((o) => (
          <li key={o.id} className={`report-row report-${o.status.kind}`}>
            <span className="report-row-title">{o.title}</span>
            <span className="report-row-status">{cleanupStatusLabel(o.status)}</span>
            {cleanupStatusMessage(o.status) && <span className="report-row-msg">{cleanupStatusMessage(o.status)}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

export default App
