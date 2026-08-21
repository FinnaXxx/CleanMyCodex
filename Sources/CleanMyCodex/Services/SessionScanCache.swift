import Foundation

/// Remembers what a rollout file contained the last time it was read.
///
/// Counting embedded images means streaming every byte of every session — well over a
/// gigabyte on a busy install. Rollouts are append-only and archived ones never change
/// again, so a hit on (size, modification date) lets a rescan skip the read entirely.
/// That is what makes the rescan after a cleanup feel instant instead of stalling the UI.
struct SessionScanCache: Sendable {
    struct Record: Codable, Sendable {
        var size: Int64
        var modified: Double
        var imageBytes: Int64
        var imageCount: Int
        var truncatedCandidates: Int
        var tags: [String]
        var threadID: String?
        var workingDirectory: String?
        var title: String?
        var preview: String?
        var parseWarnings: Int
    }

    private struct Payload: Codable {
        var version: Int
        var records: [String: Record]
    }

    private static let currentVersion = 1
    private static let fileName = "session-scan.json"

    private var records: [String: Record]
    private var seen: Set<String> = []
    private var dirty = false

    private init(records: [String: Record]) {
        self.records = records
    }

    static func load(from directory: URL) -> SessionScanCache {
        let url = directory.appending(path: fileName)
        guard
            let data = try? Data(contentsOf: url),
            let payload = try? JSONDecoder().decode(Payload.self, from: data),
            payload.version == currentVersion
        else { return SessionScanCache(records: [:]) }
        return SessionScanCache(records: payload.records)
    }

    /// A record only counts as valid when the file is byte-for-byte the one we read.
    mutating func record(for url: URL, size: Int64, modified: Date) -> Record? {
        let key = url.standardizedFileURL.path
        seen.insert(key)
        guard let record = records[key],
              record.size == size,
              abs(record.modified - modified.timeIntervalSince1970) < 0.000_5
        else { return nil }
        return record
    }

    mutating func store(_ record: Record, for url: URL) {
        let key = url.standardizedFileURL.path
        seen.insert(key)
        records[key] = record
        dirty = true
    }

    /// Drops entries for sessions that no longer exist so the file cannot grow forever.
    mutating func save(to directory: URL) {
        let stale = records.keys.filter { !seen.contains($0) }
        if !stale.isEmpty {
            for key in stale { records.removeValue(forKey: key) }
            dirty = true
        }
        guard dirty else { return }
        let payload = Payload(version: Self.currentVersion, records: records)
        guard let data = try? JSONEncoder().encode(payload) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: directory.appending(path: Self.fileName), options: .atomic)
        dirty = false
    }
}

extension SessionScanCache.Record {
    init(scan: SessionContentScan, size: Int64, modified: Date) {
        self.init(
            size: size,
            modified: modified.timeIntervalSince1970,
            imageBytes: scan.images.uriBytes,
            imageCount: scan.images.count,
            truncatedCandidates: scan.images.truncatedCandidates,
            tags: scan.tags.map(\.rawValue).sorted(),
            threadID: scan.metadata.id,
            workingDirectory: scan.metadata.workingDirectory,
            title: scan.metadata.title,
            preview: scan.metadata.preview,
            parseWarnings: scan.parseWarnings
        )
    }

    var contentScan: SessionContentScan {
        var scan = SessionContentScan()
        scan.images = EmbeddedImageScanResult(
            count: imageCount,
            uriBytes: imageBytes,
            base64Bytes: 0,
            truncatedCandidates: truncatedCandidates
        )
        scan.tags = Set(tags.compactMap(SessionTag.init(rawValue:)))
        scan.metadata = SessionMetadata(
            id: threadID,
            workingDirectory: workingDirectory,
            title: title,
            preview: preview
        )
        scan.parseWarnings = parseWarnings
        return scan
    }
}
