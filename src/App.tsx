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
  groupedCleanupOutcomes,
  cleanupStatusReason,
  snapshotSessionBytes,
  snapshotGeneratedAssetBytes,
  snapshotPluginBytes,
  snapshotWorktreeBytes,
  listableSessions,
  workspaceBytes,
  formatBytes
} from '../shared/types'
import { decodeMessage, message } from '../shared/messages'
import type { Message } from '../shared/messages'
import OverviewView from './views/OverviewView'
import { storageDistribution } from './storage-distribution'
import SessionsView, { type SessionInitialSelection } from './views/SessionsView'
import GeneratedAssetsView from './views/GeneratedAssetsView'
import PluginsView from './views/PluginsView'
import WorkspaceView from './views/WorkspaceView'
import WorktreesView from './views/WorktreesView'
import AutomationView from './views/AutomationView'
import SettingsView from './views/SettingsView'
import { BackIcon, BrandMark, NavIcon, RescanIcon, StopIcon, type NavGlyphName } from './icons'
import { usePreferences } from './preferences'
import './App.css'

type Page = 'overview' | 'sessions' | 'generatedAssets' | 'workspace' | 'worktrees' | 'plugins' | 'settings' | 'automation'

function App() {
  const { t, e } = usePreferences()
  const [page, setPage] = useState<Page>('overview')
  const [sessionInitialSelection, setSessionInitialSelection] = useState<SessionInitialSelection>('none')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [cleanProgress, setCleanProgress] = useState<CleanupProgress | null>(null)
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null)
  const [dialogReport, setDialogReport] = useState<CleanupReport | null>(null)
  const [quitCodex, setQuitCodex] = useState(false)
  const [forceQuitCodex, setForceQuitCodex] = useState(false)
  const [updatingCleanupPreview, setUpdatingCleanupPreview] = useState(false)
  const [cleanupStage, setCleanupStage] = useState<Message | null>(null)
  const [cleanupError, setCleanupError] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const scanInFlight = useRef(false)

  const runScan = useCallback(async () => {
    if (scanInFlight.current) return
    scanInFlight.current = true
    setError(null)
    setProgress({ stage: null, currentPath: '', fraction: 0 })
    try {
      const next = await window.cleanmycodex.scan()
      if (next) {
        setSnapshot(next)
        setWorkspace(next.workspace)
        setAppInfo(await window.cleanmycodex.appInfo())
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      // Cancelling is a normal outcome the renderer asked for, not something to report.
      if (decodeMessage(text)?.key !== 'error.scanStopped') setError(text)
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
      setCleanupError(null)
      setQuitCodex(false)
      setForceQuitCodex(false)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [cleaning, progress])

  const navigate = useCallback((nextPage: Page): void => {
    setSessionInitialSelection('none')
    setPage(nextPage)
  }, [])

  const openSuggestedSessions = useCallback((): void => {
    setSessionInitialSelection('suggested-archives')
    setPage('sessions')
  }, [])

  const runCleanup = useCallback(
    async () => {
      if (!cleanupPreview || cleaning) return
      setCleaning(true)
      setDialogReport(null)
      setCleanupError(null)
      setCleanProgress({ completed: 0, total: cleanupPreview.items.length, currentTitle: '' })
      try {
        const nextReport = await window.cleanmycodex.cleanup({ selection: cleanupPreview.selection, quitCodex, forceQuitCodex })
        await runScan()
        setDialogReport(nextReport)
      } catch (err) {
        // setError renders in the main pane (App.tsx pane-error) as well as the
        // initial-scan view, so on a cleanup failure it would duplicate the message
        // that cleanupError already surfaces inside the dialog. Surface it only there.
        const text = err instanceof Error ? err.message : String(err)
        setCleanupError(text)
      } finally {
        setCleaning(false)
        setCleanProgress(null)
      }
    },
    [cleaning, cleanupPreview, forceQuitCodex, quitCodex, runScan]
  )

  const setDeleteRelatedSessions = useCallback(async (value: boolean) => {
    if (!cleanupPreview || (cleanupPreview.selection.kind !== 'worktrees' && cleanupPreview.selection.kind !== 'workspace') || updatingCleanupPreview) return
    setUpdatingCleanupPreview(true)
    setError(null)
    try {
      const preview = await window.cleanmycodex.prepareCleanup({
        ...cleanupPreview.selection,
        deleteRelatedSessions: value
      })
      setCleanupPreview(preview)
      setCleanupError(null)
      setQuitCodex(false)
      setForceQuitCodex(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUpdatingCleanupPreview(false)
    }
  }, [cleanupPreview, updatingCleanupPreview])

  useEffect(() => {
    const offScan = window.cleanmycodex.onScanProgress(setProgress)
    const offClean = window.cleanmycodex.onCleanupProgress(setCleanProgress)
    const offStage = window.cleanmycodex.onCleanupStage(setCleanupStage)
    const offSettings = window.cleanmycodex.onOpenSettings(() => setPage('settings'))
    void runScan()
    return () => {
      offScan()
      offClean()
      offStage()
      offSettings()
    }
  }, [runScan])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || cleaning || updatingCleanupPreview) return
      if (cleanupPreview) setCleanupPreview(null)
      else if (page === 'automation') setPage('settings')
      else if (page !== 'overview') setPage('overview')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cleaning, cleanupPreview, page, updatingCleanupPreview])

  const dialogs = <>
    {cleanupPreview && (cleaning || dialogReport
      ? <CleanupExperience preview={cleanupPreview} report={dialogReport} progress={cleanProgress}
          scanProgress={progress} stage={cleanupStage} onDone={() => setCleanupPreview(null)} />
      : <CleanupDialog preview={cleanupPreview} quitCodex={quitCodex} forceQuit={forceQuitCodex} requireQuitConfirmation={page !== 'overview'}
          onQuitCodex={setQuitCodex} onForceQuit={setForceQuitCodex}
          updating={updatingCleanupPreview} onDeleteRelatedSessions={setDeleteRelatedSessions}
          onConfirm={runCleanup} onClose={() => setCleanupPreview(null)} error={cleanupError} />)}
  </>

  if (!snapshot) return <>
    <InitialScanView progress={progress} error={error} onRetry={runScan} />
    {dialogs}
  </>

  const titles: Record<Page, string> = {
    overview: t('总览', 'Overview'),
    sessions: t('会话记录', 'Sessions'),
    generatedAssets: t('会话资产', 'Session Assets'),
    workspace: t('工作区', 'Workspace'),
    worktrees: t('Worktree', 'Worktrees'),
    plugins: t('插件版本', 'Plugin Versions'),
    settings: t('设置', 'Settings'),
    automation: t('定时清理', 'Scheduled Cleanup')
  }

  return <>
    <div className="shell">
      <Sidebar page={page} onNavigate={navigate} snapshot={snapshot} workspace={workspace} />
      <div className="pane">
        <header className="titlebar">
          <div className="titlebar-title">
            {page !== 'overview' && <button className="icon-button titlebar-back"
              title={page === 'automation' ? t('返回设置', 'Back to Settings') : t('返回总览', 'Back to Overview')}
              aria-label={page === 'automation' ? t('返回设置', 'Back to Settings') : t('返回总览', 'Back to Overview')}
              onClick={() => navigate(page === 'automation' ? 'settings' : 'overview')}><BackIcon /></button>}
            <h2>{titles[page]}</h2>
          </div>
          <div className="titlebar-actions">
            {progress && <span className="titlebar-status">{t('扫描中', 'Scanning')} {Math.round((progress.fraction || 0) * 100)}%</span>}
            <button className="btn btn-quiet" disabled={cleaning} onClick={() => progress ? window.cleanmycodex.cancelScan() : runScan()}
              title={progress ? t('停止扫描', 'Stop Scan') : t('重新扫描', 'Scan Again')}>
              {progress ? <StopIcon /> : <RescanIcon />}
              <span>{progress ? t('停止', 'Stop') : t('重新扫描', 'Scan Again')}</span>
            </button>
          </div>
          <span className="titlebar-progress" aria-hidden="true" style={{ transform: `scaleX(${progress ? Math.max(0.02, progress.fraction || 0) : 0})` }} />
        </header>

        {error && <p className="pane-error">{t('出错：', 'Error: ')}{e(error)}</p>}

        {page === 'overview' && <OverviewView snapshot={snapshot} appInfo={appInfo} cleaning={cleaning}
          actionsDisabled={!!progress} cleanProgress={cleanProgress} onCleanup={requestCleanup}
          onOpenSessions={() => navigate('sessions')} onOpenSuggestedSessions={openSuggestedSessions}
          onOpenGeneratedAssets={() => navigate('generatedAssets')} onOpenWorkspace={() => navigate('workspace')}
          onOpenWorktrees={() => navigate('worktrees')} onOpenPlugins={() => navigate('plugins')} onRescan={runScan} />}
        {page === 'sessions' && <SessionsView snapshot={snapshot} cleaning={cleaning} actionsDisabled={!!progress}
          cleanProgress={cleanProgress} onCleanup={requestCleanup} initialSelection={sessionInitialSelection} />}
        {page === 'generatedAssets' && <GeneratedAssetsView snapshot={snapshot} cleaning={cleaning} actionsDisabled={!!progress}
          cleanProgress={cleanProgress} onCleanup={requestCleanup} />}
        {page === 'plugins' && <PluginsView snapshot={snapshot} cleaning={cleaning} actionsDisabled={!!progress}
          canUninstall={appInfo?.codexBinaryAvailable ?? false} cleanProgress={cleanProgress} onCleanup={requestCleanup} />}
        {page === 'workspace' && workspace && <WorkspaceView snapshot={workspace} cleaning={cleaning} actionsDisabled={!!progress} cleanProgress={cleanProgress} onCleanup={requestCleanup} />}
        {page === 'worktrees' && <WorktreesView snapshot={snapshot} cleaning={cleaning} actionsDisabled={!!progress} cleanProgress={cleanProgress} onCleanup={requestCleanup} />}
        {page === 'settings' && <SettingsView onOpenScheduledCleanup={() => setPage('automation')} />}
        {page === 'automation' && <AutomationView />}
      </div>
    </div>
    {dialogs}
  </>
}

function Sidebar({ page, snapshot, workspace, onNavigate }: {
  page: Page
  snapshot: ScanSnapshot
  workspace: WorkspaceSnapshot | null
  onNavigate: (page: Page) => void
}) {
  const { t } = usePreferences()
  const sessionCount = listableSessions(snapshot).length
  const items: Array<{ page: Page; glyph: NavGlyphName; label: string; value: string }> = [
    { page: 'overview', glyph: 'overview', label: t('总览', 'Overview'), value: formatBytes(storageDistribution(workspace ? { ...snapshot, workspace } : snapshot).total) },
    { page: 'sessions', glyph: 'sessions', label: t('会话记录', 'Sessions'), value: sessionCount ? formatBytes(snapshotSessionBytes(snapshot)) : '—' },
    { page: 'generatedAssets', glyph: 'generatedAssets', label: t('会话资产', 'Session Assets'), value: snapshot.generatedAssets.length ? formatBytes(snapshotGeneratedAssetBytes(snapshot)) : '—' },
    { page: 'workspace', glyph: 'workspace', label: t('工作区', 'Workspace'), value: workspace?.entries.length ? formatBytes(workspaceBytes(workspace)) : '—' },
    { page: 'worktrees', glyph: 'worktrees', label: t('Worktree', 'Worktrees'), value: (snapshot.worktrees ?? []).length ? formatBytes(snapshotWorktreeBytes(snapshot)) : '—' },
    { page: 'plugins', glyph: 'plugins', label: t('插件版本', 'Plugins'), value: formatBytes(snapshotPluginBytes(snapshot)) }
  ]
  return <aside className="sidebar">
    <div className="sidebar-head">
      <BrandMark />
      <span className="brand-text"><strong>Clean My Codex</strong><small>{t('Codex 空间管理', 'Codex storage')}</small></span>
    </div>
    <nav className="nav" aria-label={t('主导航', 'Main navigation')}>
      {items.map((item) => <button key={item.page} className={`nav-item${page === item.page ? ' selected' : ''}`}
        aria-current={page === item.page ? 'page' : undefined} onClick={() => onNavigate(item.page)}>
        <NavIcon name={item.glyph} />
        <span className="nav-label">{item.label}</span>
        <span className="nav-value">{item.value}</span>
      </button>)}
    </nav>
    <div className="sidebar-foot">
      <button className={`nav-item${page === 'settings' || page === 'automation' ? ' selected' : ''}`}
        aria-current={page === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}>
        <NavIcon name="settings" />
        <span className="nav-label">{t('设置', 'Settings')}</span>
      </button>
    </div>
  </aside>
}

function InitialScanView({ progress, error, onRetry }: {
  progress: ScanProgress | null
  error: string | null
  onRetry: () => void
}) {
  const { t, m, e } = usePreferences()
  const fraction = Math.max(0, Math.min(1, progress?.fraction ?? 0))
  const percent = Math.round(fraction * 100)
  const stage = m(progress?.stage ?? message('stage.preparing'))

  return <section className={`initial-scan${error ? ' initial-scan-error' : ''}`} aria-live="polite">
    <span className="drag-strip" aria-hidden="true" />
    <div className="initial-scan-shell">
      <div className="initial-scan-brand"><BrandMark /><strong>Clean My Codex</strong></div>
      <div className="scan-visual" aria-hidden="true">
        <svg className="scan-orbits" viewBox="0 0 168 168" fill="none">
          <circle className="scan-orbit scan-orbit-outer" cx="84" cy="84" r="75" strokeDasharray="92 42 118 54 74 91"/>
          <circle className="scan-orbit scan-orbit-inner" cx="84" cy="84" r="50" strokeDasharray="54 44 92 56 34 34"/>
          <g className="scan-tracer">
            <circle cx="84" cy="84" r="63" strokeDasharray="76 320"/>
            <circle className="scan-tracer-dot" cx="147" cy="84" r="2.4"/>
          </g>
        </svg>
        <span className="scan-core">
          <svg viewBox="0 0 32 32" fill="currentColor">
            <path d="M17.5 4.8c1.1 5.4 3.9 8.2 9.3 9.3-5.4 1.1-8.2 3.9-9.3 9.3-1.1-5.4-3.9-8.2-9.3-9.3 5.4-1.1 8.2-3.9 9.3-9.3Z"/>
            <path className="scan-sparkle-small" d="M8.1 19.7c.5 2.3 1.7 3.5 4 4-2.3.5-3.5 1.7-4 4-.5-2.3-1.7-3.5-4-4 2.3-.5 3.5-1.7 4-4Z"/>
          </svg>
        </span>
      </div>

      {error ? <>
        <span className="initial-scan-kicker">{t('扫描未完成', 'Scan not completed')}</span>
        <h1>{t('暂时没能读取 Codex 空间', 'Could not read Codex storage')}</h1>
        <p className="initial-scan-lead">{e(error)}</p>
        <button className="btn primary btn-large" onClick={onRetry}>{t('重新扫描', 'Try Again')}</button>
      </> : <>
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

function CleanupDialog({ preview, quitCodex, forceQuit, requireQuitConfirmation, updating, error, onQuitCodex, onForceQuit, onDeleteRelatedSessions, onConfirm, onClose }: {
  preview: CleanupPreview; quitCodex: boolean; forceQuit: boolean; requireQuitConfirmation: boolean; updating: boolean
  error: string | null
  onQuitCodex: (value: boolean) => void; onForceQuit: (value: boolean) => void
  onDeleteRelatedSessions: (value: boolean) => void; onConfirm: () => void; onClose: () => void
}) {
  const { t, m, e } = usePreferences()
  const quitRequiredButUnchecked = requireQuitConfirmation && preview.blockedTitles.length > 0 && !quitCodex
  return <div className="modal-backdrop"><section className="cleanup-dialog" role="dialog" aria-modal="true">
    <><h2>{t(`确认清理 ${preview.items.length} 项`, `Confirm cleanup of ${preview.items.length} items`)}</h2>
      <p className="dialog-lead">{t(`预计释放 ${formatBytes(preview.expectedBytes)}`, `About ${formatBytes(preview.expectedBytes)} will be freed.`)}</p>
      <ul className="preview-list">{preview.items.map((item) => <li key={item.id}><span><strong>{item.title} <em className="method-badge">{t('删除', 'Delete')}</em></strong><small>{item.detail}</small></span><b>{formatBytes(item.expectedBytes)}</b></li>)}</ul>
      {(preview.selection.kind === 'worktrees' || preview.selection.kind === 'workspace') && <label className={`worktree-session-option${preview.selection.deleteRelatedSessions ? ' selected' : ''}`}><input type="checkbox"
        checked={preview.selection.deleteRelatedSessions} disabled={updating}
        onChange={(event) => onDeleteRelatedSessions(event.target.checked)}/><strong>{m(message('warning.worktreeRelatedSessions'))}</strong></label>}
      {preview.warnings.map((warning) => <p className="notice warning" key={warning.key}>{m(warning)}</p>)}
      {error && <p className="notice warning">{e(error)}</p>}
      {!!preview.blockedTitles.length && <div className="notice warning"><strong>{t('需要 Codex 完全退出', 'Codex must quit completely')}</strong><br/>
        {preview.canQuitCodex ? <><label><input type="checkbox" checked={quitCodex} onChange={(event) => { onQuitCodex(event.target.checked); if (!event.target.checked) onForceQuit(false) }}/> {t('先退出 Codex', 'Quit Codex first')}</label>
          {quitCodex && <label><input type="checkbox" checked={forceQuit} onChange={(event) => onForceQuit(event.target.checked)}/> {t('正常退出超时后强制结束（可能丢失未保存内容）', 'Force quit after timeout (unsaved work may be lost)')}</label>}</>
          : <small>{preview.blockers.map(m).join(t('，', ', '))}</small>}</div>}
    </>
    <div className="dialog-actions"><button className="btn" disabled={updating} onClick={onClose}>{t('取消', 'Cancel')}</button>
      <button className="btn danger" disabled={updating || quitRequiredButUnchecked} onClick={onConfirm}>{updating ? t('更新中…', 'Updating…') : t('确认执行', 'Confirm')}</button></div>
  </section></div>
}

function CleanupExperience({ preview, report, progress, scanProgress, stage, onDone }: {
  preview: CleanupPreview
  report: CleanupReport | null
  progress: CleanupProgress | null
  scanProgress: ScanProgress | null
  stage: Message | null
  onDone: () => void
}) {
  const { t, m } = usePreferences()
  if (report) {
    const outcomes = groupedCleanupOutcomes(report.outcomes)
    const succeeded = outcomes.filter((outcome) => outcome.status.kind === 'succeeded').length
    const skipped = outcomes.filter((outcome) => outcome.status.kind === 'skipped').length
    const failed = outcomes.filter((outcome) => outcome.status.kind === 'failed').length
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
          <div className="cleanup-result-heading"><h3>{t('处理明细', 'Details')}</h3><span>{t(`${outcomes.length} 项`, `${outcomes.length} items`)}</span></div>
          <ul className="report-list">
            {outcomes.map((outcome) => <li key={outcome.id} className={`report-row report-${outcome.status.kind}`}>
              <span className="report-row-title">{outcome.title}</span>
              <span className="report-row-status">{m(message(`status.${outcome.status.kind}`))}</span>
              {cleanupStatusReason(outcome.status) && <span className="report-row-msg">{m(cleanupStatusReason(outcome.status)!)}</span>}
            </li>)}
          </ul>
        </section>
        <div className="result-actions"><button className="btn primary btn-large result-done" onClick={onDone}>{t('返回', 'Back')}</button></div>
      </div>
    </div>
  }

  const total = progress?.total || preview.items.length || 1
  const completed = progress?.completed ?? 0
  const refreshing = scanProgress !== null
  const fraction = refreshing
    ? 0.88 + Math.max(0, Math.min(1, scanProgress.fraction)) * 0.12
    : Math.max(0, Math.min(0.86, completed / total * 0.86))
  const title = (stage && m(stage)) || (refreshing ? t('正在核对清理结果', 'Verifying cleanup results') : t('正在为 Codex 减负', 'Cleaning up Codex'))
  const current = refreshing
    ? (scanProgress.currentPath || (scanProgress.stage && m(scanProgress.stage)) || t('重新统计空间占用', 'Recalculating storage usage'))
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
