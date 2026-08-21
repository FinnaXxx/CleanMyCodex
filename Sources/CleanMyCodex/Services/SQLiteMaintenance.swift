import Foundation
import SQLite3

/// Free pages left behind by Codex' own log retention. Deleting rows never shrinks the file,
/// so the only safe way to get the space back is to checkpoint the WAL and vacuum.
struct SQLiteInspection: Sendable {
    let url: URL
    let fileBytes: Int64
    let walBytes: Int64
    let pageSize: Int64
    let pageCount: Int64
    let freeListCount: Int64

    var usedBytes: Int64 { (pageCount - freeListCount) * pageSize }
    var freeListBytes: Int64 { freeListCount * pageSize }
    /// WAL content is folded back into the main file, so it counts as reclaimable too.
    var reclaimableBytes: Int64 { max(0, freeListBytes + walBytes) }
}

struct SQLiteCompactionReport: Sendable {
    let url: URL
    let beforeBytes: Int64
    let afterBytes: Int64
    let integrityOK: Bool

    var freedBytes: Int64 { max(0, beforeBytes - afterBytes) }
}

enum SQLiteMaintenanceError: LocalizedError {
    case cannotOpen(String, String)
    case queryFailed(String, String)
    case integrityCheckFailed(String)

    var errorDescription: String? {
        switch self {
        case let .cannotOpen(path, message): "无法打开数据库 \(path)：\(message)"
        case let .queryFailed(sql, message): "数据库操作失败 \(sql)：\(message)"
        case let .integrityCheckFailed(result): "完整性检查未通过：\(result)"
        }
    }
}

struct SQLiteMaintenance: Sendable {
    let busyTimeoutMilliseconds: Int32

    init(busyTimeoutMilliseconds: Int32 = 4_000) {
        self.busyTimeoutMilliseconds = busyTimeoutMilliseconds
    }

    /// Look at how much of the file is dead weight. Runs only PRAGMAs, so it is safe while
    /// Codex is running. A WAL database cannot always be opened read-only (it needs to create
    /// the -shm file), so read/write is tried first and read-only is the fallback.
    func inspect(_ url: URL) throws -> SQLiteInspection {
        let handle: Connection
        if let writable = try? Connection(url: url, readOnly: false, busyTimeout: busyTimeoutMilliseconds) {
            handle = writable
        } else {
            handle = try Connection(url: url, readOnly: true, busyTimeout: busyTimeoutMilliseconds)
        }
        defer { handle.close() }
        let pageSize = try handle.scalarInt("PRAGMA page_size;")
        let pageCount = try handle.scalarInt("PRAGMA page_count;")
        let freeList = try handle.scalarInt("PRAGMA freelist_count;")
        return SQLiteInspection(
            url: url,
            fileBytes: FileSize.of(url),
            walBytes: FileSize.of(URL(fileURLWithPath: url.path + "-wal")),
            pageSize: pageSize,
            pageCount: pageCount,
            freeListCount: freeList
        )
    }

    /// Checkpoint, vacuum and verify. Only call this when Codex is not running.
    func compact(_ url: URL) throws -> SQLiteCompactionReport {
        let before = totalFootprint(of: url)
        let handle = try Connection(url: url, readOnly: false, busyTimeout: busyTimeoutMilliseconds)
        defer { handle.close() }

        try handle.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        let autoVacuum = (try? handle.scalarInt("PRAGMA auto_vacuum;")) ?? 0
        if autoVacuum == 2 {
            // Incremental mode: releasing the free list is cheaper than a full rewrite.
            try handle.execute("PRAGMA incremental_vacuum;")
        }
        try handle.execute("VACUUM;")
        try handle.execute("PRAGMA wal_checkpoint(TRUNCATE);")

        let integrity = try handle.scalarText("PRAGMA integrity_check;")
        guard integrity.lowercased() == "ok" else {
            throw SQLiteMaintenanceError.integrityCheckFailed(integrity)
        }

        return SQLiteCompactionReport(
            url: url,
            beforeBytes: before,
            afterBytes: totalFootprint(of: url),
            integrityOK: true
        )
    }

    private func totalFootprint(of url: URL) -> Int64 {
        FileSize.of(url)
            + FileSize.of(URL(fileURLWithPath: url.path + "-wal"))
            + FileSize.of(URL(fileURLWithPath: url.path + "-shm"))
    }
}

/// Minimal wrapper so the C pointer never escapes this file.
private final class Connection {
    private var handle: OpaquePointer?

    init(url: URL, readOnly: Bool, busyTimeout: Int32) throws {
        let flags = readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE
        var pointer: OpaquePointer?
        let status = sqlite3_open_v2(url.path, &pointer, flags, nil)
        guard status == SQLITE_OK, let pointer else {
            let message = pointer.map { String(cString: sqlite3_errmsg($0)) } ?? "错误码 \(status)"
            if pointer != nil { sqlite3_close(pointer) }
            throw SQLiteMaintenanceError.cannotOpen(url.lastPathComponent, message)
        }
        handle = pointer
        sqlite3_busy_timeout(pointer, busyTimeout)
    }

    func close() {
        if let handle { sqlite3_close(handle) }
        handle = nil
    }

    func execute(_ sql: String) throws {
        guard let handle else { throw SQLiteMaintenanceError.queryFailed(sql, "连接已关闭") }
        var errorPointer: UnsafeMutablePointer<CChar>?
        let status = sqlite3_exec(handle, sql, nil, nil, &errorPointer)
        var message = "错误码 \(status)"
        if let errorPointer {
            message = String(cString: errorPointer)
            sqlite3_free(errorPointer)
        }
        if status != SQLITE_OK {
            throw SQLiteMaintenanceError.queryFailed(sql, message)
        }
    }

    func scalarInt(_ sql: String) throws -> Int64 {
        try withStatement(sql) { statement -> Int64 in
            sqlite3_column_int64(statement, 0)
        }
    }

    func scalarText(_ sql: String) throws -> String {
        try withStatement(sql) { statement -> String in
            guard let text = sqlite3_column_text(statement, 0) else { return "" }
            return String(cString: text)
        }
    }

    private func withStatement<T>(_ sql: String, _ body: (OpaquePointer) -> T) throws -> T {
        guard let handle else { throw SQLiteMaintenanceError.queryFailed(sql, "连接已关闭") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            let message = String(cString: sqlite3_errmsg(handle))
            sqlite3_finalize(statement)
            throw SQLiteMaintenanceError.queryFailed(sql, message)
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else {
            throw SQLiteMaintenanceError.queryFailed(sql, String(cString: sqlite3_errmsg(handle)))
        }
        return body(statement)
    }
}

enum FileSize {
    static func of(_ url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [
            .totalFileAllocatedSizeKey,
            .fileAllocatedSizeKey,
            .fileSizeKey
        ])
        return Int64(values?.totalFileAllocatedSize ?? values?.fileAllocatedSize ?? values?.fileSize ?? 0)
    }
}
