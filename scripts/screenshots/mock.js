/* Demo data for the README screenshots: shaped like a real scan, no real user data. */
(function () {
  const KiB = 1024, MiB = 1024 * KiB, GiB = 1024 * MiB
  const params = new URLSearchParams(location.search)
  const language = params.get('lang') === 'en' ? 'en' : 'zh-CN'
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
  localStorage.setItem('cleanmycodex.language', language)
  localStorage.setItem('cleanmycodex.theme', theme)

  const HOME = '/Users/alex/.codex'
  const entry = (id, title, bytes, options = {}) => ({
    id,
    title,
    note: options.note ? { key: options.note } : null,
    tags: (options.tags ?? []).map((t) => ({ label: { key: t[0] }, tone: t[1] })),
    url: options.url ?? `${HOME}/${title}`,
    bytes,
    reclaimableBytes: options.risk === 'shielded' ? 0 : (options.reclaimable ?? bytes),
    minimumIdleSeconds: options.idle ?? null,
    requiresCodexStopped: !!options.stopped,
    risk: options.risk ?? 'safe'
  })

  const categories = [
    { kind: 'temporary', group: 'recommended', risk: 'safe', entries: [
      entry('staging-1', '.staging-8f2c1d', 143 * MiB, { note: 'note.marketplaceStaging', idle: 86400, url: `${HOME}/.tmp/bundled-marketplaces/.staging-8f2c1d` }),
      entry('staging-2', '.staging-4a90be', 61 * MiB, { note: 'note.installLeftover', idle: 86400, url: `${HOME}/.tmp/.staging-4a90be` })
    ] },
    { kind: 'appLogs', group: 'review', risk: 'safe', entries: [
      entry('log-1', 'codex-2026-07-02.log', 46 * MiB, { note: 'note.oldAppLog' }),
      entry('log-2', 'codex-2026-06-28.log', 38 * MiB, { note: 'note.oldAppLog' }),
      entry('log-3', 'codex-2026-06-21.log', 21 * MiB, { note: 'note.oldAppLog' })
    ] },
    { kind: 'logDatabase', group: 'protectedData', risk: 'shielded', entries: [
      entry('log-db', 'log.sqlite', 268 * MiB, { note: 'note.logDatabase', risk: 'shielded' })
    ] },
    { kind: 'sessionDatabase', group: 'protectedData', risk: 'shielded', entries: [
      entry('thread-history', 'thread_history_v3.sqlite', 1.24 * GiB, { note: 'note.sessionProjection', risk: 'shielded' })
    ] },
    { kind: 'pluginRemnants', group: 'recommended', risk: 'safe', entries: [
      entry('plugin-old-1', 'code-review · 0.4.2', 214 * MiB, { tags: [['tag.outdated', 'neutral']], stopped: true, url: `${HOME}/plugins/code-review/0.4.2` }),
      entry('plugin-old-2', 'browser-tools · 1.2.0', 168 * MiB, { tags: [['tag.outdated', 'neutral']], stopped: true, url: `${HOME}/plugins/browser-tools/1.2.0` }),
      entry('plugin-old-3', 'deep-research · 0.9.1', 96 * MiB, { tags: [['tag.outdated', 'neutral']], stopped: true, url: `${HOME}/plugins/deep-research/0.9.1` })
    ] },
    { kind: 'pluginOrphans', group: 'review', risk: 'caution', entries: [
      entry('plugin-orphan', 'sql-explorer · 0.3.0', 74 * MiB, { tags: [['tag.orphaned', 'caution']], risk: 'caution', stopped: true, url: `${HOME}/plugins/sql-explorer/0.3.0` })
    ] },
    { kind: 'pluginRuntime', group: 'protectedData', risk: 'shielded', entries: [
      entry('plugin-current', 'code-review · 0.5.1', 236 * MiB, { note: 'note.currentPlugin', tags: [['tag.current', 'neutral']], risk: 'shielded', url: `${HOME}/plugins/code-review/0.5.1` }),
      entry('plugin-appserver', '.plugin-appserver', 384 * MiB, { note: 'note.pluginRuntime', tags: [['tag.runtime', 'info']], risk: 'shielded', url: `${HOME}/.plugin-appserver` })
    ] },
    { kind: 'codexCache', group: 'review', risk: 'rebuildable', entries: [
      entry('remote-plugin-catalog', 'remote_plugin_catalog', 196 * MiB, { note: 'note.remotePluginCatalogCache', risk: 'rebuildable', stopped: true, url: `${HOME}/cache/remote_plugin_catalog` }),
      entry('codex-apps-tools', 'codex_apps_tools', 42 * MiB, { note: 'note.codexAppsToolsCache', risk: 'rebuildable', stopped: true, url: `${HOME}/cache/codex_apps_tools` }),
      entry('codex-app-directory', 'codex_app_directory', 28 * MiB, { note: 'note.codexAppDirectoryCache', risk: 'rebuildable', stopped: true, url: `${HOME}/cache/codex_app_directory` }),
      entry('codex-apps-server-info', 'codex_apps_server_info', 2 * MiB, { note: 'note.codexAppsServerInfoCache', risk: 'rebuildable', stopped: true, url: `${HOME}/cache/codex_apps_server_info` })
    ] },
    { kind: 'appCache', group: 'protectedData', risk: 'shielded', entries: [
      entry('app-cache-1', 'Codex', 1.62 * GiB, { note: 'note.platformCache', risk: 'shielded', url: '~/Library/Caches/Codex' }),
      entry('app-cache-2', 'com.openai.codex', 412 * MiB, { note: 'note.platformCache', risk: 'shielded', url: '~/Library/Caches/com.openai.codex' })
    ] },
    { kind: 'protectedConfig', group: 'protectedData', risk: 'shielded', entries: [
      entry('state-db', 'state_v2.sqlite', 184 * MiB, { note: 'note.stateDatabase', risk: 'shielded' }),
      entry('auth', 'auth.json', 12 * KiB, { note: 'note.configOrCredentials', risk: 'shielded' }),
      entry('config', 'config.toml', 6 * KiB, { note: 'note.configOrCredentials', risk: 'shielded' })
    ] },
    { kind: 'protectedUserData', group: 'protectedData', risk: 'shielded', entries: [
      entry('browser-profile', 'browser/Default', 118 * MiB, { note: 'note.browserProfile', risk: 'shielded' })
    ] }
  ]

  const day = 86400000
  const now = Date.parse('2026-07-14T15:24:00')
  const sessionTitles = {
    'zh-CN': ['重构扫描器的并发预算', '给发布流程加签名校验', '排查 SQLite 写锁超时', '整理插件市场缓存策略', '设计定时清理的跳过规则',
      '把会话删除写进清理日志', '优化首屏扫描进度条', 'Electron 窗口主题联动', '补齐 IPC 类型定义', '梳理子代理会话归属',
      '工作产出目录的 git 检查', '统一两种语言的文案表'],
    en: ['Rework the scanner concurrency budget', 'Add signature checks to the release flow', 'Debug the SQLite write-lock timeout',
      'Revisit the marketplace cache policy', 'Design skip rules for scheduled cleanup', 'Log every session deletion',
      'Smooth out the first-scan progress bar', 'Keep the Electron window theme in step', 'Fill in the missing IPC types',
      'Group subagent threads under their parent', 'Git checks for workspace output', 'Unify the two-language message table']
  }
  const sessionSizes = [412, 386, 344, 298, 271, 244, 226, 198, 176, 154, 132, 118]
  const sessions = sessionSizes.map((mb, index) => ({
    id: `session-${index}`,
    threadID: `01j${index}k4m8x9p2q7r5s3t6u8v0w`,
    fileURL: `${HOME}/sessions/2026/07/rollout-01j${index}k4m8.jsonl`,
    segmentURLs: [],
    location: index > 8 ? 'archived' : 'active',
    modifiedAt: now - index * day * 1.7,
    fileBytes: mb * MiB * 0.82,
    assetBytes: mb * MiB * 0.18,
    assetURLs: [],
    workingDirectory: `/Users/alex/Developer/${['cleanmycodex', 'atlas-api', 'ledger-web', 'infra'][index % 4]}`,
    title: sessionTitles[language][index],
    preview: null,
    tags: index % 5 === 0 ? ['browser'] : [],
    isCompressed: false,
    isUnstable: false,
    parseWarnings: 0,
    blocksAutomaticCleanup: index === 0,
    isPinned: index === 0,
    isSubagent: false,
    parentThreadID: null,
    childThreadCount: index % 4 === 0 ? 2 : 0,
    childBytes: index % 4 === 0 ? 64 * MiB : 0,
    childURLs: []
  }))

  const generatedAssets = sessions.map((session, index) => ({
    id: `${HOME}/${index % 2 === 0 ? 'generated_images' : 'visualizations/2026/07/14'}/${session.threadID}`,
    kind: index % 2 === 0 ? 'imageGen' : 'visualization',
    path: `${HOME}/${index % 2 === 0 ? 'generated_images' : 'visualizations/2026/07/14'}/${session.threadID}`,
    companionPaths: index % 2 === 0 ? [] : [`${HOME}/visualization-viewers/${session.threadID}`],
    bytes: session.assetBytes,
    fileCount: 1 + index % 4,
    formats: index % 2 === 0 ? ['png'] : ['html', 'png'],
    modifiedAt: session.modifiedAt,
    sourceThreadID: session.threadID,
    sourceSessionID: session.id
  }))

  const folder = (id, name, path, bytes, fileCount, dayOffset, repositories = [], children = []) => ({
    id, path, name, bytes, fileCount,
    modifiedAt: now - dayOffset * day,
    repositories, sourceThreads: [], looseFiles: [], children
  })
  const workspace = {
    root: '/Users/alex/Developer/codex-workspace',
    isScanned: true,
    entries: [
      folder('ws-1', '2026-07-12', '/Users/alex/Developer/codex-workspace/2026/07/12', 642 * MiB, 318, 2,
        [{ id: 'r1', path: '/Users/alex/Developer/codex-workspace/2026/07/12/report-site', name: 'report-site', state: 'dirty' }]),
      folder('ws-2', '2026-07-08', '/Users/alex/Developer/codex-workspace/2026/07/08', 486 * MiB, 204, 6,
        [{ id: 'r2', path: '/Users/alex/Developer/codex-workspace/2026/07/08/scraper', name: 'scraper', state: 'clean' }]),
      folder('ws-3', '2026-06-30', '/Users/alex/Developer/codex-workspace/2026/06/30', 358 * MiB, 176, 14),
      folder('ws-4', '2026-06-22', '/Users/alex/Developer/codex-workspace/2026/06/22', 274 * MiB, 141, 22),
      folder('ws-5', '2026-06-11', '/Users/alex/Developer/codex-workspace/2026/06/11', 186 * MiB, 96, 33)
    ]
  }

  const categoryBytes = (c) => c.entries.reduce((sum, e) => sum + e.bytes, 0)
  const sessionBytes = sessions.reduce((sum, s) => sum + s.fileBytes + s.assetBytes + s.childBytes, 0)
  const classified = sessionBytes + categories.reduce((sum, c) => sum + categoryBytes(c), 0)

  const snapshot = {
    codexHome: HOME,
    codexHomeExists: true,
    scannedAt: now,
    totalCodexBytes: classified + 318 * MiB,
    externalBytes: 0,
    categories,
    sessions,
    generatedAssets,
    workspace,
    pluginVersions: [],
    notes: []
  }

  const noop = () => () => {}
  window.cleanmycodex = {
    platform: 'darwin',
    appInfo: async () => ({ version: '0.1.2', platform: 'darwin', appServerAvailable: true, codexBinaryAvailable: true, codexRunning: false, blockers: [] }),
    scan: async () => snapshot,
    cancelScan: async () => {},
    onScanProgress: noop,
    prepareCleanup: async () => ({ selection: { kind: 'storage', ids: [] }, items: [], expectedBytes: 0, blockedTitles: [], codexRunning: false, canQuitCodex: false, blockers: [], warnings: [] }),
    cleanup: async () => ({ startedAt: now, finishedAt: now, outcomes: [] }),
    scanWorkspace: async () => workspace,
    sessionLeftovers: async () => ({ count: 0, logPath: '' }),
    repairSessionLeftovers: async () => ({ threads: 0, removedRows: 0 }),
    revealPath: async () => {},
    openPath: async () => {},
    getAutomation: async () => ({ settings: {}, installed: false, loaded: true, nextRunAt: null, lastRun: null, supported: true }),
    saveAutomation: async (s) => ({ settings: s, installed: true, loaded: true, nextRunAt: null, lastRun: null, supported: true }),
    saveLanguage: async () => {},
    applyWindowTheme: async () => {},
    onCleanupProgress: noop,
    onOpenSettings: noop,
    onCleanupStage: noop
  }
})()
