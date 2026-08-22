import { useCallback, useEffect, useState } from 'react'
import {
  type ScanSnapshot,
  type ScanProgress,
  type CleanupReport,
  type CleanupProgress,
  type CleanupTask,
  type WorkspaceSnapshot,
  reportFreedBytes,
  reportProblems,
  cleanupStatusLabel,
  cleanupStatusMessage,
  formatBytes
} from '../shared/types'
import OverviewView from './views/OverviewView'
import SessionsView from './views/SessionsView'
import PluginsView from './views/PluginsView'
import WorkspaceView from './views/WorkspaceView'
import AutomationView from './views/AutomationView'
import './App.css'

type Tab = 'overview' | 'sessions' | 'plugins' | 'workspace' | 'automation'

function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [cleanProgress, setCleanProgress] = useState<CleanupProgress | null>(null)
  const [report, setReport] = useState<CleanupReport | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const [workspaceScanning, setWorkspaceScanning] = useState(false)
  const [workspaceAttempted, setWorkspaceAttempted] = useState(false)

  const runScan = useCallback(async () => {
    setError(null)
    setReport(null)
    setProgress({ stage: '扫描中', currentPath: '', scannedBytes: 0, fraction: 0 })
    try {
      const next = await window.cleanmycodex.scan()
      setSnapshot(next)
      setWorkspace((current) => current?.isScanned ? current : next.workspace)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProgress(null)
    }
  }, [])

  const runWorkspaceScan = useCallback(async () => {
    setWorkspaceAttempted(true)
    setWorkspaceScanning(true)
    setProgress({ stage: '工作产出', currentPath: '', scannedBytes: 0, fraction: 0 })
    setError(null)
    try { setWorkspace(await window.cleanmycodex.scanWorkspace()) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setWorkspaceScanning(false); setProgress(null) }
  }, [])

  const runCleanup = useCallback(
    async (tasks: CleanupTask[]) => {
      if (tasks.length === 0 || cleaning) return
      setCleaning(true)
      setReport(null)
      setCleanProgress({ completed: 0, total: tasks.length, currentTitle: '' })
      try {
        const nextReport = await window.cleanmycodex.cleanup(tasks)
        await runScan()
        if (tasks.some((task) => task.id.startsWith('workspace:'))) await runWorkspaceScan()
        setReport(nextReport)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setCleaning(false)
        setCleanProgress(null)
      }
    },
    [cleaning, runScan, runWorkspaceScan]
  )

  useEffect(() => {
    const offScan = window.cleanmycodex.onScanProgress(setProgress)
    const offClean = window.cleanmycodex.onCleanupProgress(setCleanProgress)
    void runScan()
    return () => {
      offScan()
      offClean()
    }
  }, [runScan])

  useEffect(() => {
    if (tab === 'workspace' && workspace && !workspace.isScanned && !workspaceScanning && !workspaceAttempted) void runWorkspaceScan()
  }, [runWorkspaceScan, tab, workspace, workspaceAttempted, workspaceScanning])

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>CleanMyCodex</h1>
          <p className="subtitle">Codex 空间扫描与清理工具</p>
        </div>
        <button className="rescan" onClick={runScan} disabled={!!progress || cleaning}>
          {progress ? '扫描中…' : '重新扫描'}
        </button>
      </header>

      <nav className="tabs">
        <button className={tab === 'overview' ? 'tab active' : 'tab'} onClick={() => setTab('overview')}>
          空间概览
        </button>
        <button
          className={tab === 'sessions' ? 'tab active' : 'tab'}
          onClick={() => setTab('sessions')}
          disabled={!snapshot || snapshot.sessions.length === 0}
        >
          会话记录{snapshot && snapshot.sessions.length > 0 ? ` (${snapshot.sessions.length})` : ''}
        </button>
        <button className={tab === 'plugins' ? 'tab active' : 'tab'} onClick={() => setTab('plugins')}>插件{snapshot?.pluginVersions.length ? ` (${snapshot.pluginVersions.length})` : ''}</button>
        <button className={tab === 'workspace' ? 'tab active' : 'tab'} onClick={() => setTab('workspace')}>工作产出</button>
        <button className={tab === 'automation' ? 'tab active' : 'tab'} onClick={() => setTab('automation')}>自动清理</button>
      </nav>

      {progress && <p className="progress">正在查看 {progress.currentPath}</p>}
      {error && <p className="error">出错：{error}</p>}

      {report && <CleanupBanner report={report} />}

      {snapshot && (tab === 'overview' ? (
          <OverviewView snapshot={snapshot} cleaning={cleaning} cleanProgress={cleanProgress} onCleanup={runCleanup} />
        ) : tab === 'sessions' ? (
          <SessionsView snapshot={snapshot} cleaning={cleaning} cleanProgress={cleanProgress} onCleanup={runCleanup} />
        ) : tab === 'plugins' ? (
          <PluginsView snapshot={snapshot} cleaning={cleaning} cleanProgress={cleanProgress} onCleanup={runCleanup} />
        ) : tab === 'workspace' && workspace ? (
          <WorkspaceView snapshot={workspace} scanning={workspaceScanning} cleaning={cleaning} cleanProgress={cleanProgress} onScan={runWorkspaceScan} onCleanup={runCleanup} />
        ) : tab === 'automation' ? <AutomationView /> : null)}
    </main>
  )
}

function CleanupBanner({ report }: { report: CleanupReport }) {
  const problems = reportProblems(report)
  return (
    <section className="report">
      <p className="report-summary">
        已释放 {formatBytes(reportFreedBytes(report))}
        {problems.length > 0 && `，${problems.length} 项未完成`}
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
