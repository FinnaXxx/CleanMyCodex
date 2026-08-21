import SwiftUI

@main
struct CleanMyCodexApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(.cleanerGreen)
                .frame(minWidth: 1_020, minHeight: 680)
                .task { model.startInitialScan() }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1_160, height: 780)
    }
}
