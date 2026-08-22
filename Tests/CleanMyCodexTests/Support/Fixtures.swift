import Foundation
import SQLite3

struct TemporaryFixture {
    let root: URL

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appending(path: "CleanMyCodexTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func directory(_ relativePath: String) -> URL {
        let url = root.appending(path: relativePath, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func file(_ relativePath: String) -> URL {
        root.appending(path: relativePath)
    }

    @discardableResult
    func write(_ contents: String, to relativePath: String) throws -> URL {
        let url = file(relativePath)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(contents.utf8).write(to: url)
        return url
    }

    /// Backdates a path so grace-period rules treat it as settled.
    func age(_ relativePath: String, hours: Double) {
        let url = file(relativePath)
        try? FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSinceNow: -hours * 3_600)],
            ofItemAtPath: url.path
        )
    }

    /// Backdates a whole subtree, so activity-based rules see it as settled.
    func ageTree(_ relativePath: String, hours: Double) {
        let root = file(relativePath)
        let date = Date(timeIntervalSinceNow: -hours * 3_600)
        var paths = [root]
        if let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) {
            for case let url as URL in enumerator { paths.append(url) }
        }
        // Deepest first: touching a child updates its parent's timestamp.
        for url in paths.sorted(by: { $0.pathComponents.count > $1.pathComponents.count }) {
            try? FileManager.default.setAttributes(
                [.modificationDate: date],
                ofItemAtPath: url.path
            )
        }
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }
}

enum SQLiteFixture {
    /// Builds a database with a large free list, the situation Codex' log retention leaves behind.
    static func makeLogDatabase(at url: URL, rows: Int = 600, deleteAll: Bool = true) {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(url.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK,
              let handle
        else { return }
        defer { sqlite3_close(handle) }

        let payload = String(repeating: "x", count: 8_192)
        execute(handle, "PRAGMA journal_mode=WAL;")
        execute(handle, "CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, payload TEXT);")
        execute(handle, "BEGIN;")
        for index in 0..<rows {
            execute(handle, "INSERT INTO logs(id, payload) VALUES(\(index), '\(payload)');")
        }
        execute(handle, "COMMIT;")
        if deleteAll {
            execute(handle, "DELETE FROM logs;")
        }
        execute(handle, "PRAGMA wal_checkpoint(TRUNCATE);")
    }

    /// Mirrors the `threads` table Codex keeps in `state_*.sqlite`.
    static func makeStateDatabase(at url: URL, threads: [(id: String, title: String?, rollout: String?)]) {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(url.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK,
              let handle
        else { return }
        defer { sqlite3_close(handle) }

        execute(handle, """
            CREATE TABLE IF NOT EXISTS threads(
                id TEXT PRIMARY KEY,
                cwd TEXT,
                title TEXT,
                archived INTEGER,
                rollout_path TEXT,
                updated_at INTEGER
            );
            """)
        for thread in threads {
            let title = thread.title.map { "'\($0.replacingOccurrences(of: "'", with: "''"))'" } ?? "NULL"
            let rollout = thread.rollout.map { "'\($0.replacingOccurrences(of: "'", with: "''"))'" } ?? "NULL"
            execute(
                handle,
                "INSERT INTO threads(id, cwd, title, archived, rollout_path, updated_at) "
                    + "VALUES('\(thread.id)', '/tmp/demo', \(title), 0, \(rollout), 1);"
            )
        }
    }

    private static func execute(_ handle: OpaquePointer, _ sql: String) {
        sqlite3_exec(handle, sql, nil, nil, nil)
    }
}
