import AppKit
import Foundation

/// Compaction and plugin removal are only safe while Codex is not holding the files open.
struct CodexRuntimeProbe: Sendable {
    static let bundleIdentifiers = ["com.openai.codex", "com.openai.chat"]

    @MainActor
    static func isDesktopAppRunning() -> Bool {
        NSWorkspace.shared.runningApplications.contains { application in
            guard let identifier = application.bundleIdentifier else { return false }
            return bundleIdentifiers.contains(identifier)
        }
    }

    /// Works from background work too, and also catches a bare `codex` CLI session.
    static func isCodexRunning() -> Bool {
        runningCommands().contains(where: isCodexCommand)
    }

    /// Terminal sessions only. These hold work in flight that no quit request can save,
    /// so the app offers to close the desktop app but never these.
    static func runningCLICommands() -> [String] {
        cliCommands(from: runningCommands())
    }

    static func cliCommands(from commands: [String]) -> [String] {
        commands.filter { command in
            guard isCodexCommand(command) else { return false }
            return !command.contains("Codex.app/Contents/MacOS")
        }
    }

    static func isCodexCommand(_ command: String) -> Bool {
        guard let executable = command.split(separator: " ").first else { return false }
        if executable == "codex" || executable.hasSuffix("/codex") { return true }
        return command.contains("Codex.app/Contents/MacOS")
    }

    private static func runningCommands() -> [String] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-Ao", "command="]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return []
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
            .split(separator: "\n")
            .map(String.init)
    }
}
