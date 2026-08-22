import Foundation
import UserNotifications

/// Entry point for the LaunchAgent. Runs one cleanup pass without any UI and exits.
enum AutomaticCleanupRunner {
    @discardableResult
    static func run() -> Int32 {
        let settings = AutomationStore.loadSettings()
        guard settings.enabled else {
            AutomationStore.appendLog("自动清理未开启，跳过。")
            return 0
        }
        // Codex running is not a reason to skip the pass. Caches, temporary directories,
        // old plugin versions and expired sessions are all safe to clean while it runs;
        // only the operations that need exclusive access to a file defer themselves, and
        // the engine decides that per task.
        if CodexRuntimeProbe.isCodexRunning() {
            AutomationStore.appendLog("Codex 正在运行：照常清理，需要独占文件的项目会推迟到下一次。")
        }

        let home = CodexLocations.resolveHome()
        let locations = CodexLocations(home: home)
        let client = CodexAppServerClient(codexHome: home)
        let installedPlugins = client.installedPlugins()

        do {
            let snapshot = try CodexStorageScanner().scan(codexHome: home, installedPlugins: installedPlugins)
            let activePlugins = snapshot.pluginVersions
                .filter { $0.status == .current || $0.status == .unconfirmed }
                .map(\.directoryURL)
            let tasks = CleanupPlanner.automaticTasks(
                in: snapshot,
                settings: settings,
                sessionMode: client.isAvailable ? .appServer : .trash
            )
            guard !tasks.isEmpty else {
                AutomationStore.appendLog("没有需要清理的项目。")
                return 0
            }

            let engine = CleanupEngine(
                locations: locations,
                activePluginDirectories: activePlugins,
                appServer: client
            )
            let report = engine.run(tasks: tasks)
            let deferred = report.outcomes.filter { outcome in
                if case .skipped = outcome.status { return true }
                return false
            }
            let failures = report.problems.count - deferred.count
            AutomationStore.appendLog(
                "完成：\(report.summary)，成功 \(report.succeeded.count) 项，"
                    + "推迟 \(deferred.count) 项，失败 \(max(0, failures)) 项。"
            )
            for outcome in deferred {
                AutomationStore.appendLog("  推迟：\(outcome.title) — \(outcome.status.message ?? "")")
            }
            AutomationStore.save(
                AutomaticRunRecord(
                    finishedAt: .now,
                    freedBytes: report.freedBytes,
                    succeeded: report.succeeded.count,
                    failed: max(0, failures),
                    skippedReason: nil,
                    deferred: deferred.count,
                    deferredNote: deferred.first?.status.message
                )
            )
            if settings.notifyWhenFinished {
                CleanupNotifier.post(title: "CleanMyCodex", body: report.summary)
            }
            return 0
        } catch {
            AutomationStore.appendLog("扫描失败：\(error.localizedDescription)")
            return 1
        }
    }
}

enum CleanupNotifier {
    /// Best effort: only meaningful when running from inside the .app bundle.
    static func post(title: String, body: String) {
        guard Bundle.main.bundlePath.hasSuffix(".app"), Bundle.main.bundleIdentifier != nil else { return }
        let done = DispatchSemaphore(value: 0)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else {
                done.signal()
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            let request = UNNotificationRequest(
                identifier: UUID().uuidString,
                content: content,
                trigger: nil
            )
            UNUserNotificationCenter.current().add(request) { _ in done.signal() }
        }
        _ = done.wait(timeout: .now() + 5)
    }
}
