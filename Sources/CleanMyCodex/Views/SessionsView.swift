import SwiftUI

struct SessionsView: View {
    enum Scope: String, CaseIterable, Identifiable {
        case all = "全部"
        case active = "未归档"
        case archived = "已归档"
        var id: String { rawValue }
    }

    enum SortMode: String, CaseIterable, Identifiable {
        case total = "会话大小"
        case images = "图片占用"
        case date = "最近更新"
        var id: String { rawValue }
    }

    @EnvironmentObject private var model: AppModel
    @State private var scope: Scope = .all
    @State private var sortMode: SortMode = .total
    @State private var retentionDays = 180
    @State private var selected = Set<String>()
    @State private var showingPreview = false

    private var cutoff: Date {
        Calendar.current.date(byAdding: .day, value: -retentionDays, to: .now) ?? .distantPast
    }

    private var sessions: [SessionItem] {
        let scoped = model.snapshot.sessions.filter { item in
            switch scope {
            case .all: true
            case .active: item.location == .active
            case .archived: item.location == .archived
            }
        }
        return scoped.sorted { lhs, rhs in
            switch sortMode {
            case .total: lhs.totalBytes > rhs.totalBytes
            case .images: lhs.embeddedImageBytes > rhs.embeddedImageBytes
            case .date: lhs.modifiedAt > rhs.modifiedAt
            }
        }
    }

    private var oldSessions: [SessionItem] {
        sessions.filter { $0.modifiedAt < cutoff }
    }

    private var selectedBytes: Int64 {
        model.snapshot.sessions
            .filter { selected.contains($0.id) }
            .reduce(0) { $0 + $1.totalBytes }
    }

    private var allVisibleSelected: Bool {
        !sessions.isEmpty && sessions.allSatisfy { selected.contains($0.id) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            PageHeader(
                title: "会话清理",
                subtitle: "Archive 只隐藏会话，不释放空间。"
            )

            CleanerCard {
                HStack(spacing: 18) {
                    Picker("范围", selection: $scope) {
                        ForEach(Scope.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 270)

                    Picker("排序", selection: $sortMode) {
                        ForEach(SortMode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .frame(width: 170)

                    Stepper("\(retentionDays) 天前", value: $retentionDays, in: 7...1_825, step: 7)
                        .frame(width: 145)
                    Spacer()
                    Button("选择 \(retentionDays) 天前 · \(oldSessions.count) 项") {
                        selected = Set(oldSessions.map(\.id))
                    }
                }
            }

            CleanerCard {
                VStack(spacing: 0) {
                    HStack {
                        Toggle("", isOn: Binding(
                            get: { allVisibleSelected },
                            set: { enabled in
                                let visibleIDs = Set(sessions.map(\.id))
                                if enabled { selected.formUnion(visibleIDs) }
                                else { selected.subtract(visibleIDs) }
                            }
                        ))
                        .labelsHidden()
                        .toggleStyle(.checkbox)
                        .frame(width: 22)
                        Text("会话").frame(maxWidth: .infinity, alignment: .leading)
                        Text("状态").frame(width: 80, alignment: .leading)
                        Text("最后活动").frame(width: 105, alignment: .trailing)
                        Text("内嵌图片").frame(width: 105, alignment: .trailing)
                        Text("总占用").frame(width: 100, alignment: .trailing)
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 9)

                    Divider()

                    if sessions.isEmpty {
                        ContentUnavailableView(
                            model.isScanning ? "正在扫描会话" : "没有找到会话",
                            systemImage: model.isScanning ? "arrow.triangle.2.circlepath" : "bubble.left"
                        )
                        .frame(maxHeight: .infinity)
                    } else {
                        List(sessions) { session in
                            SessionRow(
                                session: session,
                                isSelected: Binding(
                                    get: { selected.contains(session.id) },
                                    set: { enabled in
                                        if enabled { selected.insert(session.id) }
                                        else { selected.remove(session.id) }
                                    }
                                )
                            )
                        }
                        .listStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: .infinity)

            HStack {
                Text("已选 \(selected.count) 项 · \(ByteFormat.string(selectedBytes))")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("取消选择") { selected.removeAll() }
                    .disabled(selected.isEmpty)
                Button("查看删除清单") { showingPreview = true }
                    .buttonStyle(.borderedProminent)
                    .disabled(selected.isEmpty)
            }
        }
        .padding(28)
        .sheet(isPresented: $showingPreview) {
            SessionDeletePreview(
                sessions: model.snapshot.sessions.filter { selected.contains($0.id) }
            )
        }
    }
}

private struct SessionRow: View {
    let session: SessionItem
    @Binding var isSelected: Bool

    var body: some View {
        HStack {
            Toggle("", isOn: $isSelected)
                .labelsHidden()
                .toggleStyle(.checkbox)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.displayName).font(.headline)
                Text(session.threadID)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if session.isCompressed || session.isUnstable || session.parseWarnings > 0 {
                    Text(warningText)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            StatusPill(
                text: session.location.rawValue,
                color: session.location == .archived ? .orange : .blue
            )
            .frame(width: 80, alignment: .leading)

            Text(session.modifiedAt, format: .dateTime.year().month().day())
                .foregroundStyle(.secondary)
                .frame(width: 105, alignment: .trailing)
            Text(ByteFormat.string(session.embeddedImageBytes))
                .monospacedDigit()
                .foregroundStyle(session.embeddedImageBytes > 0 ? .orange : .secondary)
                .help("\(session.embeddedImageCount) 张内嵌图片")
                .frame(width: 105, alignment: .trailing)
            Text(ByteFormat.string(session.totalBytes))
                .monospacedDigit()
                .frame(width: 100, alignment: .trailing)
        }
        .padding(.vertical, 5)
    }

    private var warningText: String {
        if session.isCompressed { return "压缩会话：暂未分析图片" }
        if session.isUnstable { return "扫描期间仍在写入，结果可能不完整" }
        return "包含 \(session.parseWarnings) 个解析警告"
    }
}

private struct SessionDeletePreview: View {
    @Environment(\.dismiss) private var dismiss
    let sessions: [SessionItem]

    private var total: Int64 { sessions.reduce(0) { $0 + $1.totalBytes } }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("删除清单").font(.title2.bold())
            Text("\(sessions.count) 个会话 · \(ByteFormat.string(total))")
                .foregroundStyle(.secondary)
            List(sessions) { session in
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(session.displayName).font(.headline)
                        Text(session.location.rawValue).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(ByteFormat.string(session.embeddedImageBytes))
                        .foregroundStyle(.orange)
                    Text(ByteFormat.string(session.totalBytes))
                        .frame(width: 90, alignment: .trailing)
                }
            }
            HStack {
                Spacer()
                Button("关闭") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 620, height: 460)
    }
}
