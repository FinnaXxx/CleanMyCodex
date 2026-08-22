import Foundation

/// A concrete unit of work handed to the cleanup engine.
struct CleanupTask: Identifiable, Sendable {
    let id: String
    let title: String
    let detail: String
    let url: URL
    let method: CleanupMethod
    let expectedBytes: Int64
    /// Only set for session deletion, where the app server owns the rollout file.
    let threadID: String?
    /// Extra files removed together with the primary target (generated images, WAL files…).
    let companionURLs: [URL]
    /// Only set for `.slimSession`.
    let slimMode: SessionSlimMode?

    init(
        id: String,
        title: String,
        detail: String,
        url: URL,
        method: CleanupMethod,
        expectedBytes: Int64,
        threadID: String? = nil,
        companionURLs: [URL] = [],
        slimMode: SessionSlimMode? = nil
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.url = url
        self.method = method
        self.expectedBytes = expectedBytes
        self.threadID = threadID
        self.companionURLs = companionURLs
        self.slimMode = slimMode
    }

    init(entry: StorageEntry) {
        self.init(
            id: entry.id,
            title: entry.title,
            detail: entry.detail,
            url: entry.url,
            method: entry.method,
            expectedBytes: entry.reclaimableBytes
        )
    }
}

enum CleanupStatus: Sendable, Equatable {
    case succeeded
    case skipped(String)
    case failed(String)

    var isSuccess: Bool { self == .succeeded }

    var label: String {
        switch self {
        case .succeeded: "已完成"
        case .skipped: "已跳过"
        case .failed: "失败"
        }
    }

    var message: String? {
        switch self {
        case .succeeded: nil
        case let .skipped(reason): reason
        case let .failed(reason): reason
        }
    }
}

struct CleanupOutcome: Identifiable, Sendable {
    let id: String
    let title: String
    let detail: String
    let method: CleanupMethod
    let status: CleanupStatus
    let freedBytes: Int64
}

struct CleanupReport: Sendable {
    let startedAt: Date
    let finishedAt: Date
    let outcomes: [CleanupOutcome]

    var freedBytes: Int64 { outcomes.reduce(Int64(0)) { $0 + $1.freedBytes } }
    var succeeded: [CleanupOutcome] { outcomes.filter { $0.status.isSuccess } }
    var problems: [CleanupOutcome] { outcomes.filter { !$0.status.isSuccess } }

    var summary: String {
        if outcomes.isEmpty { return "没有需要处理的项目" }
        if problems.isEmpty { return "已释放 \(ByteFormat.string(freedBytes))" }
        return "已释放 \(ByteFormat.string(freedBytes))，\(problems.count) 项未完成"
    }

    static let empty = CleanupReport(startedAt: .now, finishedAt: .now, outcomes: [])
}

struct CleanupProgress: Sendable {
    var completed: Int
    var total: Int
    var currentTitle: String

    var fraction: Double {
        guard total > 0 else { return 0 }
        return Double(completed) / Double(total)
    }

    static let idle = CleanupProgress(completed: 0, total: 0, currentTitle: "")
}

enum SessionDeletionMode: String, CaseIterable, Identifiable, Sendable {
    case appServer
    case trash

    var id: String { rawValue }

    var label: String {
        switch self {
        case .appServer: "通过 Codex 删除"
        case .trash: "移到废纸篓"
        }
    }

    var detail: String {
        switch self {
        case .appServer: "调用 app server 的 thread/delete，同时清理 rollout、元数据和派生子线程"
        case .trash: "直接把 rollout 文件和关联资产移到废纸篓，Codex 的索引可能仍保留记录"
        }
    }
}
