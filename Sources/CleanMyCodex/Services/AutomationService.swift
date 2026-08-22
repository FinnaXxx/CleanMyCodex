import Foundation
import ServiceManagement

struct AutomationSettings: Codable, Sendable, Equatable {
    var enabled = false
    var intervalDays = 30
    var cleanCaches = true
    var cleanOldPlugins = true
    var cleanArchivedSessions = false
    var archivedRetentionDays = 180
    var cleanActiveSessions = false
    var activeRetentionDays = 365
    var skipRecentSessions = true
    var notifyWhenFinished = true
    var launchAtLogin = false

    var intervalSeconds: Int { max(1, intervalDays) * 86_400 }
}

struct AutomaticRunRecord: Codable, Sendable {
    var finishedAt: Date
    var freedBytes: Int64
    var succeeded: Int
    var failed: Int
    /// Set when the whole pass did nothing. Individual items that had to wait are
    /// reported in `deferredNote` instead — the pass itself still ran.
    var skippedReason: String?
    /// Optional so records written by older versions still decode.
    var deferred: Int?
    var deferredNote: String?
}

enum AutomationStore {
    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/CleanMyCodex", directoryHint: .isDirectory)
    }

    static var settingsURL: URL { directory.appending(path: "automation.json") }
    static var lastRunURL: URL { directory.appending(path: "last-run.json") }
    static var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Logs/CleanMyCodex/autoclean.log")
    }

    static func loadSettings() -> AutomationSettings {
        guard
            let data = try? Data(contentsOf: settingsURL),
            let settings = try? JSONDecoder().decode(AutomationSettings.self, from: data)
        else { return AutomationSettings() }
        return settings
    }

    static func save(_ settings: AutomationSettings) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(settings).write(to: settingsURL, options: .atomic)
    }

    static func loadLastRun() -> AutomaticRunRecord? {
        guard let data = try? Data(contentsOf: lastRunURL) else { return nil }
        return try? JSONDecoder().decode(AutomaticRunRecord.self, from: data)
    }

    static func save(_ record: AutomaticRunRecord) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(record) else { return }
        try? data.write(to: lastRunURL, options: .atomic)
    }

    static func appendLog(_ line: String) {
        let manager = FileManager.default
        try? manager.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let stamped = "[\(ISO8601DateFormatter().string(from: .now))] \(line)\n"
        guard let data = stamped.data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: logURL) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: logURL, options: .atomic)
        }
    }
}

enum AutomationError: LocalizedError {
    case missingExecutable
    case launchctlFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingExecutable: "找不到 CleanMyCodex 的可执行文件，请从 .app 中启动"
        case let .launchctlFailed(message): "launchctl 失败：\(message)"
        }
    }
}

/// Installs a user LaunchAgent that runs the app in `--auto-clean` mode on a schedule.
struct AutomationService: Sendable {
    static let label = "com.finnaxxx.clean-my-codex.autoclean"

    var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/LaunchAgents/\(Self.label).plist")
    }

    var isInstalled: Bool {
        FileManager.default.fileExists(atPath: plistURL.path)
    }

    var executableURL: URL? {
        if let bundled = Bundle.main.executableURL, FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        let argument = CommandLine.arguments.first ?? ""
        let url = URL(fileURLWithPath: argument).standardizedFileURL
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    func install(interval seconds: Int) throws {
        guard let executableURL else { throw AutomationError.missingExecutable }
        let plist: [String: Any] = [
            "Label": Self.label,
            "ProgramArguments": [executableURL.path, "--auto-clean"],
            "StartInterval": max(3_600, seconds),
            "RunAtLoad": false,
            "ProcessType": "Background",
            "StandardOutPath": AutomationStore.logURL.path,
            "StandardErrorPath": AutomationStore.logURL.path
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try FileManager.default.createDirectory(
            at: plistURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: AutomationStore.logURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: plistURL, options: .atomic)

        _ = runLaunchctl(["bootout", "gui/\(getuid())/\(Self.label)"])
        let bootstrap = runLaunchctl(["bootstrap", "gui/\(getuid())", plistURL.path])
        guard bootstrap.status == 0 else {
            throw AutomationError.launchctlFailed(bootstrap.output)
        }
    }

    func uninstall() throws {
        _ = runLaunchctl(["bootout", "gui/\(getuid())/\(Self.label)"])
        if FileManager.default.fileExists(atPath: plistURL.path) {
            try FileManager.default.removeItem(at: plistURL)
        }
    }

    func isLoaded() -> Bool {
        runLaunchctl(["print", "gui/\(getuid())/\(Self.label)"]).status == 0
    }

    func nextRunDate(interval seconds: Int) -> Date? {
        guard isInstalled else { return nil }
        let reference = (try? plistURL.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
            ?? Date()
        return reference.addingTimeInterval(TimeInterval(max(3_600, seconds)))
    }

    func setLaunchAtLogin(_ enabled: Bool) throws {
        let service = SMAppService.mainApp
        if enabled {
            if service.status != .enabled { try service.register() }
        } else {
            if service.status == .enabled { try service.unregister() }
        }
    }

    var launchAtLoginEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    private func runLaunchctl(_ arguments: [String]) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
        } catch {
            return (-1, error.localizedDescription)
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
