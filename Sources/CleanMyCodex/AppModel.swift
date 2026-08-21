import Foundation

@MainActor
final class AppModel: ObservableObject {
    enum Page: String, CaseIterable, Identifiable {
        case overview = "空间清理"
        case sessions = "会话清理"
        case plugins = "老版本插件"
        case automation = "自动清理"

        var id: String { rawValue }

        var symbol: String {
            switch self {
            case .overview: "wand.and.stars"
            case .sessions: "bubble.left.and.bubble.right"
            case .plugins: "puzzlepiece.extension"
            case .automation: "calendar.badge.clock"
            }
        }
    }

    @Published var page: Page = .overview
    @Published var snapshot: ScanSnapshot
    @Published var isScanning = false
    @Published var errorMessage: String?

    let codexHome: URL

    init(codexHome: URL = AppModel.defaultCodexHome()) {
        self.codexHome = codexHome
        self.snapshot = .empty(at: codexHome)
    }

    func startInitialScan() {
        guard snapshot.storageItems.isEmpty, !isScanning else { return }
        scan()
    }

    func scan() {
        guard !isScanning else { return }
        isScanning = true
        errorMessage = nil
        let home = codexHome

        Task {
            do {
                let result = try await Task.detached(priority: .userInitiated) {
                    try CodexStorageScanner().scan(codexHome: home)
                }.value
                snapshot = result
            } catch {
                errorMessage = error.localizedDescription
            }
            isScanning = false
        }
    }

    private static func defaultCodexHome() -> URL {
        if let override = ProcessInfo.processInfo.environment["CODEX_HOME"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appending(path: ".codex", directoryHint: .isDirectory)
    }
}
