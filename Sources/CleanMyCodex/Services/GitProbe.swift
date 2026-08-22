import Foundation

/// Asks git whether a checkout holds work that only exists locally.
///
/// Workspace folders contain cloned repositories. A clone that is clean and pushed can be
/// recreated from its remote; one with uncommitted changes or unpushed commits cannot, and
/// deleting it would lose work the user may not know is there. When git is unavailable the
/// answer is `unknown`, which the UI treats as "not safe", never as "fine to delete".
struct GitProbe: Sendable {
    let executableURL: URL?
    let timeout: TimeInterval

    init(executableURL: URL? = nil, timeout: TimeInterval = 5) {
        self.executableURL = executableURL ?? Self.locate()
        self.timeout = timeout
    }

    static func locate(manager: FileManager = FileManager()) -> URL? {
        ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
            .map { URL(fileURLWithPath: $0) }
            .first { manager.isExecutableFile(atPath: $0.path) }
    }

    func state(of repository: URL) -> WorkspaceRepository.State {
        guard executableURL != nil else { return .unknown }
        guard let status = run(["status", "--porcelain", "--untracked-files=normal"], in: repository) else {
            return .unknown
        }
        if !status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .dirty }

        // No upstream at all means nothing was ever pushed anywhere.
        guard let upstream = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], in: repository),
              !upstream.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return .unpushed }

        guard let ahead = run(["rev-list", "--count", "@{upstream}..HEAD"], in: repository) else {
            return .unknown
        }
        let count = Int(ahead.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        return count > 0 ? .unpushed : .clean
    }

    private func run(_ arguments: [String], in directory: URL) -> String? {
        guard let executableURL else { return nil }
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        process.currentDirectoryURL = directory
        process.environment = ["GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "HOME": NSHomeDirectory()]

        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()

        do {
            try process.run()
        } catch {
            return nil
        }

        let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)
        let data = (try? output.fileHandleForReading.readToEnd()) ?? Data()
        process.waitUntilExit()
        watchdog.cancel()

        guard process.terminationStatus == 0 else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
}
