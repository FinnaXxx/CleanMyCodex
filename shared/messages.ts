/**
 * The single translation table for everything the main process wants to say.
 *
 * The main process never builds display text: scanner, cleanup engine, planner and
 * platform services all emit `Message` values (a key plus parameters), and only the
 * renderer turns those into words, in whatever language the user picked. That keeps
 * wording changes in one place and makes it impossible for one language to silently
 * fall behind the other — adding a key without both translations is a type error.
 *
 * Errors are the one asymmetric case: they cross IPC as `Error.message` strings, so
 * `encodeMessage` hides a machine-readable token inside the text and `decodeMessage`
 * recovers it on the other side, falling back to the raw string for anything that did
 * not originate here (Node errno messages, SQLite failures, …).
 */

export type Language = 'zh-CN' | 'en'

export type MessageKey =
  // Storage sections
  | 'section.caches' | 'section.logs' | 'section.plugins' | 'section.protectedData'
  // Storage category titles
  | 'category.logDatabase.title' | 'category.logDatabase.detail'
  | 'category.sessionDatabase.title' | 'category.sessionDatabase.detail'
  | 'category.temporary.title' | 'category.temporary.detail'
  | 'category.marketplaceCache.title' | 'category.marketplaceCache.detail'
  | 'category.pluginRemnants.title' | 'category.pluginRemnants.detail'
  | 'category.pluginRuntime.title' | 'category.pluginRuntime.detail'
  | 'category.browserCache.title' | 'category.browserCache.detail'
  | 'category.appCache.title' | 'category.appCache.detail'
  | 'category.appLogs.title' | 'category.appLogs.detail'
  | 'category.computerUse.title' | 'category.computerUse.detail'
  | 'category.protectedConfig.title' | 'category.protectedConfig.detail'
  | 'category.protectedUserData.title' | 'category.protectedUserData.detail'
  // Storage entry notes
  | 'note.marketplaceStaging' | 'note.marketplaceCopy' | 'note.installLeftover' | 'note.idleThreeDays'
  | 'note.rebuildableCache' | 'note.oldAppLog' | 'note.logDatabase' | 'note.sessionProjection'
  | 'note.localMarketplace' | 'note.configOrCredentials' | 'note.stateDatabase' | 'note.browserProfile'
  | 'note.computerUseComponent' | 'note.currentPlugin' | 'note.unconfirmedPlugin' | 'note.pluginRuntime'
  // Entry tags
  | 'tag.current' | 'tag.unconfirmed' | 'tag.runtime' | 'tag.outdated' | 'tag.orphaned'
  // Enumerations
  | 'group.recommended' | 'group.review' | 'group.protectedData'
  | 'location.active' | 'location.archived'
  | 'pluginStatus.current' | 'pluginStatus.outdated' | 'pluginStatus.orphaned' | 'pluginStatus.unconfirmed'
  | 'repoState.clean' | 'repoState.dirty' | 'repoState.unpushed' | 'repoState.unknown' | 'repoState.unchecked'
  | 'status.succeeded' | 'status.skipped' | 'status.failed'
  // Scan progress stages
  | 'stage.preparing' | 'stage.caches' | 'stage.plugins' | 'stage.sessions' | 'stage.assets'
  | 'stage.workspace' | 'stage.done'
  // Cleanup stages and outcomes
  | 'cleanup.quitting' | 'cleanup.reopening'
  | 'cleanup.skipCodexRunning' | 'cleanup.skipRecentlyWritten' | 'cleanup.skipMissing'
  | 'cleanup.localIndexFailed'
  // Scan notes
  | 'scanNote.appServerUnavailable' | 'scanNote.noSessionTitles'
  // Cleanup preview warnings
  | 'warning.permanent' | 'warning.sessionDelete' | 'warning.workspaceGit'
  // Codex runtime blockers
  | 'blocker.detectionFailed' | 'blocker.desktopRunning' | 'blocker.cliRunning'
  // Guard rejections
  | 'guard.wholeDataRoot' | 'guard.outsideDataRoots' | 'guard.protectedPath' | 'guard.symlinkEscape'
  // Errors
  | 'error.scanFirst' | 'error.invalidRequest' | 'error.invalidSelection' | 'error.unsupportedSelection'
  | 'error.untrustedPath' | 'error.scanStopped' | 'error.scanFailed' | 'error.scanWorkerExited'
  | 'error.cliStillRunning' | 'error.quitUnsupported' | 'error.noRunningCodexApp' | 'error.quitRequestFailed'
  | 'error.forceQuitFailed' | 'error.quitTimedOut'
  | 'error.launchAgentUnsupported' | 'error.launchctlFailed' | 'error.schtasksUnsupported'
  | 'error.schtasksFailed' | 'error.automationUnsupported' | 'error.invalidAutomationSettings'
  | 'error.codexBinaryMissing' | 'error.appServerExited' | 'error.appServerSpawnFailed'
  | 'error.appServerTimeout' | 'error.appServerError'
  | 'error.integrityCheckFailed' | 'error.unsupportedDatabase'
  /** Text from outside this table (Node errno, SQLite, git) that is shown verbatim. */
  | 'error.verbatim'
  // Automatic cleanup log and notification
  | 'auto.disabled' | 'auto.nothingToClean' | 'auto.summary' | 'auto.skippedItem' | 'auto.failed'

export interface Message {
  key: MessageKey
  params?: Record<string, string | number>
}

export const message = (key: MessageKey, params?: Record<string, string | number>): Message =>
  params ? { key, params } : { key }

/** `[zh-CN, en]`. `{name}` placeholders are filled from `Message.params`. */
const TRANSLATIONS: Record<MessageKey, [string, string]> = {
  'section.caches': ['缓存与临时文件', 'Caches & Temporary Files'],
  'section.logs': ['日志与数据库', 'Logs & Databases'],
  'section.plugins': ['插件与组件', 'Plugins & Components'],
  'section.protectedData': ['受保护的数据', 'Protected Data'],

  'category.logDatabase.title': ['日志数据库', 'Log Databases'],
  'category.logDatabase.detail': ['仅统计占用；SQLite 空闲页会复用，不提供清理', 'Usage only; SQLite reuses free pages, so no cleanup is offered'],
  'category.sessionDatabase.title': ['会话投影数据库', 'Session Projection Databases'],
  'category.sessionDatabase.detail': ['Codex 加载会话使用的 SQLite 投影；仅统计占用，空闲页会复用，不提供清理', 'SQLite projection Codex uses to load sessions; usage only, free pages are reused, so no cleanup is offered'],
  'category.temporary.title': ['过期临时目录', 'Stale Temporary Folders'],
  'category.temporary.detail': ['安装和更新过程留下的临时目录', 'Temporary folders left by installs and updates; cleaned once Codex quits'],
  'category.marketplaceCache.title': ['插件市场缓存', 'Marketplace Cache'],
  'category.marketplaceCache.detail': ['可重新下载，离线时会影响插件安装', 'Downloadable again; removing it affects offline plugin installs'],
  'category.pluginRemnants.title': ['老版本插件与卸载残留', 'Old Plugins & Leftovers'],
  'category.pluginRemnants.detail': ['旧版本与卸载残留', 'Old versions and uninstall leftovers'],
  'category.pluginRuntime.title': ['当前插件与运行组件', 'Current Plugins & Runtime'],
  'category.pluginRuntime.detail': ['已统计但不会自动删除', 'Counted, but never removed automatically'],
  'category.browserCache.title': ['浏览器与渲染缓存', 'Browser & Rendering Cache'],
  'category.browserCache.detail': ['桌面应用按需重建的浏览器缓存', 'Browser cache the desktop app rebuilds on demand'],
  'category.appCache.title': ['应用缓存', 'App Cache'],
  'category.appCache.detail': ['桌面应用的本地缓存目录', 'Local cache folders used by the desktop app'],
  'category.appLogs.title': ['旧应用日志', 'Old App Logs'],
  'category.appLogs.detail': ['保留最近 10 天，其余可以清理', 'Keeps the last 10 days; older logs can be removed'],
  'category.computerUse.title': ['Computer Use 组件', 'Computer Use Component'],
  'category.computerUse.detail': ['Computer Use 运行所需的本地组件', 'Local component Computer Use needs in order to run'],
  'category.protectedConfig.title': ['受保护的配置', 'Protected Configuration'],
  'category.protectedConfig.detail': ['凭据、配置和状态数据库', 'Credentials, configuration, and state databases'],
  'category.protectedUserData.title': ['用户数据', 'User Data'],
  'category.protectedUserData.detail': ['浏览器登录状态与本地配置', 'Browser sign-in state and local configuration'],

  'note.marketplaceStaging': ['插件市场更新留下的 staging 目录', 'Staging folder left by a marketplace update'],
  'note.marketplaceCopy': ['插件市场的本地副本，可重新下载', 'Local copy of a marketplace; can be downloaded again'],
  'note.installLeftover': ['安装或更新时留下的目录', 'Folder left behind by an install or update'],
  'note.idleThreeDays': ['超过 3 天没有改动', 'Not modified for over 3 days'],
  'note.rebuildableCache': ['缓存目录，可重新生成', 'Cache folder; rebuilt automatically'],
  'note.oldAppLog': ['早于 10 天的应用日志', 'App log older than 10 days'],
  'note.logDatabase': ['Codex 诊断日志数据库（含 WAL/SHM）', 'Codex diagnostic log database (including WAL/SHM)'],
  'note.sessionProjection': ['会话内容投影数据库（含 WAL/SHM）', 'Session content projection database (including WAL/SHM)'],
  'note.localMarketplace': ['config.toml 注册的本地插件市场', 'Local marketplace registered in config.toml'],
  'note.configOrCredentials': ['配置、凭据或用户规则', 'Configuration, credentials, or user rules'],
  'note.stateDatabase': ['Codex 状态数据库', 'Codex state database'],
  'note.browserProfile': ['浏览器配置与登录状态', 'Browser configuration and sign-in state'],
  'note.computerUseComponent': ['Computer Use 辅助组件，删除后需要重新下载', 'Computer Use helper component; must be downloaded again if removed'],
  'note.currentPlugin': ['当前使用的插件版本', 'Plugin version currently in use'],
  'note.unconfirmedPlugin': ['无法确认状态的插件版本', 'Plugin version whose status could not be confirmed'],
  'note.pluginRuntime': ['Codex 插件运行组件', 'Codex plugin runtime component'],

  'tag.current': ['当前版本', 'Current'],
  'tag.unconfirmed': ['未确认', 'Unverified'],
  'tag.runtime': ['运行组件', 'Runtime'],
  'tag.outdated': ['旧版本', 'Old version'],
  'tag.orphaned': ['卸载残留', 'Uninstall leftover'],

  'group.recommended': ['建议清理', 'Recommended'],
  'group.review': ['谨慎清理', 'Review'],
  'group.protectedData': ['受保护', 'Protected'],

  'location.active': ['未归档', 'Active'],
  'location.archived': ['已归档', 'Archived'],

  'pluginStatus.current': ['当前版本', 'Current'],
  'pluginStatus.outdated': ['旧版本', 'Outdated'],
  'pluginStatus.orphaned': ['卸载残留', 'Leftover'],
  'pluginStatus.unconfirmed': ['未确认', 'Unverified'],

  'repoState.clean': ['已同步', 'Synced'],
  'repoState.dirty': ['有未提交改动', 'Uncommitted changes'],
  'repoState.unpushed': ['有未推送提交', 'Unpushed commits'],
  'repoState.unknown': ['状态未知', 'Unknown'],
  'repoState.unchecked': ['未检查（超出本次检查上限）', 'Not checked (scan limit reached)'],

  'status.succeeded': ['已完成', 'Completed'],
  'status.skipped': ['本次跳过', 'Skipped'],
  'status.failed': ['失败', 'Failed'],

  'stage.preparing': ['正在准备', 'Preparing'],
  'stage.caches': ['缓存与临时文件', 'Caches & temporary files'],
  'stage.plugins': ['插件', 'Plugins'],
  'stage.sessions': ['会话', 'Sessions'],
  'stage.assets': ['资产目录', 'Asset folders'],
  'stage.workspace': ['工作产出', 'Workspace output'],
  'stage.done': ['完成', 'Done'],

  'cleanup.quitting': ['正在退出 Codex…', 'Quitting Codex…'],
  'cleanup.reopening': ['正在重新打开 Codex…', 'Reopening Codex…'],
  'cleanup.skipCodexRunning': ['Codex 正在运行，请退出后重新清理', 'Codex is running. Quit it and clean up again.'],
  'cleanup.skipRecentlyWritten': ['扫描后路径又有写入，请稍后重新扫描并清理', 'The path was written to after the scan. Scan again and retry.'],
  'cleanup.skipMissing': ['路径已不存在', 'The path no longer exists'],
  'cleanup.localIndexFailed': ['会话文件已处理，但本地索引清理失败：{reason}', 'Session files were handled, but clearing the local index failed: {reason}'],

  'scanNote.appServerUnavailable': ['未连接 codex app server，无法确认插件的当前版本，已全部锁定。', 'Not connected to the codex app server, so current plugin versions cannot be confirmed. All are locked.'],
  'scanNote.noSessionTitles': ['没有读到 Codex 的会话标题，列表改用会话首句或项目名显示。', 'No Codex session titles were found. The list falls back to the first message or the project name.'],

  'warning.permanent': ['清理的内容会被永久删除，无法恢复。', 'Everything cleaned is deleted permanently and cannot be recovered.'],
  'warning.sessionDelete': ['会话文件、生成资产和 Codex 会话索引记录会一并清理。', 'Session files, generated assets, and Codex session index records are all removed together.'],
  'warning.workspaceGit': ['请确认未提交或未推送的内容已经保存。', 'Make sure anything uncommitted or unpushed has been saved.'],

  'blocker.detectionFailed': ['无法确认 Codex 是否正在运行', 'Cannot determine whether Codex is running'],
  'blocker.desktopRunning': ['ChatGPT/Codex 桌面应用或会话服务正在运行', 'The ChatGPT/Codex desktop app or its session service is running'],
  'blocker.cliRunning': ['终端里有 {count} 个 codex 进程在运行', '{count} codex processes are running in a terminal'],

  'guard.wholeDataRoot': ['不能整体删除数据目录：{path}', 'Refusing to delete an entire data directory: {path}'],
  'guard.outsideDataRoots': ['不在 Codex 数据目录内：{path}', 'Not inside a Codex data directory: {path}'],
  'guard.protectedPath': ['受保护的路径：{path}', 'Protected path: {path}'],
  'guard.symlinkEscape': ['符号链接指向数据目录外：{path}', 'Symlink points outside the data directories: {path}'],

  'error.scanFirst': ['请先完成扫描', 'Run a scan first'],
  'error.invalidRequest': ['清理请求无效', 'Invalid cleanup request'],
  'error.invalidSelection': ['清理选择无效', 'Invalid cleanup selection'],
  'error.unsupportedSelection': ['不支持的清理类型', 'Unsupported cleanup type'],
  'error.untrustedPath': ['不能打开未扫描的路径', 'Cannot open a path that was not scanned'],
  'error.scanStopped': ['扫描已停止', 'Scan stopped'],
  'error.scanFailed': ['扫描失败', 'Scan failed'],
  'error.scanWorkerExited': ['扫描进程已退出（{code}）', 'The scan process exited ({code})'],
  'error.cliStillRunning': ['终端里还有 {count} 个 codex 进程，不会自动结束', '{count} codex processes are still running in a terminal and will not be closed automatically'],
  'error.quitUnsupported': ['当前平台不能安全地请求 Codex 保存并退出，请手动退出', 'This platform cannot safely ask Codex to save and quit. Quit it manually.'],
  'error.noRunningCodexApp': ['无法识别正在运行的 Codex 应用，请手动退出后重试', 'Could not identify the running Codex app. Quit it manually and retry.'],
  'error.quitRequestFailed': ['无法请求 ChatGPT 退出：{reason}', 'Could not ask ChatGPT to quit: {reason}'],
  'error.forceQuitFailed': ['已尝试强制结束 Codex，但仍检测到运行中的进程', 'Codex was force quit, but running processes are still detected'],
  'error.quitTimedOut': ['没能退出 Codex，可能有未保存的内容。请手动退出后重试。', 'Codex did not quit, possibly because of unsaved work. Quit it manually and retry.'],
  'error.launchAgentUnsupported': ['当前系统不支持 macOS LaunchAgent', 'This system does not support macOS LaunchAgents'],
  'error.launchctlFailed': ['launchctl 无法加载定时清理任务', 'launchctl could not load the scheduled cleanup job'],
  'error.schtasksUnsupported': ['当前系统不支持 Windows 任务计划程序', 'This system does not support Windows Task Scheduler'],
  'error.schtasksFailed': ['Windows 任务计划程序无法创建定时清理任务', 'Windows Task Scheduler could not create the scheduled cleanup task'],
  'error.automationUnsupported': ['当前系统不支持定期后台清理', 'This system does not support scheduled background cleanup'],
  'error.invalidAutomationSettings': ['定时清理设置无效', 'Invalid scheduled cleanup settings'],
  'error.codexBinaryMissing': ['没有找到 codex 命令行，无法调用 app server', 'The codex CLI was not found, so the app server cannot be reached'],
  'error.appServerExited': ['codex app-server 已退出', 'codex app-server has exited'],
  'error.appServerSpawnFailed': ['无法启动 codex app-server：{reason}', 'Could not start codex app-server: {reason}'],
  'error.appServerTimeout': ['调用 {method} 超时', 'The {method} call timed out'],
  'error.appServerError': ['codex 返回错误 {code}：{reason}', 'codex returned error {code}: {reason}'],
  'error.integrityCheckFailed': ['{path} 完整性检查失败：{reason}', 'Integrity check failed for {path}: {reason}'],
  'error.unsupportedDatabase': ['{path} 缺少 {table}，暂不支持这个数据库版本', '{path} has no {table}; this database version is not supported yet'],
  'error.verbatim': ['{text}', '{text}'],

  'auto.disabled': ['定时清理未开启，跳过。', 'Scheduled cleanup is off. Skipping.'],
  'auto.nothingToClean': ['没有需要清理的项目。', 'Nothing to clean.'],
  'auto.summary': ['已释放 {bytes}，成功 {succeeded} 项，跳过 {skipped} 项，失败 {failed} 项', 'Freed {bytes}. {succeeded} succeeded, {skipped} skipped, {failed} failed.'],
  'auto.skippedItem': ['跳过：{title} — {reason}', 'Skipped: {title} — {reason}'],
  'auto.failed': ['定时清理失败：{reason}', 'Scheduled cleanup failed: {reason}']
}

export function formatMessage(value: Message, language: Language): string {
  const template = TRANSLATIONS[value.key]?.[language === 'zh-CN' ? 0 : 1]
  if (template === undefined) return value.key
  if (!value.params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in value.params! ? String(value.params![name]) : match)
}

/**
 * Errors reach the renderer as plain `Error.message` strings, and Electron wraps them
 * with its own prefix, so the token has to survive being embedded in other text. It
 * carries the Chinese rendering as well so anything that logs the raw string — the
 * automatic-cleanup log, a crash report — still reads as a sentence.
 */
const TOKEN = /⁢cmc\((\{.*?\})\)⁢/

export function encodeMessage(value: Message): string {
  return `${formatMessage(value, 'zh-CN')}⁢cmc(${JSON.stringify(value)})⁢`
}

export function decodeMessage(text: string): Message | null {
  const match = text.match(TOKEN)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]) as Message
    return typeof parsed?.key === 'string' && parsed.key in TRANSLATIONS ? parsed : null
  } catch { return null }
}

/** Renders anything that crossed IPC as an error: a known message, or the raw text. */
export function formatErrorText(text: string, language: Language): string {
  const decoded = decodeMessage(text)
  return decoded ? formatMessage(decoded, language) : text.replace(TOKEN, '')
}

/**
 * The reason on every scan `AbortError`. Cancelling is a normal outcome, so the IPC
 * layer matches on this instead of reporting the abort to the user as a failure.
 */
export const SCAN_STOPPED = encodeMessage({ key: 'error.scanStopped' })

/** An `Error` whose message a localised UI can recover with `decodeMessage`. */
export class MessageError extends Error {
  readonly info: Message
  constructor(info: Message) {
    super(encodeMessage(info))
    this.name = 'MessageError'
    this.info = info
  }
}
