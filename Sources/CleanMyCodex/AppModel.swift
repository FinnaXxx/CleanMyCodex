import Foundation

@MainActor
final class AppModel: ObservableObject {
    /// Everything lives on one page; sessions, plugins and automation open on top of it.
    enum Sheet: String, Identifiable {
        case sessions
        case plugins
        case workspace
        case automation

        var id: String { rawValue }
    }

    enum SessionScope: String, CaseIterable, Identifiable {
        case all = "全部"
        case active = "未归档"
        case archived = "已归档"

        var id: String { rawValue }
    }

    enum SessionSort: String, CaseIterable, Identifiable {
        case total = "按总占用"
        case images = "按内嵌图片"
        case date = "按最后活动"
        case name = "按名称"
        case slimmable = "按可瘦身空间"

        var id: String { rawValue }
    }

    @Published private(set) var snapshot: ScanSnapshot
    @Published private(set) var isScanning = false
    @Published private(set) var scanProgress = ScanProgress.idle
    @Published private(set) var isCleaning = false
    @Published private(set) var cleanupProgress = CleanupProgress.idle
    @Published private(set) var lastReport: CleanupReport?
    @Published private(set) var codexRunning = false
    /// Cached: answering this shells out to `ps`, which must not happen per render.
    @Published private(set) var canRestartCodex = false
    @Published private(set) var codexBlockerSummary: String?
    @Published private(set) var appServerAvailable = false
    @Published private(set) var automationStatus = "未安装"

    @Published var activeSheet: Sheet?
    @Published var errorMessage: String?
    @Published var selectedEntryIDs = Set<String>()
    @Published var selectedPluginIDs = Set<String>()
    /// Never restored from a previous scan and never preselected: workspace folders are
    /// user work product, so every one of them has to be picked by hand each time.
    @Published private(set) var selectedWorkspaceIDs = Set<String>()
    @Published var sessionDeletionMode: SessionDeletionMode = .appServer
    @Published var sessionSlimMode: SessionSlimMode = .deduplicate
    /// Opt-in: quit Codex, run the exclusive-access work, open Codex again.
    @Published var restartCodexForCleanup = false
    @Published private(set) var restartStage: String?
    @Published var automation = AutomationStore.loadSettings()
    @Published var lastAutomaticRun = AutomationStore.loadLastRun()

    // MARK: - Session browsing state
    //
    // Filtering and sorting run once per input change instead of once per SwiftUI body
    // evaluation; with thousands of sessions the latter is what makes scrolling stutter.

    @Published var sessionScope: SessionScope = .all { didSet { rebuildVisibleSessions() } }
    @Published var sessionSort: SessionSort = .total { didSet { rebuildVisibleSessions() } }
    @Published var sessionQuery = "" { didSet { rebuildVisibleSessions() } }
    @Published var sessionRetentionDays = 180 { didSet { rebuildExpiredSessions() } }
    @Published private(set) var visibleSessions: [SessionItem] = []
    @Published private(set) var expiredSessionIDs: [String] = []
    @Published private(set) var selectedSessionIDs = Set<String>()
    /// Total bytes held by repeated screenshots across every session in the snapshot.
    @Published private(set) var duplicateImageBytes: Int64 = 0

    let locations: CodexLocations
    private let scanner: CodexStorageScanner
    private let automationService = AutomationService()
    private var scanWorker: Task<ScanSnapshot, Never>?
    private var scanGeneration = 0
    private var entryIndex: [String: StorageEntry] = [:]
    private var sessionIndex: [String: SessionItem] = [:]
    private var sessionSearchIndex: [String: String] = [:]
    private var sessionCounts: [SessionScope: Int] = [:]
    private var workspaceIndex: [String: WorkspaceEntry] = [:]

    var codexHome: URL { locations.home }

    init(locations: CodexLocations = .standard(), scanner: CodexStorageScanner = CodexStorageScanner()) {
        self.locations = locations
        self.scanner = scanner
        self.snapshot = .empty(at: locations.home)
    }

    // MARK: - Scanning

    func startInitialScan() {
        guard snapshot.isEmpty, !isScanning else { return }
        scan()
    }

    func scan() {
        guard !isCleaning else { return }
        scanWorker?.cancel()
        isScanning = true
        errorMessage = nil
        scanProgress = ScanProgress(stage: "准备中", currentPath: "", scannedBytes: 0, fraction: 0)
        refreshEnvironment()

        let home = locations.home
        let scanner = scanner
        let client = CodexAppServerClient(codexHome: home)
        let worker = Task.detached(priority: .userInitiated) { [weak self] () -> ScanSnapshot in
            let plugins = client.installedPlugins()
            do {
                return try scanner.scan(codexHome: home, installedPlugins: plugins) { progress in
                    Task { @MainActor in self?.scanProgress = progress }
                }
            } catch {
                await MainActor.run { self?.errorMessage = error.localizedDescription }
                return .empty(at: home)
            }
        }
        scanWorker = worker
        scanGeneration += 1
        let generation = scanGeneration

        Task {
            let result = await worker.value
            // A newer scan already took over; its own continuation owns the state.
            guard generation == scanGeneration else { return }
            apply(result)
            isScanning = false
            scanWorker = nil
        }
    }

    func cancelScan() {
        scanWorker?.cancel()
    }

    private func apply(_ result: ScanSnapshot) {
        snapshot = result
        appServerAvailable = CodexAppServerClient(codexHome: locations.home).isAvailable
        if !appServerAvailable { sessionDeletionMode = .trash }

        entryIndex = Dictionary(
            result.categories.flatMap(\.entries).map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        sessionIndex = Dictionary(
            result.sessions.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        sessionSearchIndex = result.sessions.reduce(into: [:]) { index, item in
            index[item.id] = [
                item.displayName,
                item.projectName ?? "",
                item.workingDirectory ?? "",
                item.threadID
            ].joined(separator: " ").lowercased()
        }
        duplicateImageBytes = result.sessions.reduce(Int64(0)) { $0 + $1.duplicateImageBytes }
        sessionCounts = [
            .all: result.sessions.count,
            .active: result.sessions.filter { $0.location == .active }.count,
            .archived: result.sessions.filter { $0.location == .archived }.count
        ]

        selectedEntryIDs = Set(
            result.categoryList(in: .recommended)
                .flatMap(\.entries)
                .filter { $0.risk.isSelectable }
                .map(\.id)
        )
        selectedSessionIDs = selectedSessionIDs.intersection(sessionIndex.keys)
        selectedPluginIDs = selectedPluginIDs.intersection(Set(result.pluginVersions.map(\.id)))
        workspaceIndex = Dictionary(
            result.workspace.entries.flatMap(\.flattened).map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        selectedWorkspaceIDs.removeAll()
        rebuildVisibleSessions()
        refreshAutomationStatus()
    }

    func refreshEnvironment() {
        codexRunning = CodexRuntimeProbe.isCodexRunning()
        appServerAvailable = CodexAppServerClient(codexHome: locations.home).isAvailable
        canRestartCodex = CodexLifecycle.canQuitEverything
        let blockers = CodexLifecycle.blockers()
        codexBlockerSummary = blockers.isEmpty ? nil : blockers.map(\.summary).joined(separator: "；")
    }

    // MARK: - Selection

    var allEntries: [StorageEntry] {
        snapshot.categories.flatMap(\.entries)
    }

    var selectedEntries: [StorageEntry] {
        selectedEntryIDs.compactMap { entryIndex[$0] }.sorted { $0.reclaimableBytes > $1.reclaimableBytes }
    }

    var selectedBytes: Int64 {
        selectedEntryIDs.reduce(Int64(0)) { $0 + (entryIndex[$1]?.reclaimableBytes ?? 0) }
    }

    var selectedEntryCount: Int { selectedEntryIDs.count }

    var recommendedBytes: Int64 {
        snapshot.categoryList(in: .recommended).reduce(Int64(0)) { $0 + $1.reclaimableBytes }
    }

    func isSelected(_ entry: StorageEntry) -> Bool {
        selectedEntryIDs.contains(entry.id)
    }

    func setSelected(_ entry: StorageEntry, _ selected: Bool) {
        guard entry.risk.isSelectable else { return }
        if selected { selectedEntryIDs.insert(entry.id) } else { selectedEntryIDs.remove(entry.id) }
    }

    func selectionState(for category: StorageCategory) -> SelectionState {
        guard category.isSelectable else { return .none }
        let ids = Set(category.entries.map(\.id))
        let chosen = ids.intersection(selectedEntryIDs)
        if chosen.isEmpty { return .none }
        return chosen.count == ids.count ? .all : .partial
    }

    func setSelected(_ category: StorageCategory, _ selected: Bool) {
        guard category.isSelectable else { return }
        let ids = Set(category.entries.filter { $0.risk.isSelectable }.map(\.id))
        if selected { selectedEntryIDs.formUnion(ids) } else { selectedEntryIDs.subtract(ids) }
    }

    func setSelected(group: StorageGroup, _ selected: Bool) {
        for category in snapshot.categoryList(in: group) {
            setSelected(category, selected)
        }
    }

    // MARK: - Sessions

    func count(of scope: SessionScope) -> Int { sessionCounts[scope] ?? 0 }

    var expiredSessionCount: Int { expiredSessionIDs.count }

    func isSessionSelected(_ id: String) -> Bool { selectedSessionIDs.contains(id) }

    func setSessionSelected(_ id: String, _ selected: Bool) {
        if selected { selectedSessionIDs.insert(id) } else { selectedSessionIDs.remove(id) }
    }

    func setSessionsSelected<S: Sequence<String>>(_ ids: S, _ selected: Bool) {
        if selected { selectedSessionIDs.formUnion(ids) } else { selectedSessionIDs.subtract(ids) }
    }

    func clearSessionSelection() { selectedSessionIDs.removeAll() }

    func selectExpiredSessions() { selectedSessionIDs.formUnion(expiredSessionIDs) }

    var visibleSessionSelectionState: SelectionState {
        guard !visibleSessions.isEmpty else { return .none }
        var selected = 0
        for session in visibleSessions where selectedSessionIDs.contains(session.id) { selected += 1 }
        if selected == 0 { return .none }
        return selected == visibleSessions.count ? .all : .partial
    }

    var selectedSessions: [SessionItem] {
        selectedSessionIDs.compactMap { sessionIndex[$0] }.sorted { $0.totalBytes > $1.totalBytes }
    }

    var selectedSessionBytes: Int64 {
        selectedSessionIDs.reduce(Int64(0)) { $0 + (sessionIndex[$1]?.totalBytes ?? 0) }
    }



    /// The largest sessions, for the summary card on the main page.
    /// The snapshot already arrives sorted by total size, so this stays O(limit).
    func largestSessions(_ limit: Int) -> [SessionItem] {
        Array(snapshot.sessions.prefix(limit))
    }

    private func rebuildVisibleSessions() {
        let query = sessionQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var items = snapshot.sessions.filter { item in
            switch sessionScope {
            case .all: true
            case .active: item.location == .active
            case .archived: item.location == .archived
            }
        }
        if !query.isEmpty {
            items = items.filter { sessionSearchIndex[$0.id]?.contains(query) ?? false }
        }
        switch sessionSort {
        case .total: items.sort { $0.totalBytes > $1.totalBytes }
        case .images: items.sort { $0.embeddedImageBytes > $1.embeddedImageBytes }
        case .date: items.sort { $0.modifiedAt > $1.modifiedAt }
        case .name: items.sort { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
        case .slimmable: items.sort { $0.slimmableBytes > $1.slimmableBytes }
        }
        visibleSessions = items
        rebuildExpiredSessions()
    }

    private func rebuildExpiredSessions() {
        let cutoff = Calendar.current.date(byAdding: .day, value: -sessionRetentionDays, to: .now) ?? .distantPast
        expiredSessionIDs = visibleSessions
            .filter { $0.modifiedAt < cutoff && !$0.isUnstable }
            .map(\.id)
    }

    // MARK: - Workspace

    func isWorkspaceSelected(_ id: String) -> Bool { selectedWorkspaceIDs.contains(id) }

    /// Selecting a folder implies its children; they are inside it either way.
    func setWorkspaceSelected(_ entry: WorkspaceEntry, _ selected: Bool) {
        let ids = entry.flattened.map(\.id)
        if selected {
            selectedWorkspaceIDs.formUnion(ids)
        } else {
            selectedWorkspaceIDs.subtract(ids)
        }
    }

    func workspaceSelectionState(of entry: WorkspaceEntry) -> SelectionState {
        let ids = entry.flattened.map(\.id)
        let chosen = ids.filter { selectedWorkspaceIDs.contains($0) }
        if chosen.isEmpty { return .none }
        return chosen.count == ids.count ? .all : .partial
    }

    func clearWorkspaceSelection() { selectedWorkspaceIDs.removeAll() }

    /// Only the outermost picked folders — trashing a parent already takes its children.
    var workspaceTargets: [WorkspaceEntry] {
        let selected = selectedWorkspaceIDs.compactMap { workspaceIndex[$0] }
        let outermost = Set(ProtectedPaths.outermost(selected.map(\.url)).map(\.path))
        return selected
            .filter { outermost.contains($0.url.standardizedFileURL.path) }
            .sorted { $0.bytes > $1.bytes }
    }

    var workspaceSelectedBytes: Int64 {
        workspaceTargets.reduce(Int64(0)) { $0 + $1.bytes }
    }

    var workspaceHasUnsafeSelection: Bool {
        workspaceTargets.contains(where: \.hasUnsafeRepository)
    }

    func cleanSelectedWorkspace() {
        let tasks = workspaceTargets.map { entry in
            CleanupTask(
                id: entry.id,
                title: entry.name,
                detail: "\(entry.totalFileCount) 个文件"
                    + (entry.repositoryCount > 0 ? " · \(entry.repositoryCount) 个 git 仓库" : ""),
                url: entry.url,
                method: .trash,
                expectedBytes: entry.bytes
            )
        }
        runCleanup(tasks: tasks)
    }

    // MARK: - Plugins

    var removablePlugins: [PluginVersionItem] {
        snapshot.pluginVersions.filter { $0.status.isRemovable }
    }

    var selectedPlugins: [PluginVersionItem] {
        snapshot.pluginVersions.filter { selectedPluginIDs.contains($0.id) && $0.status.isRemovable }
    }

    // MARK: - Cleanup

    func cleanSelectedStorage() {
        runCleanup(tasks: CleanupPlanner.tasks(for: selectedEntries))
    }

    func deleteSelectedSessions() {
        runCleanup(tasks: CleanupPlanner.sessionTasks(for: selectedSessions, mode: sessionDeletionMode))
    }

    var slimTasks: [CleanupTask] {
        CleanupPlanner.slimTasks(for: selectedSessions, mode: sessionSlimMode)
    }

    var slimmableBytes: Int64 {
        slimTasks.reduce(Int64(0)) { $0 + $1.expectedBytes }
    }

    func slimSelectedSessions() {
        runCleanup(tasks: slimTasks)
    }

    func cleanSelectedPlugins() {
        let tasks = selectedPlugins.map { item in
            CleanupTask(
                id: item.id,
                title: "\(item.plugin) · \(item.version)",
                detail: item.status.label,
                url: item.directoryURL,
                method: .trash,
                expectedBytes: item.bytes
            )
        }
        runCleanup(tasks: tasks)
    }

    /// Tasks that will be deferred unless Codex is not running.
    /// Slimming is deliberately absent: it is gated on the individual rollout being in
    /// use, not on Codex as a whole, so a terminal session no longer blocks every other
    /// session from being slimmed.
    nonisolated static func requiresCodexStopped(_ tasks: [CleanupTask]) -> [CleanupTask] {
        tasks.filter { task in
            task.requiresCodexStopped || task.method == .compactDatabase
        }
    }

    func blockedTasks(in tasks: [CleanupTask]) -> [CleanupTask] {
        codexRunning ? Self.requiresCodexStopped(tasks) : []
    }

    private func runCleanup(tasks: [CleanupTask]) {
        guard !tasks.isEmpty, !isCleaning else { return }
        isCleaning = true
        cleanupProgress = CleanupProgress(completed: 0, total: tasks.count, currentTitle: "")
        lastReport = nil
        restartStage = nil

        let engine = CleanupEngine(
            locations: locations,
            activePluginDirectories: snapshot.pluginVersions
                .filter { !$0.status.isRemovable }
                .map(\.directoryURL),
            appServer: CodexAppServerClient(codexHome: locations.home)
        )

        let shouldRestart = restartCodexForCleanup
            && !Self.requiresCodexStopped(tasks).isEmpty

        Task {
            var reopen: [URL] = []
            if shouldRestart {
                restartStage = "正在退出 Codex…"
                do {
                    reopen = try await CodexLifecycle.quit()
                } catch {
                    // Never clean anyway: the whole point of quitting was to make it safe.
                    errorMessage = error.localizedDescription
                    restartStage = nil
                    isCleaning = false
                    refreshEnvironment()
                    return
                }
                restartStage = nil
            }

            let report = await Task.detached(priority: .userInitiated) { [weak self] () -> CleanupReport in
                engine.run(tasks: tasks) { progress in
                    Task { @MainActor in self?.cleanupProgress = progress }
                }
            }.value
            lastReport = report

            if !reopen.isEmpty {
                restartStage = "正在重新打开 Codex…"
                await CodexLifecycle.relaunch(reopen)
                restartStage = nil
            }

            isCleaning = false
            scan()
        }
    }

    // MARK: - Automation

    func refreshAutomationStatus() {
        if !automationService.isInstalled {
            automationStatus = "未安装"
        } else {
            automationStatus = automationService.isLoaded() ? "已安装" : "已写入，等待加载"
        }
        lastAutomaticRun = AutomationStore.loadLastRun()
    }

    func applyAutomation() {
        do {
            try AutomationStore.save(automation)
            if automation.enabled {
                try automationService.install(interval: automation.intervalSeconds)
            } else {
                try automationService.uninstall()
            }
            try automationService.setLaunchAtLogin(automation.launchAtLogin)
            refreshAutomationStatus()
        } catch {
            errorMessage = error.localizedDescription
            automation.enabled = automationService.isInstalled
            refreshAutomationStatus()
        }
    }

    var nextAutomaticRun: Date? {
        guard automation.enabled else { return nil }
        return automationService.nextRunDate(interval: automation.intervalSeconds)
    }
}

enum SelectionState {
    case none
    case partial
    case all

    var isOn: Bool { self == .all }
}
