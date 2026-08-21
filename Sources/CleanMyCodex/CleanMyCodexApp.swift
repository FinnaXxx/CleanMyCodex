import Foundation
import SwiftUI

@main
struct CleanMyCodexMain {
    @MainActor
    static func main() {
        // The LaunchAgent starts the same binary with --auto-clean and never shows a window.
        if CommandLine.arguments.contains("--auto-clean") {
            exit(AutomaticCleanupRunner.run())
        }
        CleanMyCodexApp.main()
    }
}

struct CleanMyCodexApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(.cleanerGreen)
                .frame(minWidth: 1_060, minHeight: 700)
                .task { model.startInitialScan() }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1_180, height: 800)
        .commands {
            CommandGroup(after: .newItem) {
                Button("重新扫描") { model.scan() }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}
