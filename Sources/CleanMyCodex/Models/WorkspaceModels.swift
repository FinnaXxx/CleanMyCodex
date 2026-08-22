import Foundation

/// A git checkout found inside a workspace folder, and whether losing it would lose work.
struct WorkspaceRepository: Identifiable, Sendable, Hashable {
    enum State: String, Sendable {
        case clean
        case dirty
        case unpushed
        case unknown

        var label: String {
            switch self {
            case .clean: "已同步"
            case .dirty: "有未提交改动"
            case .unpushed: "有未推送提交"
            case .unknown: "状态未知"
            }
        }

        /// Anything but a clean, pushed checkout means deleting could lose work.
        var isSafeToDelete: Bool { self == .clean }
    }

    let url: URL
    let state: State

    var id: String { url.path }
    var name: String { url.lastPathComponent }
}

/// One folder under `~/Documents/Codex` — either a date, or a session inside a date.
struct WorkspaceEntry: Identifiable, Sendable {
    let url: URL
    let name: String
    let bytes: Int64
    let fileCount: Int
    let modifiedAt: Date
    let repositories: [WorkspaceRepository]
    let children: [WorkspaceEntry]

    var id: String { url.standardizedFileURL.path }

    /// True when something in here is not safely reproducible from a remote.
    var hasUnsafeRepository: Bool {
        repositories.contains { !$0.state.isSafeToDelete }
            || children.contains(where: \.hasUnsafeRepository)
    }

    var repositoryCount: Int {
        repositories.count + children.reduce(0) { $0 + $1.repositoryCount }
    }

    var totalFileCount: Int {
        fileCount + children.reduce(0) { $0 + $1.totalFileCount }
    }

    /// Every folder in this subtree, so a selection can be resolved to concrete targets.
    var flattened: [WorkspaceEntry] {
        [self] + children.flatMap(\.flattened)
    }
}

struct WorkspaceSnapshot: Sendable {
    let root: URL
    let entries: [WorkspaceEntry]
    /// False until the user asks for it: reading Documents costs a permission prompt.
    let isScanned: Bool

    init(root: URL, entries: [WorkspaceEntry], isScanned: Bool = true) {
        self.root = root
        self.entries = entries
        self.isScanned = isScanned
    }

    static func empty(at root: URL) -> WorkspaceSnapshot {
        WorkspaceSnapshot(root: root, entries: [], isScanned: false)
    }

    var bytes: Int64 { entries.reduce(Int64(0)) { $0 + $1.bytes } }
    var fileCount: Int { entries.reduce(0) { $0 + $1.totalFileCount } }
    var repositoryCount: Int { entries.reduce(0) { $0 + $1.repositoryCount } }
    var isEmpty: Bool { entries.isEmpty }
}
