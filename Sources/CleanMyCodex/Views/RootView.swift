import SwiftUI

extension Color {
    static let cleanerGreen = Color(red: 0.10, green: 0.62, blue: 0.37)
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationSplitView {
            List(AppModel.Page.allCases, selection: $model.page) { page in
                Label(page.rawValue, systemImage: page.symbol)
                    .tag(page)
                    .padding(.vertical, 4)
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210)
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("数据目录")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(model.codexHome.path)
                        .font(.caption.monospaced())
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } detail: {
            Group {
                switch model.page {
                case .overview: OverviewView()
                case .sessions: SessionsView()
                case .plugins: PluginsView()
                case .automation: AutomationView()
                }
            }
            .background(Color(nsColor: .windowBackgroundColor))
        }
        .alert("扫描失败", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("好") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "未知错误")
        }
    }
}

struct PageHeader: View {
    @EnvironmentObject private var model: AppModel
    let title: String
    let subtitle: String
    var showsScanButton = false

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.largeTitle.bold())
                Text(subtitle).foregroundStyle(.secondary)
            }
            Spacer()
            if showsScanButton {
                Button {
                    model.scan()
                } label: {
                    if model.isScanning {
                        ProgressView().controlSize(.small)
                        Text("扫描中…")
                    } else {
                        Label("重新扫描", systemImage: "arrow.clockwise")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isScanning)
            }
        }
    }
}

struct CleanerCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(18)
            .background(.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(.quaternary, lineWidth: 1)
            }
    }
}

struct StatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }
}
