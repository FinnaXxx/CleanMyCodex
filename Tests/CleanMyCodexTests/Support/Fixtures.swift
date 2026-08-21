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

    private static func execute(_ handle: OpaquePointer, _ sql: String) {
        sqlite3_exec(handle, sql, nil, nil, nil)
    }
}
