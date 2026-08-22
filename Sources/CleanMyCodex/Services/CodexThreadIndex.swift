import Foundation
import SQLite3

/// Thread titles as Codex itself shows them.
///
/// Codex keeps thread metadata in `~/.codex/state_*.sqlite`: a `threads` table with
/// `id`, `title`, `cwd`, `rollout_path` and `updated_at`. That title is the short generated
/// name from the Codex UI, which is far more recognisable than anything that can be read out
/// of a rollout file — the first turns there are injected context, not what the user typed.
///
/// The state database is on the never-touch list, so it is only ever opened read-only. When
/// that fails (a WAL database whose `-shm` is missing), a bounded copy is read instead and
/// deleted right after; the original is never opened for writing.
struct CodexThreadIndex: Sendable {
    private var byThreadID: [String: String] = [:]
    private var byRolloutPath: [String: String] = [:]

    /// Refuse to copy anything larger than this; thread metadata is small, and a huge file
    /// means we found the wrong database.
    private static let copyLimit: Int64 = 64 * 1_048_576
    private static let rowLimit = 50_000

    var isEmpty: Bool { byThreadID.isEmpty && byRolloutPath.isEmpty }
    var count: Int { Swift.max(byThreadID.count, byRolloutPath.count) }

    /// The rollout path is the stronger key: it identifies the file we are looking at even
    /// when the id in the file header disagrees with the one Codex recorded.
    func title(forThreadID id: String, rolloutPath: URL?) -> String? {
        if let rolloutPath, let title = byRolloutPath[rolloutPath.standardizedFileURL.path] {
            return title
        }
        return byThreadID[id]
    }

    static func load(codexHome: URL, manager: FileManager = FileManager()) -> CodexThreadIndex {
        for candidate in stateDatabases(in: codexHome, manager: manager).prefix(3) {
            if let index = read(candidate, manager: manager), !index.isEmpty { return index }
        }
        return CodexThreadIndex()
    }

    /// `state_5.sqlite`, `state_4.sqlite`, … — newest schema version first.
    static func stateDatabases(in codexHome: URL, manager: FileManager = FileManager()) -> [URL] {
        let names = (try? manager.contentsOfDirectory(atPath: codexHome.path)) ?? []
        return names
            .filter { $0.hasPrefix("state") && $0.hasSuffix(".sqlite") }
            .map { codexHome.appending(path: $0) }
            .sorted { lhs, rhs in
                let left = version(of: lhs.lastPathComponent)
                let right = version(of: rhs.lastPathComponent)
                if left != right { return left > right }
                return lhs.lastPathComponent > rhs.lastPathComponent
            }
    }

    private static func version(of name: String) -> Int {
        Int(name.drop(while: { !$0.isNumber }).prefix(while: \.isNumber)) ?? -1
    }

    private static func read(_ url: URL, manager: FileManager) -> CodexThreadIndex? {
        if let reader = try? SQLiteReader(url: url, readOnly: true) {
            defer { reader.close() }
            if let index = try? index(from: reader), !index.isEmpty { return index }
        }
        // A read-only open cannot replay a WAL it is not allowed to create an -shm for.
        guard let workspace = try? copyForReading(url, manager: manager) else { return nil }
        defer { try? manager.removeItem(at: workspace.directory) }
        guard let reader = try? SQLiteReader(url: workspace.database, readOnly: false) else { return nil }
        defer { reader.close() }
        return try? index(from: reader)
    }

    private static func copyForReading(
        _ url: URL,
        manager: FileManager
    ) throws -> (directory: URL, database: URL) {
        guard FileSize.of(url) <= copyLimit else { throw CocoaError(.fileReadTooLarge) }
        let directory = manager.temporaryDirectory
            .appending(path: "CleanMyCodex-state-\(UUID().uuidString)", directoryHint: .isDirectory)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let database = directory.appending(path: url.lastPathComponent)
        try manager.copyItem(at: url, to: database)
        for suffix in ["-wal", "-shm"] {
            let sidecar = URL(fileURLWithPath: url.path + suffix)
            guard manager.fileExists(atPath: sidecar.path) else { continue }
            try? manager.copyItem(at: sidecar, to: URL(fileURLWithPath: database.path + suffix))
        }
        return (directory, database)
    }

    private static func index(from reader: SQLiteReader) throws -> CodexThreadIndex {
        guard let table = try threadsTable(in: reader) else { return CodexThreadIndex() }
        let columns = try reader.columns(of: table.name)
        let selected = [table.id, table.title, table.rolloutPath].compactMap { $0 }
        guard columns.contains(table.title) else { return CodexThreadIndex() }

        let sql = "SELECT \(selected.map(quoted).joined(separator: ", ")) "
            + "FROM \(quoted(table.name)) LIMIT \(rowLimit)"
        var result = CodexThreadIndex()
        try reader.forEachRow(sql) { row in
            func value(at offset: Int) -> String? { offset < row.count ? row[offset] : nil }
            var cursor = 0
            var threadID: String?
            var rolloutPath: String?
            if table.id != nil { threadID = value(at: cursor); cursor += 1 }
            let title = value(at: cursor)
            cursor += 1
            if table.rolloutPath != nil { rolloutPath = value(at: cursor) }

            guard let cleaned = cleanTitle(title) else { return }
            if let threadID, !threadID.isEmpty { result.byThreadID[threadID] = cleaned }
            if let rolloutPath, !rolloutPath.isEmpty {
                result.byRolloutPath[URL(fileURLWithPath: rolloutPath).standardizedFileURL.path] = cleaned
            }
        }
        return result
    }

    /// Prefer the documented `threads` table, but fall back to any table that pairs a title
    /// with something identifying, so a schema rename does not silently drop every title.
    private static func threadsTable(
        in reader: SQLiteReader
    ) throws -> (name: String, id: String?, title: String, rolloutPath: String?)? {
        let tables = try reader.tableNames()
        let ordered = tables.filter { $0 == "threads" } + tables.filter { $0 != "threads" }
        for name in ordered {
            let columns = try reader.columns(of: name)
            guard let title = ["title", "name", "summary"].first(where: { columns.contains($0) }) else { continue }
            let id = ["id", "thread_id", "conversation_id", "uuid"].first { columns.contains($0) }
            let rollout = ["rollout_path", "rollout", "path", "file_path"].first { columns.contains($0) }
            guard id != nil || rollout != nil else { continue }
            return (name, id, title, rollout)
        }
        return nil
    }

    static func cleanTitle(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let collapsed = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !collapsed.isEmpty else { return nil }
        return collapsed.count > 90 ? String(collapsed.prefix(90)) + "…" : collapsed
    }

    private static func quoted(_ identifier: String) -> String {
        "\"" + identifier.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
}

/// Minimal read side of SQLite: enough to walk a metadata table, nothing that writes.
final class SQLiteReader {
    private var handle: OpaquePointer?

    init(url: URL, readOnly: Bool) throws {
        var pointer: OpaquePointer?
        let flags = readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE
        let status = sqlite3_open_v2(url.path, &pointer, flags, nil)
        guard status == SQLITE_OK, let pointer else {
            if pointer != nil { sqlite3_close(pointer) }
            throw SQLiteMaintenanceError.cannotOpen(url.lastPathComponent, "错误码 \(status)")
        }
        handle = pointer
        sqlite3_busy_timeout(pointer, 2_000)
    }

    func close() {
        if let handle { sqlite3_close(handle) }
        handle = nil
    }

    func tableNames() throws -> [String] {
        var names: [String] = []
        try forEachRow("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')") { row in
            if let name = row.first ?? nil { names.append(name) }
        }
        return names
    }

    func columns(of table: String) throws -> Set<String> {
        let literal = "'" + table.replacingOccurrences(of: "'", with: "''") + "'"
        var result: Set<String> = []
        try forEachRow("SELECT name FROM pragma_table_info(\(literal))") { row in
            if let name = row.first ?? nil { result.insert(name) }
        }
        return result
    }

    func forEachRow(_ sql: String, _ body: ([String?]) -> Void) throws {
        guard let handle else { throw SQLiteMaintenanceError.queryFailed(sql, "连接已关闭") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            let message = String(cString: sqlite3_errmsg(handle))
            sqlite3_finalize(statement)
            throw SQLiteMaintenanceError.queryFailed(sql, message)
        }
        defer { sqlite3_finalize(statement) }

        while sqlite3_step(statement) == SQLITE_ROW {
            let columnCount = Int(sqlite3_column_count(statement))
            var row: [String?] = []
            row.reserveCapacity(columnCount)
            for column in 0..<columnCount {
                if let text = sqlite3_column_text(statement, Int32(column)) {
                    row.append(String(cString: text))
                } else {
                    row.append(nil)
                }
            }
            body(row)
        }
    }
}
