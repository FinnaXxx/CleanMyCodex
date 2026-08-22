import Foundation

/// Performs the actual cleanup. Every task passes the protected-path guard first, and
/// ordinary files are moved to the Trash so a mistake is always recoverable.
struct CleanupEngine: Sendable {
    let locations: CodexLocations
    let guards: ProtectedPaths
    let appServer: CodexAppServerClient
    /// Injectable so the deferral rules can be tested without a running Codex.
    let isCodexRunning: @Sendable () -> Bool

    init(
        locations: CodexLocations,
        activePluginDirectories: [URL] = [],
        appServer: CodexAppServerClient? = nil,
        isCodexRunning: (@Sendable () -> Bool)? = nil
    ) {
        self.locations = locations
        self.guards = ProtectedPaths(locations: locations, activePluginDirectories: activePluginDirectories)
        self.appServer = appServer ?? CodexAppServerClient(codexHome: locations.home)
        self.isCodexRunning = isCodexRunning ?? { CodexRuntimeProbe.isCodexRunning() }
    }

    func run(
        tasks: [CleanupTask],
        progress: @Sendable (CleanupProgress) -> Void = { _ in }
    ) -> CleanupReport {
        let startedAt = Date()
        var outcomes: [CleanupOutcome] = []
        var session: CodexAppServerSession?
        defer { session?.close() }

// Checked once for the whole batch: only the operations that need exclusive
        // access to a file care, everything else runs regardless.
        let codexRunning = isCodexRunning()

        for (index, task) in tasks.enumerated() {
            progress(CleanupProgress(completed: index, total: tasks.count, currentTitle: task.title))
            switch task.method {
            case .trash:
                outcomes.append(runTrash(task))
            case .compactDatabase:
                outcomes.append(runCompaction(task, codexRunning: codexRunning))
            case .deleteThread:
                if session == nil {
                    session = try? appServer.openSession()
                }
                outcomes.append(runThreadDeletion(task, session: session))
            case .slimSession:
                outcomes.append(runSlim(task, codexRunning: codexRunning))
            }
        }

        progress(CleanupProgress(completed: tasks.count, total: tasks.count, currentTitle: ""))
        return CleanupReport(startedAt: startedAt, finishedAt: Date(), outcomes: outcomes)
    }

    // MARK: - Individual methods

    /// Editing a rollout Codex might be appending to would corrupt it, so this one is
    /// refused outright while Codex is running rather than merely skipped per file.
    private func runSlim(_ task: CleanupTask, codexRunning: Bool) -> CleanupOutcome {
        guard let mode = task.slimMode else {
            return outcome(task, status: .failed("没有指定瘦身方式"), freed: 0)
        }
        guard !codexRunning else {
            return outcome(task, status: .skipped("Codex 正在运行，改写会话文件不安全"), freed: 0)
        }
        do {
            try guards.validate(task.url)
            let report = try SessionSlimmer().slim(task.url, mode: mode)
            return outcome(task, status: .succeeded, freed: report.freedBytes)
        } catch {
            return outcome(task, status: .failed(error.localizedDescription), freed: 0)
        }
    }

    private func runTrash(_ task: CleanupTask) -> CleanupOutcome {
        var freed: Int64 = 0
        for url in [task.url] + task.companionURLs {
            switch trash(url) {
            case let .success(bytes):
                freed += bytes
            case let .failure(error):
                return outcome(task, status: .failed(error.localizedDescription), freed: freed)
            case .notFound:
                continue
            }
        }
        guard freed > 0 else {
            return outcome(task, status: .skipped("路径已不存在"), freed: 0)
        }
        return outcome(task, status: .succeeded, freed: freed)
    }

    private func runCompaction(_ task: CleanupTask, codexRunning: Bool) -> CleanupOutcome {
        guard !codexRunning else {
            return outcome(task, status: .skipped("Codex 正在运行，压缩数据库需要先完全退出 Codex"), freed: 0)
        }
        do {
            try guards.validate(task.url)
            let report = try SQLiteMaintenance().compact(task.url)
            return outcome(task, status: .succeeded, freed: report.freedBytes)
        } catch {
            return outcome(task, status: .failed(error.localizedDescription), freed: 0)
        }
    }

    private func runThreadDeletion(_ task: CleanupTask, session: CodexAppServerSession?) -> CleanupOutcome {
        guard let threadID = task.threadID else {
            return outcome(task, status: .failed("缺少会话 ID"), freed: 0)
        }
        guard let session else {
            return outcome(task, status: .failed(AppServerError.executableNotFound.localizedDescription), freed: 0)
        }

        let targets = [task.url] + task.companionURLs
        let before = targets.reduce(Int64(0)) { $0 + footprint(of: $1) }
        do {
            try session.deleteThread(id: threadID)
        } catch {
            return outcome(task, status: .failed(error.localizedDescription), freed: 0)
        }

        let after = targets.reduce(Int64(0)) { $0 + footprint(of: $1) }
        // The app server also removes derived assets; anything it left behind goes to the Trash.
        var freed = before - after
        if FileManager.default.fileExists(atPath: task.url.path) {
            for url in targets {
                if case let .success(bytes) = trash(url) { freed += bytes }
            }
        }
        return outcome(task, status: .succeeded, freed: max(0, freed))
    }

    // MARK: - Helpers

    private enum TrashResult {
        case success(Int64)
        case failure(Error)
        case notFound
    }

    private func trash(_ url: URL) -> TrashResult {
        let manager = FileManager.default
        guard manager.fileExists(atPath: url.path) else { return .notFound }
        do {
            try guards.validate(url)
        } catch {
            return .failure(error)
        }
        let bytes = footprint(of: url)
        do {
            try manager.trashItem(at: url, resultingItemURL: nil)
            return .success(bytes)
        } catch {
            return .failure(error)
        }
    }

    private func footprint(of url: URL) -> Int64 {
        CodexStorageScanner().directorySize(url, reporter: nil)
    }

    private func outcome(_ task: CleanupTask, status: CleanupStatus, freed: Int64) -> CleanupOutcome {
        CleanupOutcome(
            id: task.id,
            title: task.title,
            detail: task.detail,
            method: task.method,
            status: status,
            freedBytes: freed
        )
    }
}
