import Foundation

/// Answers "is anything holding this exact file open right now?".
///
/// "Is Codex running?" is the wrong question for a rollout file: a live session appends to
/// its own rollout and nothing else, so a terminal session that cannot be closed should
/// not stop the other 180 sessions from being slimmed. Asking about one file is cheap and
/// precise, which asking about a whole directory tree is not.
struct FileUsageProbe: Sendable {
    /// One-way flag, set from the watchdog queue and read after the process exits.
    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false

        func set() {
            lock.lock()
            value = true
            lock.unlock()
        }

        var isSet: Bool {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }


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
        // -F cn prints one field per line: `p<pid>`, then `c<command>`, then `n<name>`.
        process.arguments = ["-n", "-P", "-F", "cn", "--", url.path]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()

        do {
            try process.run()
        } catch {
            return .unknown
        }

        // Whether the watchdog actually fired has to be recorded by the watchdog itself.
        // It cannot be inferred from the exit status: lsof exits 1 with no output when
        // nothing holds the file, which is a real answer, not a failure.
        let timedOut = Flag()
        let watchdog = DispatchWorkItem {
            guard process.isRunning else { return }
            timedOut.set()
            process.terminate()
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)
        let data = (try? output.fileHandleForReading.readToEnd()) ?? Data()
        process.waitUntilExit()
        watchdog.cancel()

        return Self.interpret(
            output: String(decoding: data, as: UTF8.self),
            terminationStatus: process.terminationStatus,
            timedOut: timedOut.isSet
        )
    }

    /// The decision table, kept separate from the process plumbing so it can be tested.
    ///
    /// `lsof` exits 0 when it found something and 1 when it found nothing. Both are
    /// answers. Only a timeout or an unexpected exit code means "cannot tell".
    static func interpret(output: String, terminationStatus: Int32, timedOut: Bool) -> Usage {
        let processes = parseCommands(output)
        if !processes.isEmpty { return .inUse(processes: processes) }
        if timedOut { return .unknown }
        return (terminationStatus == 0 || terminationStatus == 1) ? .free : .unknown
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
