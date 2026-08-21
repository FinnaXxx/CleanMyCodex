import Foundation

/// Where a category is shown and how aggressively it is preselected.
enum StorageGroup: String, CaseIterable, Sendable {
    case recommended
    case review
    case protectedData

    var title: String {
        switch self {
        case .recommended: "建议清理"
        case .review: "谨慎清理"
        case .protectedData: "受保护的数据"
        }
    }

    var subtitle: String {
        switch self {
        case .recommended: "可重建或无损回收，默认选中"
        case .review: "删除后无法恢复，请逐项确认"
        case .protectedData: "配置、登录信息和用户成果，永不清理"
        }
    }
}

enum CleanupRisk: String, Sendable {
    case lossless
    case safe
    case rebuildable
    case caution
    case shielded

    var label: String {
        switch self {
        case .lossless: "无损"
        case .safe: "安全"
        case .rebuildable: "可重建"
        case .caution: "谨慎清理"
        case .shielded: "受保护"
        }
    }

    var isSelectable: Bool { self != .shielded }
}

/// How a single entry is reclaimed.
enum CleanupMethod: String, Sendable {
    case trash
    case compactDatabase
    case deleteThread

    var label: String {
        switch self {
        case .trash: "移到废纸篓"
        case .compactDatabase: "压缩数据库"
        case .deleteThread: "删除会话"
        }
    }
}

enum StorageKind: String, CaseIterable, Sendable {
    case logDatabase
    case temporary
    case marketplaceCache
    case pluginRemnants
    case browserCache
    case appCache
    case appLogs
    case generatedImages
    case computerUse
    case activeSessions
    case archivedSessions
    case protectedConfig
    case protectedUserData

    var symbol: String {
        switch self {
        case .logDatabase: "cylinder.split.1x2"
        case .temporary: "clock.arrow.circlepath"
        case .marketplaceCache: "bag"
        case .pluginRemnants: "puzzlepiece.extension"
        case .browserCache: "safari"
        case .appCache: "externaldrive"
        case .appLogs: "doc.text"
        case .generatedImages: "photo.on.rectangle"
        case .computerUse: "display"
        case .activeSessions: "bubble.left.and.bubble.right"
        case .archivedSessions: "archivebox"
        case .protectedConfig: "lock.shield"
        case .protectedUserData: "folder.badge.person.crop"
        }
    }
}

/// One concrete thing the cleaner can act on: a directory, a file or a database.
struct StorageEntry: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let detail: String
    let url: URL
    let bytes: Int64
    /// Space actually returned to the volume. Equals `bytes` except for database compaction.
    let reclaimableBytes: Int64
    let method: CleanupMethod
    let risk: CleanupRisk

    init(
        title: String,
        detail: String,
        url: URL,
        bytes: Int64,
        reclaimableBytes: Int64? = nil,
        method: CleanupMethod = .trash,
        risk: CleanupRisk
    ) {
        self.id = "\(method.rawValue):\(url.standardizedFileURL.path)"
        self.title = title
        self.detail = detail
        self.url = url.standardizedFileURL
        self.bytes = bytes
        self.reclaimableBytes = reclaimableBytes ?? bytes
        self.method = method
        self.risk = risk
    }
}

struct StorageCategory: Identifiable, Sendable {
    let kind: StorageKind
    let title: String
    let detail: String
    let group: StorageGroup
    let risk: CleanupRisk
    let entries: [StorageEntry]

    var id: String { kind.rawValue }
    var symbol: String { kind.symbol }
    var bytes: Int64 { entries.reduce(Int64(0)) { $0 + $1.bytes } }
    var reclaimableBytes: Int64 { entries.reduce(Int64(0)) { $0 + $1.reclaimableBytes } }
    var isEmpty: Bool { entries.isEmpty }
    var isSelectable: Bool { risk.isSelectable && !entries.isEmpty }
}

enum SessionLocation: String, CaseIterable, Sendable {
    case active = "未归档"
    case archived = "已归档"
}

enum SessionTag: String, CaseIterable, Sendable {
    case imageHeavy
    case browser
    case computerUse
    case imageGen

    var label: String {
        switch self {
        case .imageHeavy: "图片密集"
        case .browser: "Browser"
        case .computerUse: "Computer Use"
        case .imageGen: "ImageGen"
        }
    }
}

struct SessionItem: Identifiable, Sendable {
    let id: String
    let threadID: String
    let fileURL: URL
    let location: SessionLocation
    let modifiedAt: Date
    let fileBytes: Int64
    let assetBytes: Int64
    let assetURLs: [URL]
    let embeddedImageBytes: Int64
    let embeddedImageCount: Int
    let workingDirectory: String?
    let title: String?
    /// First user message, kept so a thread without a title is still recognisable.
    let preview: String?
    let tags: [SessionTag]
    let isCompressed: Bool
    let isUnstable: Bool
    let parseWarnings: Int

    var totalBytes: Int64 { fileBytes + assetBytes }

    /// Folder name of the working directory — what the user thinks of as "the project".
    var projectName: String? {
        guard let workingDirectory, !workingDirectory.isEmpty else { return nil }
        let name = URL(fileURLWithPath: workingDirectory).lastPathComponent
        return name.isEmpty ? nil : name
    }

    /// What the session is about. Falls back through title, first user message and
    /// project name so a row is never just a UUID when we know anything better.
    var displayName: String {
        if let title, !title.isEmpty { return title }
        if let preview, !preview.isEmpty { return preview }
        if let projectName { return projectName }
        return String(threadID.prefix(12))
    }

    /// True when `displayName` had to fall back to something that is not a real title.
    var hasTitle: Bool {
        (title?.isEmpty == false) || (preview?.isEmpty == false)
    }

    var imageShare: Double {
        guard fileBytes > 0 else { return 0 }
        return min(1, Double(embeddedImageBytes) / Double(fileBytes))
    }
}

enum PluginStatus: String, Sendable {
    case current
    case outdated
    case orphaned
    case unconfirmed

    var label: String {
        switch self {
        case .current: "当前版本"
        case .outdated: "旧版本"
        case .orphaned: "卸载残留"
        case .unconfirmed: "未确认"
        }
    }

    var isRemovable: Bool { self == .outdated || self == .orphaned }
}

struct PluginVersionItem: Identifiable, Sendable {
    let marketplace: String
    let plugin: String
    let version: String
    let directoryURL: URL
    let bytes: Int64
    let environmentBytes: Int64
    let modifiedAt: Date
    let status: PluginStatus

    var id: String { directoryURL.standardizedFileURL.path }
    var groupKey: String { "\(plugin) · \(marketplace)" }
}

struct ScanProgress: Sendable {
    var stage: String
    var currentPath: String
    var scannedBytes: Int64
    var fraction: Double

    static let idle = ScanProgress(stage: "", currentPath: "", scannedBytes: 0, fraction: 0)
}

struct ScanSnapshot: Sendable {
    let codexHome: URL
    let scannedAt: Date
    let totalCodexBytes: Int64
    let externalBytes: Int64
    let categories: [StorageCategory]
    let sessions: [SessionItem]
    let pluginVersions: [PluginVersionItem]
    let notes: [String]

    var isEmpty: Bool { categories.isEmpty && sessions.isEmpty && pluginVersions.isEmpty }

    func categoryList(in group: StorageGroup) -> [StorageCategory] {
        categories.filter { $0.group == group && !$0.isEmpty }
            .sorted { $0.reclaimableBytes > $1.reclaimableBytes }
    }

    var sessionBytes: Int64 { sessions.reduce(Int64(0)) { $0 + $1.totalBytes } }
    var embeddedImageBytes: Int64 { sessions.reduce(Int64(0)) { $0 + $1.embeddedImageBytes } }

    static func empty(at url: URL) -> ScanSnapshot {
        ScanSnapshot(
            codexHome: url,
            scannedAt: .now,
            totalCodexBytes: 0,
            externalBytes: 0,
            categories: [],
            sessions: [],
            pluginVersions: [],
            notes: []
        )
    }
}

enum ByteFormat {
    private static let units = ["B", "KiB", "MiB", "GiB", "TiB"]

    /// Binary units, matching how macOS reports Codex' own directories.
    static func string(_ bytes: Int64) -> String {
        guard bytes > 0 else { return "0 B" }
        var value = Double(bytes)
        var index = 0
        while value >= 1_024, index < units.count - 1 {
            value /= 1_024
            index += 1
        }
        if index == 0 { return "\(bytes) B" }
        let decimals = value < 10 ? 2 : (value < 100 ? 1 : 0)
        return String(format: "%.\(decimals)f %@", value, units[index])
    }
}
