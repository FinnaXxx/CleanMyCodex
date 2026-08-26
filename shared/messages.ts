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
  | 'category.sessionDatabase.title' | 'category.sessionDatabase.detail'
  | 'category.stateDatabase.title' | 'category.stateDatabase.detail'
  | 'category.temporary.title' | 'category.temporary.detail'
  | 'category.pluginRemnants.title' | 'category.pluginRemnants.detail'
  | 'category.pluginOrphans.title' | 'category.pluginOrphans.detail'
  | 'category.pluginRuntime.title' | 'category.pluginRuntime.detail'
  | 'category.pluginRuntimeBinaries.title' | 'category.pluginRuntimeBinaries.detail'
  | 'category.pluginData.title' | 'category.pluginData.detail'
  | 'category.codexCache.title' | 'category.codexCache.detail'
  | 'category.appCache.title' | 'category.appCache.detail'
  | 'category.appLogs.title' | 'category.appLogs.detail'
  | 'category.computerUse.title' | 'category.computerUse.detail'
  | 'category.protectedConfig.title' | 'category.protectedConfig.detail'
  | 'category.protectedUserData.title' | 'category.protectedUserData.detail'
  | 'category.releaseVersions.title' | 'category.releaseVersions.detail'
  | 'category.releaseRuntime.title' | 'category.releaseRuntime.detail'
  | 'category.unrecognized.title' | 'category.unrecognized.detail'
  // Storage entry notes
  | 'note.marketplaceStaging' | 'note.installLeftover' | 'note.idleThreeDays' | 'note.helperScratch'
  | 'note.codexOperationalCache' | 'note.remotePluginCatalogCache' | 'note.codexAppsToolsCache'
  | 'note.codexAppDirectoryCache' | 'note.codexAppsServerInfoCache' | 'note.tuiPetsCache' | 'note.platformCache'
  | 'note.applicationLog' | 'note.codexLog' | 'note.logDatabase' | 'note.sessionProjection'
  | 'note.localMarketplace' | 'note.configOrCredentials' | 'note.pluginData'
  | 'note.knownMarketplaces' | 'note.stateDatabase' | 'note.browserProfile'
  | 'note.computerUseComponent' | 'note.builtinPlugin' | 'note.currentPlugin' | 'note.unconfirmedPlugin' | 'note.pluginRuntime'
  | 'note.desktopStateLeftover' | 'note.skillsBackup' | 'note.releaseVersion' | 'note.currentRelease'
  | 'note.unconfirmedRelease'
  // Entry tags
  | 'tag.builtin' | 'tag.current' | 'tag.unconfirmed' | 'tag.runtime' | 'tag.outdated' | 'tag.orphaned'
  | 'tag.unmanagedWorktree' | 'tag.orphanedWorktree'
  // Enumerations
  | 'group.recommended' | 'group.review' | 'group.protectedData'
  | 'location.active' | 'location.archived'
  | 'pluginStatus.builtin' | 'pluginStatus.current' | 'pluginStatus.outdated' | 'pluginStatus.orphaned' | 'pluginStatus.unconfirmed'
  | 'repoState.clean' | 'repoState.dirty' | 'repoState.unpushed' | 'repoState.unknown' | 'repoState.unchecked'
  | 'status.succeeded' | 'status.skipped' | 'status.failed'
  // Scan progress stages
  | 'stage.preparing' | 'stage.caches' | 'stage.plugins' | 'stage.sessions' | 'stage.assets'
  | 'stage.workspace' | 'stage.worktrees' | 'stage.done'
  // Cleanup stages and outcomes
  | 'cleanup.quitting'
  | 'cleanup.skipCodexRunning' | 'cleanup.skipRecentlyWritten' | 'cleanup.skipMissing'
  | 'cleanup.localIndexFailed' | 'cleanup.worktreeRemoveFailed' | 'cleanup.worktreeNotManaged'
  // Scan notes
  | 'scanNote.appServerUnavailable' | 'scanNote.noSessionTitles'
  // Cleanup preview warnings
  | 'warning.permanent' | 'warning.permanentWorktreeGit' | 'warning.pluginManagement' | 'warning.workspaceGit' | 'warning.pinnedSessions' | 'warning.generatedAssetLocalCopy'
  | 'warning.worktreeRelatedSessions' | 'warning.planOnlyCopy'
  // Codex runtime blockers
  | 'blocker.detectionFailed' | 'blocker.desktopRunning' | 'blocker.cliRunning' | 'blocker.quitHintWindows'
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
  | 'error.integrityCheckFailed' | 'error.unsupportedDatabase' | 'error.codexRunningForRepair'
  /** Text from outside this table (Node errno, SQLite, git) that is shown verbatim. */
  | 'error.verbatim'
  // Automatic cleanup log and notification
  | 'auto.disabled' | 'auto.nothingToClean' | 'auto.summary' | 'auto.skippedItem' | 'auto.failed'
  // Native application menu
  | 'menu.file' | 'menu.settings'
  // Application updates
  | 'update.title' | 'update.available' | 'update.detail' | 'update.detailWindows' | 'update.openRelease' | 'update.later'
  | 'update.checkTitle' | 'update.current' | 'update.currentDetail'
  | 'update.unavailable' | 'update.unavailableDetail' | 'update.failed' | 'update.failedDetail' | 'update.ok'

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

  'category.sessionDatabase.title': ['会话投影数据库', 'Session Projection Databases'],
  'category.sessionDatabase.detail': ['Codex 加载会话使用的 SQLite 投影', 'SQLite projection Codex uses to load sessions'],
  'category.stateDatabase.title': ['状态数据库', 'State Databases'],
  'category.stateDatabase.detail': ['Codex 运行状态、目标、队列、记忆与命令历史；SQLite 库含 WAL/SHM', 'Codex runtime state, goals, queue, memories, and command history; SQLite stores include WAL/SHM'],
  'category.temporary.title': ['过期临时目录', 'Stale Temporary Folders'],
  'category.temporary.detail': ['安装和更新过程留下的临时目录', 'Temporary folders left by installs and updates'],
  'category.pluginRemnants.title': ['老版本插件', 'Old Plugin Versions'],
  'category.pluginRemnants.detail': ['已有明确当前版本，可清理的旧版本', 'Older versions with a confirmed current version'],
  'category.pluginOrphans.title': ['卸载插件残留', 'Uninstalled Plugin Leftovers'],
  'category.pluginOrphans.detail': ['plugin/list 已确认未安装，仅供手动清理', 'Confirmed uninstalled by plugin/list; manual cleanup only'],
  'category.pluginRuntime.title': ['插件版本', 'Plugins'],
  'category.pluginRuntime.detail': ['Codex 正在使用的插件版本，可在插件版本页卸载', 'Plugin versions in use by Codex; uninstall them on the Plugins page'],
  'category.pluginRuntimeBinaries.title': ['插件运行组件', 'Plugin Runtime Components'],
  'category.pluginRuntimeBinaries.detail': ['插件背后的可执行文件', 'Executables behind the plugins'],
  'category.pluginData.title': ['插件数据与配置', 'Plugin Data & Configuration'],
  'category.pluginData.detail': ['插件运行所需的受保护数据', 'Protected data required by plugins'],
  'category.codexCache.title': ['Codex 可重建缓存', 'Codex Rebuildable Caches'],
  'category.codexCache.detail': ['可重建；清理后可能需要联网重新获取', 'Rebuildable; clearing may require a network refresh'],
  'category.appCache.title': ['应用缓存', 'App Cache'],
  'category.appCache.detail': ['桌面应用运行缓存', 'Desktop application runtime cache'],
  'category.appLogs.title': ['应用日志', 'Application Logs'],
  'category.appLogs.detail': ['桌面应用自己轮转', 'Rotated by the desktop application'],
  'category.computerUse.title': ['Computer Use 组件', 'Computer Use Component'],
  'category.computerUse.detail': ['Computer Use 运行所需的本地组件', 'Local component Computer Use needs in order to run'],
  'category.protectedConfig.title': ['配置项', 'Protected Configuration'],
  'category.protectedConfig.detail': ['凭据、配置和状态数据库', 'Credentials, configuration, and state databases'],
  'category.releaseVersions.title': ['旧版本 Codex 安装包', 'Old Codex Releases'],
  'category.releaseVersions.detail': ['已有明确当前版本，可清理的旧版本', 'Older releases with a confirmed current version'],
  'category.releaseRuntime.title': ['当前 Codex 安装包', 'Current Codex Release'],
  'category.releaseRuntime.detail': ['已统计但不会自动删除', 'Counted, but never removed automatically'],
  'category.unrecognized.title': ['其他', 'Other'],
  'category.unrecognized.detail': ['Codex 桌面端新增的、本应用暂未识别的内容', 'Files added by the Codex desktop app that this app does not yet recognize'],
  'category.protectedUserData.title': ['用户数据', 'User Data'],
  'category.protectedUserData.detail': ['浏览器登录状态与本地配置', 'Browser sign-in state and local configuration'],

  'note.marketplaceStaging': ['插件市场更新留下的 staging 目录', 'Staging folder left by a marketplace update'],
  'note.installLeftover': ['安装或更新时留下的目录', 'Folder left behind by an install or update'],
  'note.idleThreeDays': ['超过 3 天没有改动', 'Not modified for over 3 days'],
  'note.helperScratch': ['Codex 辅助程序遗留的临时目录', 'Temporary folder left by a Codex helper process'],
  'note.codexOperationalCache': ['冷启动与离线回退缓存', 'Cold-start and offline fallback cache'],
  'note.remotePluginCatalogCache': ['远程插件全局/用户/工作区目录快照', 'Remote plugin global/user/workspace catalog snapshot'],
  'note.codexAppsToolsCache': ['Codex Apps 连接器工具定义快照', 'Codex Apps connector tool-definition snapshot'],
  'note.codexAppDirectoryCache': ['ChatGPT Apps 公共/工作区目录快照', 'ChatGPT Apps public/workspace directory snapshot'],
  'note.codexAppsServerInfoCache': ['Codex Apps MCP 服务初始化信息快照', 'Codex Apps MCP server initialization-info snapshot'],
  'note.tuiPetsCache': ['内置 TUI 宠物精灵图、PNG 帧与 SIXEL 渲染缓存', 'Built-in TUI pet spritesheets, PNG frames, and SIXEL render cache'],
  'note.platformCache': ['桌面应用使用的运行缓存', 'Runtime cache used by the desktop application'],
  'note.applicationLog': ['桌面应用日志，由应用自行轮转', 'Desktop application log, rotated by the application itself'],
  'note.codexLog': ['Codex 运行日志目录，由 Codex 自行轮转', 'Codex runtime log directory, rotated by Codex itself'],
  'note.logDatabase': ['Codex 诊断日志数据库（含 WAL/SHM）', 'Codex diagnostic log database (including WAL/SHM)'],
  'note.sessionProjection': ['会话内容投影数据库（含 WAL/SHM）', 'Session content projection database (including WAL/SHM)'],
  'note.localMarketplace': ['config.toml 注册的本地插件市场', 'Local marketplace registered in config.toml'],
  'note.configOrCredentials': ['配置、凭据或用户规则', 'Configuration, credentials, or user rules'],
  'note.pluginData': ['插件持久化数据', 'Persistent plugin data'],
  'note.knownMarketplaces': ['已知插件市场注册表', 'Known plugin marketplace registry'],
  'note.stateDatabase': ['Codex 状态数据库', 'Codex state database'],
  'note.browserProfile': ['浏览器配置与登录状态', 'Browser configuration and sign-in state'],
  'note.computerUseComponent': ['Computer Use 辅助组件', 'Computer Use helper component'],
  'note.builtinPlugin': ['Codex 官方内置插件', 'Official Codex built-in plugin'],
  'note.currentPlugin': ['当前使用的插件版本', 'Plugin version currently in use'],
  'note.unconfirmedPlugin': ['无法确认状态的插件版本', 'Plugin version whose status could not be confirmed'],
  'note.pluginRuntime': ['Codex 插件运行组件', 'Codex plugin runtime component'],
  'note.desktopStateLeftover': ['桌面端写入状态时留下的临时文件', 'Temporary file left behind when the desktop app wrote its state'],
  'note.skillsBackup': ['升级技能目录时留下的备份', 'Backup left behind when the skills directory was upgraded'],
  'note.releaseVersion': ['已被 current 取代的旧安装包', 'Older release superseded by the one `current` points at'],
  'note.currentRelease': ['current 指向的安装包，正在使用', 'The release `current` points at; in use'],
  'note.unconfirmedRelease': ['无法确认当前版本，已锁定', 'The current release could not be confirmed; locked'],

  'tag.builtin': ['官方内置', 'Official built-in'],
  'tag.current': ['当前版本', 'Current'],
  'tag.unconfirmed': ['未确认', 'Unverified'],
  'tag.runtime': ['运行组件', 'Runtime'],
  'tag.outdated': ['旧版本', 'Old version'],
  'tag.orphaned': ['卸载残留', 'Uninstall leftover'],
  'tag.unmanagedWorktree': ['非 Codex 创建', 'Not created by Codex'],
  'tag.orphanedWorktree': ['仓库已不在', 'Repository is gone'],

  'group.recommended': ['建议清理', 'Recommended'],
  'group.review': ['谨慎清理', 'Review'],
  'group.protectedData': ['受保护', 'Protected'],

  'location.active': ['未归档', 'Active'],
  'location.archived': ['已归档', 'Archived'],

  'pluginStatus.builtin': ['官方内置', 'Official built-in'],
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
  'stage.assets': ['会话资产', 'Session assets'],
  'stage.workspace': ['工作区', 'Workspace'],
  'stage.worktrees': ['Worktree', 'Worktrees'],
  'stage.done': ['完成', 'Done'],

  'cleanup.quitting': ['正在退出 Codex…', 'Quitting Codex…'],
  'cleanup.skipCodexRunning': ['Codex 正在运行，请退出后重新清理', 'Codex is running. Quit it and clean up again.'],
  'cleanup.skipRecentlyWritten': ['扫描后路径又有写入，请稍后重新扫描并清理', 'The path was written to after the scan. Scan again and retry.'],
  'cleanup.skipMissing': ['路径已不存在', 'The path no longer exists'],
  'cleanup.localIndexFailed': ['会话文件已处理，但本地索引清理失败：{reason}', 'Session files were handled, but clearing the local index failed: {reason}'],
  'cleanup.worktreeRemoveFailed': ['git 无法移除该 worktree：{reason}', 'git could not remove this worktree: {reason}'],
  'cleanup.worktreeNotManaged': ['不是 Codex 创建的 worktree，已跳过', 'Not a worktree created by Codex; skipped'],

  'scanNote.appServerUnavailable': ['未连接 codex app server，无法确认插件的当前版本，已全部锁定。', 'Not connected to the codex app server, so current plugin versions cannot be confirmed. All are locked.'],
  'scanNote.noSessionTitles': ['没有读到 Codex 的会话标题，列表改用会话首句或项目名显示。', 'No Codex session titles were found. The list falls back to the first message or the project name.'],

  'warning.permanent': ['清理的内容会被永久删除，无法恢复。', 'Everything cleaned is deleted permanently and cannot be recovered.'],
  'warning.permanentWorktreeGit': ['清理的内容会被永久删除，无法恢复。请确认未提交或未推送的内容已经保存。', 'Everything cleaned is deleted permanently and cannot be recovered. Make sure anything uncommitted or unpushed has been saved.'],
  'warning.pluginManagement': ['当前插件将通过 Codex 正式卸载；旧版本和卸载残留会被永久删除。', 'Current plugins will be uninstalled through Codex; old versions and uninstalled leftovers will be deleted permanently.'],
  'warning.workspaceGit': ['请确认未提交或未推送的内容已经保存。', 'Make sure anything uncommitted or unpushed has been saved.'],
  'warning.pinnedSessions': ['所选会话中有 {count} 个是置顶会话，删除后不会恢复', '{count} of the selected conversations are pinned; deleting them is permanent'],
  'warning.generatedAssetLocalCopy': ['会话会保留，但所选会话资产的本地路径将失效；依赖这些路径的打开、复制或继续编辑操作可能失败。', 'Conversations remain, but the selected session-asset paths will stop working; open, copy, or edit operations that rely on them may fail.'],
  'warning.worktreeRelatedSessions': ['同时永久删除关联会话及其会话资产', 'Also permanently delete related conversations and their session assets'],
  'warning.planOnlyCopy': ['所选 Plan 的来源会话已删除，可能是该计划的唯一副本。', 'The conversation that produced a selected Plan is already gone, so this may be its only copy.'],

  'blocker.detectionFailed': ['无法确认 Codex 是否正在运行', 'Cannot determine whether Codex is running'],
  'blocker.desktopRunning': ['ChatGPT/Codex 桌面应用或会话服务正在运行', 'The ChatGPT/Codex desktop app or its session service is running'],
  'blocker.cliRunning': ['终端里有 {count} 个 codex 进程在运行', '{count} codex processes are running in a terminal'],
  'blocker.quitHintWindows': ['Windows 请用菜单 File → Exit 退出', 'On Windows, quit via File → Exit'],

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
  'error.codexRunningForRepair': ['请先退出 ChatGPT/Codex，再清理残留会话记录', 'Quit ChatGPT/Codex before removing leftover session records'],
  'error.verbatim': ['{text}', '{text}'],

  'auto.disabled': ['定时清理未开启，跳过。', 'Scheduled cleanup is off. Skipping.'],
  'auto.nothingToClean': ['没有需要清理的项目。', 'Nothing to clean.'],
  'auto.summary': ['已释放 {bytes}，成功 {succeeded} 项，跳过 {skipped} 项，失败 {failed} 项', 'Freed {bytes}. {succeeded} succeeded, {skipped} skipped, {failed} failed.'],
  'auto.skippedItem': ['跳过：{title} — {reason}', 'Skipped: {title} — {reason}'],
  'auto.failed': ['定时清理失败：{reason}', 'Scheduled cleanup failed: {reason}'],

  'menu.file': ['文件', 'File'],
  'menu.settings': ['设置…', 'Settings…'],

  'update.title': ['发现新版本', 'Update Available'],
  'update.available': ['Clean My Codex {version} 已发布', 'Clean My Codex {version} is available'],
  'update.detail': ['是否打开下载页面？下载 DMG 后，将新应用拖入“应用程序”并选择替换即可。', 'Open the download page? After downloading the DMG, drag the new app into Applications and choose Replace.'],
  'update.detailWindows': ['是否打开下载页面？下载 Windows x64 安装程序（.exe）后运行即可。', 'Open the download page? Download and run the Windows x64 installer (.exe).'],
  'update.openRelease': ['前往下载', 'Open Download Page'],
  'update.later': ['稍后', 'Later'],
  'update.checkTitle': ['检查更新', 'Check for Updates'],
  'update.current': ['已是最新版本', 'You’re up to date'],
  'update.currentDetail': ['当前版本为 {version}。', 'You’re running version {version}.'],
  'update.unavailable': ['暂时无法获取版本信息', 'Release information is not available yet'],
  'update.unavailableDetail': ['仓库仍为 Private 或尚未发布可公开访问的 Release。', 'The repository is still private, or it does not have a publicly accessible release yet.'],
  'update.failed': ['检查更新失败', 'Couldn’t check for updates'],
  'update.failedDetail': ['请检查网络连接后重试。', 'Check your network connection and try again.'],
  'update.ok': ['好', 'OK']
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
/**
 * A message as a log should carry it: the key, not the sentence. The key does not move
 * when the wording or the reader's language does, so a report from any machine can be
 * grepped for `guard.protectedPath` and matched against the source.
 */
export function describeMessage(value: Message): string {
  const params = Object.entries(value.params ?? {})
  return params.length ? `${value.key}(${params.map(([k, v]) => `${k}=${v}`).join(', ')})` : value.key
}

export class MessageError extends Error {
  readonly info: Message
  constructor(info: Message) {
    super(encodeMessage(info))
    this.name = 'MessageError'
    this.info = info
  }
}
