import Foundation

/// Answers "is anything holding this exact file open right now?".
///
/// "Is Codex running?" is the wrong question for a rollout file: a live session appends to
/// its own rollout and nothing else, so a terminal session that cannot be closed should
/// not stop the other 180 sessions from being slimmed. Asking about one file is cheap and
/// precise, which asking about a whole directory tree is not.
struct FileUsageProbe: Sendable {
    enum Usage: Equatable, Sendable {
        case free
        case inUse(processes: [String])
        /// lsof is missing or refused to answer; the caller decides how careful to be.
        case unknown
    }

    let executableURL: URL?
    let timeout: TimeInterval

    init(executableURL: URL? = nil, timeout: TimeInterval = 5) {
        self.executableURL = executableURL ?? Self.locate()
        self.timeout = timeout
    }

    static func locate(manager: FileManager = FileManager()) -> URL? {
        ["/usr/sbin/lsof", "/usr/bin/lsof", "/opt/homebrew/bin/lsof"]
            .map { URL(fileURLWithPath: $0) }
            .first { manager.isExecutableFile(atPath: $0.path) }
    }

    func usage(of url: URL) -> Usage {
        guard let executableURL else { return .unknown }
        guard FileManager.default.fileExists(atPath: url.path) else { return .free }

        let process = Process()
        process.executableURL = executableURL
        // -F cn prints one field per line: `c<command>` then `n<name>`.
        process.arguments = ["-n", "-P", "-F", "cn", "--", url.path]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()

        do {
            try process.run()
        } catch {
            return .unknown
        }

        let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)
        let data = (try? output.fileHandleForReading.readToEnd()) ?? Data()
        process.waitUntilExit()
        let timedOut = watchdog.isCancelled == false && process.terminationStatus != 0 && data.isEmpty
        watchdog.cancel()

        let processes = Self.parseCommands(String(decoding: data, as: UTF8.self))
        if !processes.isEmpty { return .inUse(processes: processes) }
        // lsof exits 1 when it simply found nothing, which is a real answer.
        if process.terminationStatus == 0 || process.terminationStatus == 1 {
            return timedOut ? .unknown : .free
        }
        return .unknown
    }

    static func parseCommands(_ output: String) -> [String] {
        var names: [String] = []
        for line in output.split(whereSeparator: \.isNewline) {
            guard line.first == "c" else { continue }
            let name = String(line.dropFirst())
            guard !name.isEmpty, !names.contains(name) else { continue }
            names.append(name)
        }
        return names
    }
}
