import SwiftUI

extension Color {
    static let cleanerGreen = Color(red: 0.13, green: 0.72, blue: 0.46)
    static let cleanerAmber = Color(red: 0.95, green: 0.62, blue: 0.16)
    static let cleanerBlue = Color(red: 0.20, green: 0.55, blue: 0.95)
}

extension CleanupRisk {
    var tint: Color {
        switch self {
        case .lossless: .cleanerGreen
        case .safe: .cleanerGreen
        case .rebuildable: .cleanerBlue
        case .caution: .cleanerAmber
        case .shielded: .secondary
        }
    }
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
            .navigationSplitViewColumnWidth(min: 196, ideal: 214)
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 6) {
                    Label(
                        model.codexRunning ? "Codex 正在运行" : "Codex 未运行",
                        systemImage: model.codexRunning ? "bolt.fill" : "moon.zzz"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(model.codexRunning ? Color.cleanerAmber : .secondary)

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
        .alert("出错了", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("好") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "未知错误")
        }
    }
}

struct PageHeader<Trailing: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var trailing: Trailing

    init(title: String, subtitle: String, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.largeTitle.bold())
                Text(subtitle).foregroundStyle(.secondary)
            }
            Spacer()
            trailing
        }
    }
}

extension PageHeader where Trailing == EmptyView {
    init(title: String, subtitle: String) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

struct CleanerCard<Content: View>: View {
    var padding: CGFloat = 18
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
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
            .background(color.opacity(0.13), in: Capsule())
    }
}

struct RiskBadge: View {
    let risk: CleanupRisk

    var body: some View {
        StatusPill(text: risk.label, color: risk.tint)
    }
}

/// macOS checkboxes are binary, but a category can be partially selected.
struct TriStateCheckbox: View {
    let state: SelectionState
    var isEnabled = true
    let onToggle: (Bool) -> Void

    var body: some View {
        Button {
            onToggle(state != .all)
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 15))
                .foregroundStyle(state == .none ? Color.secondary : Color.accentColor)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.35)
        .accessibilityLabel(state == .all ? "取消全选" : "全选")
    }

    private var symbol: String {
        switch state {
        case .none: "square"
        case .partial: "minus.square.fill"
        case .all: "checkmark.square.fill"
        }
    }
}

struct MetricBlock: View {
    let title: String
    let value: String
    let detail: String
    var emphasized = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.callout).foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: emphasized ? 34 : 26, weight: .bold, design: .rounded))
                .foregroundStyle(emphasized ? Color.cleanerGreen : .primary)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ScanProgressBar: View {
    let progress: ScanProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ProgressView(value: progress.fraction)
                .progressViewStyle(.linear)
                .tint(.cleanerGreen)
            HStack(spacing: 6) {
                Text(progress.stage.isEmpty ? "正在扫描" : "正在扫描 · \(progress.stage)")
                    .font(.caption.weight(.semibold))
                Text(progress.currentPath)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }
}

struct NoticeBanner: View {
    let text: String
    let symbol: String
    var color: Color = .cleanerAmber

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.callout)
            .foregroundStyle(color)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
