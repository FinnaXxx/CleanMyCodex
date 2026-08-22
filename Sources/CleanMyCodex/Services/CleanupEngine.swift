import Foundation

/// Performs the actual cleanup. Every task passes the protected-path guard first, and
/// ordinary files are moved to the Trash so a mistake is always recoverable.
struct CleanupEngine: Sendable {
    let locations: CodexLocations
    let guards: ProtectedPaths
    let appServer: CodexAppServerClient
    /// Injectable so the deferral rules can be tested without a running Codex.
    let isCodexRunning: @Sendable () -> Bool
    /// Injectable for the same reason: asks whether one specific file is open.
    let fileUsage: @Sendable (URL) -> FileUsageProbe.Usage

    init(
        locations: CodexLocations,
        activePluginDirectories: [URL] = [],
        appServer: CodexAppServerClient? = nil,
        isCodexRunning: (@Sendable () -> Bool)? = nil,
        fileUsage: (@Sendable (URL) -> FileUsageProbe.Usage)? = nil
    ) {
        self.locations = locations
        self.guards = ProtectedPaths(locations: locations, activePluginDirectories: activePluginDirectories)
        self.appServer = appServer ?? CodexAppServerClient(codexHome: locations.home)
        self.isCodexRunning = isCodexRunning ?? { CodexRuntimeProbe.isCodexRunning() }
        let probe = FileUsageProbe()
        self.fileUsage = fileUsage ?? { probe.usage(of: $0) }
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
                outcomes.append(runTrash(task, codexRunning: codexRunning))
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
        // A live session appends to its own rollout and nothing else, so the question is
        // whether *this* file is open — not whether some Codex somewhere is running. That
        // is what lets the other sessions be slimmed while a terminal session keeps going.
        switch fileUsage(task.url) {
        case let .inUse(processes):
            return outcome(
                task,
                status: .skipped("这个会话正在被使用（\(processes.joined(separator: "、"))）"),
                freed: 0
            )
        case .unknown:
            // No way to tell; fall back to the blunt rule rather than guessing.
            if codexRunning {
                return outcome(
                    task,
                    status: .skipped("无法确认会话是否正在被写入，Codex 正在运行，本次跳过"),
                    freed: 0
                )
            }
        case .free:
            break
        }
        do {
            try guards.validate(task.url)
            let report = try SessionSlimmer().slim(task.url, mode: mode)
            return outcome(task, status: .succeeded, freed: report.freedBytes)
        } catch {
            return outcome(task, status: .failed(error.localizedDescription), freed: 0)
        }
    }

    private func runTrash(_ task: CleanupTask, codexRunning: Bool) -> CleanupOutcome {
        // Codex' own scratch space is off limits while it is up: a directory being
        // unpacked into looks exactly like an abandoned one from the outside.
        if task.requiresCodexStopped, codexRunning {
            return outcome(task, status: .skipped("Codex 正在运行，暂存目录可能正在使用"), freed: 0)
        }

        // The scan that produced this task may be minutes old. If the target was only
        // safe because nothing had written to it in a while, prove that is still true
        // before removing it — an upgrade could have started in between.
        if let required = task.minimumIdleSeconds {
            let activity = CodexStorageScanner.measure(task.url, reporter: nil, isCancelled: { false })
            if activity.latestActivity > Date(timeIntervalSinceNow: -required) {
                return outcome(
                    task,
                    status: .skipped("扫描之后又被写入过，本次不动它"),
                    freed: 0
                )
            }
        }

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
        // VACUUM needs the database to itself. A running Codex holds it open, which lsof
        // reports directly; when it cannot answer, fall back to the blunt rule.
        switch fileUsage(task.url) {
        case let .inUse(processes):
            return outcome(
                task,
                status: .skipped("数据库正在被使用（\(processes.joined(separator: "、"))）"),
                freed: 0
            )
        case .unknown:
            if codexRunning {
                return outcome(task, status: .skipped("Codex 正在运行，压缩数据库需要先完全退出 Codex"), freed: 0)
            }
        case .free:
            break
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
