import Foundation

struct InstalledPlugin: Sendable, Hashable {
    let name: String
    let version: String?
    let directory: URL?
}

enum AppServerError: LocalizedError {
    case executableNotFound
    case launchFailed(String)
    case timedOut(String)
    case transportClosed
    case remote(code: Int, message: String)
    case malformedResponse

    var errorDescription: String? {
        switch self {
        case .executableNotFound: "没有找到 codex 命令行，无法调用 app server"
        case let .launchFailed(message): "启动 codex app-server 失败：\(message)"
        case let .timedOut(method): "调用 \(method) 超时"
        case .transportClosed: "codex app-server 已退出"
        case let .remote(code, message): "codex 返回错误 \(code)：\(message)"
        case .malformedResponse: "无法解析 codex app-server 的响应"
        }
    }
}

/// Talks to `codex app-server` over newline-delimited JSON-RPC on stdio.
///
/// Deleting a thread through the app server is the only way to also drop the derived
/// metadata and spawned child threads, so it is preferred over removing the rollout file.
struct CodexAppServerClient: Sendable {
    let executableURL: URL?
    let codexHome: URL
    let timeout: TimeInterval

    init(codexHome: URL, executableURL: URL? = nil, timeout: TimeInterval = 20) {
        self.codexHome = codexHome
        self.executableURL = executableURL ?? Self.locateExecutable()
        self.timeout = timeout
    }

    var isAvailable: Bool { executableURL != nil }

    static func locateExecutable(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> URL? {
        var candidates: [URL] = []
        if let override = environment["CODEX_BINARY"], !override.isEmpty {
            candidates.append(URL(fileURLWithPath: override))
        }
        for directory in (environment["PATH"] ?? "").split(separator: ":") where !directory.isEmpty {
            candidates.append(URL(fileURLWithPath: String(directory)).appending(path: "codex"))
        }
        let home = fileManager.homeDirectoryForCurrentUser
        candidates += [
            URL(fileURLWithPath: "/opt/homebrew/bin/codex"),
            URL(fileURLWithPath: "/usr/local/bin/codex"),
            home.appending(path: ".codex/bin/codex"),
            home.appending(path: ".local/bin/codex")
        ]
        return candidates.first { fileManager.isExecutableFile(atPath: $0.path) }
    }

    func openSession() throws -> CodexAppServerSession {
        guard let executableURL else { throw AppServerError.executableNotFound }
        let session = try CodexAppServerSession(
            executableURL: executableURL,
            codexHome: codexHome,
            timeout: timeout
        )
        try session.handshake()
        return session
    }

    /// Best-effort plugin inventory. Returns nil when the app server cannot be reached,
    /// which the UI shows as "当前版本未确认" instead of guessing.
    func installedPlugins() -> [InstalledPlugin]? {
        guard let session = try? openSession() else { return nil }
        defer { session.close() }
        guard let response = try? session.call("plugin/list", params: [:]) else { return nil }
        return Self.parsePlugins(response)
    }

    static func parsePlugins(_ response: Any?) -> [InstalledPlugin] {
        let rows: [[String: Any]]
        if let array = response as? [[String: Any]] {
            rows = array
        } else if let object = response as? [String: Any] {
            let candidates = ["plugins", "items", "installed", "entries"]
            rows = candidates.compactMap { object[$0] as? [[String: Any]] }.first ?? []
        } else {
            rows = []
        }

        return rows.compactMap { row in
            let nameKeys = ["name", "id", "plugin", "pluginName"]
            guard let name = nameKeys.compactMap({ row[$0] as? String }).first else { return nil }
            let version = ["version", "installedVersion", "currentVersion"]
                .compactMap { row[$0] as? String }.first
            let path = ["path", "directory", "installPath", "root", "location"]
                .compactMap { row[$0] as? String }.first
            return InstalledPlugin(
                name: name,
                version: version,
                directory: path.map { URL(fileURLWithPath: $0) }
            )
        }
    }
}

/// One running `codex app-server` process. Not thread safe by design: calls are issued
/// sequentially from the cleanup task; only the timeout watchdog touches it concurrently.
final class CodexAppServerSession: @unchecked Sendable {
    private let process = Process()
    private let inputPipe = Pipe()
    private let outputPipe = Pipe()
    private let timeout: TimeInterval
    private let lock = NSLock()
    private var buffer = Data()
    private var nextID = 1
    private var closed = false

    init(executableURL: URL, codexHome: URL, timeout: TimeInterval) throws {
        self.timeout = timeout
        process.executableURL = executableURL
        process.arguments = ["app-server"]
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        environment["CODEX_HOME"] = codexHome.path
        process.environment = environment
        do {
            try process.run()
        } catch {
            throw AppServerError.launchFailed(error.localizedDescription)
        }
    }

    func handshake() throws {
        _ = try call("initialize", params: [
            "clientInfo": [
                "name": "cleanmycodex",
                "title": "CleanMyCodex",
                "version": AppInfo.version
            ],
            "capabilities": ["experimentalApi": false]
        ])
        try notify("initialized", params: [:])
    }

    @discardableResult
    func deleteThread(id threadID: String) throws -> Any? {
        try call("thread/delete", params: ["threadId": threadID])
    }

    @discardableResult
    func call(_ method: String, params: [String: Any]) throws -> Any? {
        let identifier = nextIdentifier()
        try send([
            "jsonrpc": "2.0",
            "id": identifier,
            "method": method,
            "params": params
        ])

        let deadline = Date().addingTimeInterval(timeout)
        while true {
            guard let line = try readLine(deadline: deadline, method: method) else {
                throw AppServerError.transportClosed
            }
            guard
                let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
            else { continue }
            guard let responseID = object["id"] as? Int, responseID == identifier else { continue }
            if let error = object["error"] as? [String: Any] {
                throw AppServerError.remote(
                    code: error["code"] as? Int ?? -1,
                    message: error["message"] as? String ?? "未知错误"
                )
            }
            return object["result"]
        }
    }

    func notify(_ method: String, params: [String: Any]) throws {
        try send(["jsonrpc": "2.0", "method": method, "params": params])
    }

    func close() {
        lock.lock()
        let alreadyClosed = closed
        closed = true
        lock.unlock()
        guard !alreadyClosed else { return }
        try? inputPipe.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
        try? outputPipe.fileHandleForReading.close()
    }

    private func nextIdentifier() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let value = nextID
        nextID += 1
        return value
    }

    private func send(_ message: [String: Any]) throws {
        guard process.isRunning else { throw AppServerError.transportClosed }
        var payload = try JSONSerialization.data(withJSONObject: message)
        payload.append(0x0A)
        try inputPipe.fileHandleForWriting.write(contentsOf: payload)
    }

    /// Blocking read of one line. A watchdog terminates the child if it stops answering,
    /// which unblocks the read with EOF instead of hanging the cleanup.
    private func readLine(deadline: Date, method: String) throws -> Data? {
        while true {
            if let line = takeBufferedLine() { return line }
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { throw AppServerError.timedOut(method) }

            let watchdog = DispatchWorkItem { [weak self] in self?.forceTerminate() }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + remaining, execute: watchdog)
            let chunk = outputPipe.fileHandleForReading.availableData
            watchdog.cancel()

            if chunk.isEmpty {
                if Date() >= deadline { throw AppServerError.timedOut(method) }
                return nil
            }
            lock.lock()
            buffer.append(chunk)
            lock.unlock()
        }
    }

    private func takeBufferedLine() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        guard let newline = buffer.firstIndex(of: 0x0A) else { return nil }
        let line = Data(buffer[buffer.startIndex..<newline])
        buffer = Data(buffer[buffer.index(after: newline)...])
        return line
    }

    private func forceTerminate() {
        if process.isRunning { process.terminate() }
    }

    deinit { close() }
}

enum AppInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    static var bundleIdentifier: String {
        Bundle.main.bundleIdentifier ?? "com.finnaxxx.clean-my-codex"
    }
}
