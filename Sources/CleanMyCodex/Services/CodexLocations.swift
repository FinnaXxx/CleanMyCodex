import Foundation

/// Every directory CleanMyCodex is allowed to look at, derived from a single Codex home.
struct CodexLocations: Sendable {
    let home: URL
    let library: URL

    init(home: URL, library: URL? = nil) {
        self.home = home.standardizedFileURL
        self.library = (library ?? FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library", directoryHint: .isDirectory)).standardizedFileURL
    }

    static func resolveHome(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let override = environment["CODEX_HOME"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true).standardizedFileURL
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appending(path: ".codex", directoryHint: .isDirectory)
            .standardizedFileURL
    }

    static func standard() -> CodexLocations {
        CodexLocations(home: resolveHome())
    }

    // MARK: - Inside ~/.codex

    var sessions: URL { home.appending(path: "sessions", directoryHint: .isDirectory) }
    var archivedSessions: URL { home.appending(path: "archived_sessions", directoryHint: .isDirectory) }
    var plugins: URL { home.appending(path: "plugins", directoryHint: .isDirectory) }
    var pluginCache: URL { plugins.appending(path: "cache", directoryHint: .isDirectory) }
    var temporary: URL { home.appending(path: ".tmp", directoryHint: .isDirectory) }
    var generatedImages: URL { home.appending(path: "generated_images", directoryHint: .isDirectory) }
    var visualizations: URL { home.appending(path: "visualizations", directoryHint: .isDirectory) }
    var computerUse: URL { home.appending(path: "computer-use", directoryHint: .isDirectory) }

    // MARK: - Outside ~/.codex

    var appSupport: URL { library.appending(path: "Application Support/Codex", directoryHint: .isDirectory) }
    var appCaches: [URL] {
        [
            library.appending(path: "Caches/Codex", directoryHint: .isDirectory),
            library.appending(path: "Caches/com.openai.codex", directoryHint: .isDirectory)
        ]
    }
    var appLogs: URL { library.appending(path: "Logs/com.openai.codex", directoryHint: .isDirectory) }

    /// Where CleanMyCodex keeps its own rescan cache. Never a cleanup target.
    var scanCache: URL { library.appending(path: "Caches/CleanMyCodex", directoryHint: .isDirectory) }

    /// Chromium-style caches that the desktop app rebuilds on demand.
    var browserCacheDirectories: [URL] {
        [
            "Default/Cache",
            "Default/Code Cache",
            "Default/DawnGraphiteCache",
            "Default/DawnWebGPUCache",
            "Default/GPUCache",
            "Default/Service Worker/CacheStorage",
            "Default/Service Worker/ScriptCache",
            "GPUCache",
            "ShaderCache",
            "GrShaderCache",
            "component_crx_cache",
            "extensions_crx_cache"
        ].map { appSupport.appending(path: $0, directoryHint: .isDirectory) }
    }

    /// Roots the cleanup engine will ever touch. Anything outside is rejected.
    var writableRoots: [URL] {
        [home, appSupport, appLogs] + appCaches
    }
}
