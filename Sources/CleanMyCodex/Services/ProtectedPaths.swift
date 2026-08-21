import Foundation

enum CleanupGuardError: LocalizedError, Equatable {
    case protectedPath(String)
    case outsideCodexData(String)
    case rootDirectory(String)
    case missing(String)

    var errorDescription: String? {
        switch self {
        case let .protectedPath(path): "受保护的路径：\(path)"
        case let .outsideCodexData(path): "不在 Codex 数据目录内：\(path)"
        case let .rootDirectory(path): "不能整体删除数据目录：\(path)"
        case let .missing(path): "路径已不存在：\(path)"
        }
    }
}

/// The allow/deny list that every deletion goes through.
///
/// Everything here is deny-by-default: a path must sit inside one of the Codex data roots,
/// must not be a root itself, and must not match a protected entry.
struct ProtectedPaths: Sendable {
    let locations: CodexLocations
    /// Plugin versions Codex is currently running from.
    let activePluginDirectories: [URL]

    init(locations: CodexLocations, activePluginDirectories: [URL] = []) {
        self.locations = locations
        self.activePluginDirectories = activePluginDirectories.map(\.standardizedFileURL)
    }

    /// Relative names inside ~/.codex that hold credentials, configuration or user work.
    static let protectedHomeEntries = [
        "auth.json",
        "config.toml",
        "config.json",
        "version.json",
        "instructions.md",
        "AGENTS.md",
        "rules",
        "hooks",
        "skills",
        "memories",
        "prompts",
        "bin",
        "log"
    ]

    /// Prefixes of files inside ~/.codex that must never be trashed.
    static let protectedHomePrefixes = ["state_", "history"]

    /// Browser profile data that carries the Codex login.
    static let protectedAppSupportEntries = [
        "Default/Cookies",
        "Default/Login Data",
        "Default/Local Storage",
        "Default/Session Storage",
        "Default/IndexedDB",
        "Default/databases",
        "Default/Preferences",
        "Default/Web Data",
        "Local State",
        "WidevineCdm"
    ]

    var protectedURLs: [URL] {
        var urls = Self.protectedHomeEntries.map { locations.home.appending(path: $0) }
        urls += Self.protectedAppSupportEntries.map { locations.appSupport.appending(path: $0) }
        urls.append(FileManager.default.homeDirectoryForCurrentUser.appending(path: "Documents/Codex"))
        urls += activePluginDirectories
        return urls.map(\.standardizedFileURL)
    }

    func isProtected(_ url: URL) -> Bool {
        let target = url.standardizedFileURL
        if protectedURLs.contains(where: { Self.contains($0, target) }) { return true }

        // state_*.sqlite, state_*.sqlite-wal, history.jsonl … directly inside ~/.codex.
        if target.deletingLastPathComponent().standardizedFileURL == locations.home {
            let name = target.lastPathComponent
            if Self.protectedHomePrefixes.contains(where: { name.hasPrefix($0) }) { return true }
        }
        return false
    }

    func validate(_ url: URL) throws {
        let target = url.standardizedFileURL
        let roots = locations.writableRoots
        guard !roots.contains(where: { $0 == target }) else {
            throw CleanupGuardError.rootDirectory(target.path)
        }
        guard roots.contains(where: { Self.contains($0, target) }) else {
            throw CleanupGuardError.outsideCodexData(target.path)
        }
        guard !isProtected(target) else {
            throw CleanupGuardError.protectedPath(target.path)
        }
        // A symlink must not be able to point the engine somewhere else.
        let resolved = target.resolvingSymlinksInPath().standardizedFileURL
        if resolved != target {
            guard roots.contains(where: { Self.contains($0, resolved) }), !isProtected(resolved) else {
                throw CleanupGuardError.outsideCodexData(resolved.path)
            }
        }
    }

    /// True when `candidate` is `root` itself or lives below it.
    static func contains(_ root: URL, _ candidate: URL) -> Bool {
        let rootComponents = root.standardizedFileURL.pathComponents
        let candidateComponents = candidate.standardizedFileURL.pathComponents
        guard candidateComponents.count >= rootComponents.count else { return false }
        return Array(candidateComponents.prefix(rootComponents.count)) == rootComponents
    }
}
