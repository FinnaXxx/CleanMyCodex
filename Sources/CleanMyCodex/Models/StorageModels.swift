import Foundation

enum StorageKind: String, CaseIterable, Sendable {
    case temporary
    case logs
    case plugins
    case generatedImages
    case computerUse
    case activeSessions
    case archivedSessions
    case appCache
    case other
}

struct StorageItem: Identifiable, Sendable {
    let id: String
    let kind: StorageKind
    let title: String
    let detail: String
    let bytes: Int64
    let paths: [URL]
    let recommended: Bool
}

enum SessionLocation: String, CaseIterable, Sendable {
    case active = "普通"
    case archived = "已归档"
}

struct SessionItem: Identifiable, Sendable {
    let id: String
    let threadID: String
    let fileURL: URL
    let location: SessionLocation
    let modifiedAt: Date
    let totalBytes: Int64
    let embeddedImageBytes: Int64
    let embeddedImageCount: Int
    let workingDirectory: String?
    let isCompressed: Bool
    let isUnstable: Bool
    let parseWarnings: Int

    var displayName: String {
        if let workingDirectory, !workingDirectory.isEmpty {
            return URL(fileURLWithPath: workingDirectory).lastPathComponent
        }
        return String(threadID.prefix(12))
    }
}

struct PluginVersionItem: Identifiable, Sendable {
    let marketplace: String
    let plugin: String
    let version: String
    let directoryURL: URL
    let bytes: Int64

    var id: String { "\(marketplace)/\(plugin)/\(version)" }
}

struct ScanSnapshot: Sendable {
    let codexHome: URL
    let scannedAt: Date
    let totalCodexBytes: Int64
    let storageItems: [StorageItem]
    let sessions: [SessionItem]
    let pluginVersions: [PluginVersionItem]

    static func empty(at url: URL) -> ScanSnapshot {
        ScanSnapshot(
            codexHome: url,
            scannedAt: .now,
            totalCodexBytes: 0,
            storageItems: [],
            sessions: [],
            pluginVersions: []
        )
    }
}

enum ByteFormat {
    static func string(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB, .useTB]
        formatter.countStyle = .file
        formatter.includesUnit = true
        formatter.isAdaptive = true
        return formatter.string(fromByteCount: bytes)
    }
}
