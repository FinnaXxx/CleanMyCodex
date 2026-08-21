import Foundation

@MainActor
final class AppModel: ObservableObject {
    enum Page: String, CaseIterable, Identifiable {
        case overview = "空间扫描"
        case sessions = "会话清理"
        case plugins = "插件版本"
        case automation = "自动清理"

        var id: String { rawValue }

        var symbol: String {
            switch self {
            case .overview: "wand.and.stars"
            case .sessions: "bubble.left.and.bubble.right"
            case .plugins: "puzzlepiece.extension"
            case .automation: "calendar.badge.clock"
            }
        }
    }

    @Published private(set) var snapshot: ScanSnapshot
    @Published private(set) var isScanning = false
    @Published private(set) var scanProgress = ScanProgress.idle
    @Published private(set) var isCleaning = false
    @Published private(set) var cleanupProgress = CleanupProgress.idle
    @Published private(set) var lastReport: CleanupReport?
    @Published private(set) var codexRunning = false
    @Published private(set) var appServerAvailable = false
    @Published private(set) var automationStatus = "未安装"

    @Published var page: Page = .overview
    @Published var errorMessage: String?
    @Published var selectedEntryIDs = Set<String>()
    @Published var selectedSessionIDs = Set<String>()
    @Published var selectedPluginIDs = Set<String>()
    @Published var sessionDeletionMode: SessionDeletionMode = .appServer
    @Published var automation = AutomationStore.loadSettings()
    @Published var lastAutomaticRun = AutomationStore.loadLastRun()

    let locations: CodexLocations
    private let scanner: CodexStorageScanner
    private let automationService = AutomationService()
    private var scanWorker: Task<ScanSnapshot, Never>?
    private var scanGeneration = 0

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
        selectedEntryIDs = Set(
            result.categoryList(in: .recommended)
                .flatMap(\.entries)
                .filter { $0.risk.isSelectable }
                .map(\.id)
        )
        selectedSessionIDs = selectedSessionIDs.intersection(Set(result.sessions.map(\.id)))
        selectedPluginIDs = selectedPluginIDs.intersection(Set(result.pluginVersions.map(\.id)))
        refreshAutomationStatus()
    }

    func refreshEnvironment() {
        codexRunning = CodexRuntimeProbe.isDesktopAppRunning()
        appServerAvailable = CodexAppServerClient(codexHome: locations.home).isAvailable
    }

    // MARK: - Selection

    var allEntries: [StorageEntry] {
        snapshot.categories.flatMap(\.entries)
    }

    var selectedEntries: [StorageEntry] {
        allEntries.filter { selectedEntryIDs.contains($0.id) }
    }

    var selectedBytes: Int64 {
        selectedEntries.reduce(Int64(0)) { $0 + $1.reclaimableBytes }
    }

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

    var selectedSessions: [SessionItem] {
        snapshot.sessions.filter { selectedSessionIDs.contains($0.id) }
    }

    var selectedSessionBytes: Int64 {
        selectedSessions.reduce(Int64(0)) { $0 + $1.totalBytes }
    }

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

    private func runCleanup(tasks: [CleanupTask]) {
        guard !tasks.isEmpty, !isCleaning else { return }
        isCleaning = true
        cleanupProgress = CleanupProgress(completed: 0, total: tasks.count, currentTitle: "")
        lastReport = nil

        let engine = CleanupEngine(
            locations: locations,
            activePluginDirectories: snapshot.pluginVersions
                .filter { !$0.status.isRemovable }
                .map(\.directoryURL),
            appServer: CodexAppServerClient(codexHome: locations.home)
        )

        Task {
            let report = await Task.detached(priority: .userInitiated) { [weak self] () -> CleanupReport in
                engine.run(tasks: tasks) { progress in
                    Task { @MainActor in self?.cleanupProgress = progress }
                }
            }.value
            lastReport = report
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
