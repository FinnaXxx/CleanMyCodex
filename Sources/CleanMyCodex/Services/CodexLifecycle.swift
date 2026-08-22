import AppKit
import Foundation

/// Closes the Codex desktop app so the exclusive-access work can run, and opens it again
/// afterwards.
///
/// Only the desktop app is ever closed, and only by asking it to quit the way ⌘Q does —
/// nothing is force-killed. A `codex` session running in a terminal is never touched: it
/// may be mid-task, and there is no way to ask a terminal process to save and exit.
@MainActor
enum CodexLifecycle {
    enum Blocker: Equatable {
        case desktopApp(names: [String])
        case commandLine(commands: [String])

        var summary: String {
            switch self {
            case let .desktopApp(names):
                "Codex 应用正在运行（\(names.joined(separator: "、"))）"
            case let .commandLine(commands):
                "终端里有 \(commands.count) 个 codex 进程在运行"
            }
        }
    }

    enum RestartError: LocalizedError {
        case refusedToQuit([String])
        case commandLineRunning([String])

        var errorDescription: String? {
            switch self {
            case let .refusedToQuit(names):
                "没能退出 \(names.joined(separator: "、"))，可能有未保存的内容。请手动退出后重试。"
            case let .commandLineRunning(commands):
                "终端里还有 codex 在运行（\(commands.count) 个），"
                    + "这类进程可能正在执行任务，不会被自动结束。请先自行退出。"
            }
        }
    }

    /// What is currently keeping the exclusive-access work from running.
    static func blockers() -> [Blocker] {
        var result: [Blocker] = []
        let apps = codexApplications()
        if !apps.isEmpty {
            result.append(.desktopApp(names: apps.map { $0.localizedName ?? "Codex" }))
        }
        let commands = CodexRuntimeProbe.runningCLICommands()
        if !commands.isEmpty {
            result.append(.commandLine(commands: commands))
        }
        return result
    }

    /// True when everything in the way is something we can politely close.
    static var canQuitEverything: Bool {
        CodexRuntimeProbe.runningCLICommands().isEmpty && !codexApplications().isEmpty
    }

    /// Asks the Codex apps to quit and waits for them to go.
    /// Returns the bundles to reopen afterwards, in the order they were closed.
    static func quit(timeout: TimeInterval = 20) async throws -> [URL] {
        let commands = CodexRuntimeProbe.runningCLICommands()
        guard commands.isEmpty else { throw RestartError.commandLineRunning(commands) }

        let apps = codexApplications()
        guard !apps.isEmpty else { return [] }

        let bundles = apps.compactMap(\.bundleURL)
        for app in apps { app.terminate() }

        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if codexApplications().isEmpty { return bundles }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }

        let stubborn = codexApplications().map { $0.localizedName ?? "Codex" }
        // Never escalate to a force kill: a refusal usually means an unsaved prompt.
        throw RestartError.refusedToQuit(stubborn)
    }

    static func relaunch(_ bundles: [URL]) async {
        for bundle in bundles {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = false
            _ = try? await NSWorkspace.shared.openApplication(at: bundle, configuration: configuration)
        }
    }

    private static func codexApplications() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter { application in
            guard let identifier = application.bundleIdentifier else { return false }
            return CodexRuntimeProbe.bundleIdentifiers.contains(identifier)
        }
    }
}
