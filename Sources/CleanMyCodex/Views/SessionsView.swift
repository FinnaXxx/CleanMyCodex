import AppKit
import SwiftUI

struct SessionsView: View {
    enum Scope: String, CaseIterable, Identifiable {
        case all = "全部"
        case archived = "已归档"
        case active = "未归档"
        var id: String { rawValue }
    }

    enum SortMode: String, CaseIterable, Identifiable {
        case total = "按占用从大到小"
        case images = "按内嵌图片排序"
        case date = "按最后活动排序"
        var id: String { rawValue }
    }

    @EnvironmentObject private var model: AppModel
    @State private var scope: Scope = .all
    @State private var sortMode: SortMode = .total
    @State private var retentionDays = 180
    @State private var showingDelete = false

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

    private var expiredSessions: [SessionItem] {
        sessions.filter { $0.modifiedAt < cutoff && !$0.isUnstable }
    }

    private var visibleSelectionState: SelectionState {
        let ids = Set(sessions.map(\.id))
        guard !ids.isEmpty else { return .none }
        let chosen = ids.intersection(model.selectedSessionIDs)
        if chosen.isEmpty { return .none }
        return chosen.count == ids.count ? .all : .partial
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PageHeader(
                title: "会话清理",
                subtitle: "归档只是隐藏，不释放空间；这里统一列出全部会话。"
            ) {
                Button("选择 \(retentionDays) 天前 · \(expiredSessions.count) 项") {
                    model.selectedSessionIDs.formUnion(expiredSessions.map(\.id))
                }
                .disabled(expiredSessions.isEmpty)
            }

            filters

            if model.snapshot.embeddedImageBytes > 0 {
                NoticeBanner(
                    text: "会话里内嵌了 \(ByteFormat.string(model.snapshot.embeddedImageBytes)) 的截图。"
                        + "工具不会改写 JSONL 里的图片字段，避免破坏会话恢复和线程引用。",
                    symbol: "photo",
                    color: .cleanerBlue
                )
            }

            table

            footer
        }
        .padding(28)
        .sheet(isPresented: $showingDelete) {
            CleanupFlowSheet(
                title: "删除会话",
                confirmTitle: "删除所选会话？",
                confirmMessage: deleteMessage,
                rows: model.selectedSessions.map {
                    CleanupPreviewRow(
                        id: $0.id,
                        title: $0.displayName,
                        detail: $0.fileURL.path,
                        badge: $0.location.rawValue,
                        bytes: $0.totalBytes
                    )
                },
                confirmLabel: "确认删除",
                isDestructive: true
            ) {
                model.deleteSelectedSessions()
            }
        }
    }

    private var filters: some View {
        CleanerCard {
            HStack(spacing: 16) {
                Picker("范围", selection: $scope) {
                    ForEach(Scope.allCases) { item in
                        Text("\(item.rawValue) \(count(for: item))").tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 320)

                Picker("排序", selection: $sortMode) {
                    ForEach(SortMode.allCases) { Text($0.rawValue).tag($0) }
                }
                .labelsHidden()
                .frame(width: 190)

                Stepper("最后活动早于 \(retentionDays) 天", value: $retentionDays, in: 7...1_825, step: 7)
                    .fixedSize()
                Spacer()
            }
        }
    }

    private var table: some View {
        CleanerCard(padding: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    TriStateCheckbox(state: visibleSelectionState) { selected in
                        let ids = Set(sessions.map(\.id))
                        if selected {
                            model.selectedSessionIDs.formUnion(ids)
                        } else {
                            model.selectedSessionIDs.subtract(ids)
                        }
                    }
                    .frame(width: 22)
                    Text("会话").frame(maxWidth: .infinity, alignment: .leading)
                    Text("状态").frame(width: 84, alignment: .leading)
                    Text("最后活动").frame(width: 96, alignment: .trailing)
                    Text("会话文件").frame(width: 92, alignment: .trailing)
                    Text("内嵌图片").frame(width: 102, alignment: .trailing)
                    Text("总占用").frame(width: 92, alignment: .trailing)
                    Spacer().frame(width: 24)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
                .padding(.vertical, 10)

                Divider()

                if sessions.isEmpty {
                    ContentUnavailableView(
                        model.isScanning ? "正在扫描会话" : "没有找到会话",
                        systemImage: model.isScanning ? "arrow.triangle.2.circlepath" : "bubble.left"
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(sessions) { session in
                        SessionRow(
                            session: session,
                            isSelected: Binding(
                                get: { model.selectedSessionIDs.contains(session.id) },
                                set: { enabled in
                                    if enabled {
                                        model.selectedSessionIDs.insert(session.id)
                                    } else {
                                        model.selectedSessionIDs.remove(session.id)
                                    }
                                }
                            )
                        )
                        .listRowInsets(EdgeInsets(top: 4, leading: 18, bottom: 4, trailing: 18))
                    }
                    .listStyle(.plain)
                }
            }
        }
        .frame(maxHeight: .infinity)
    }

    private var footer: some View {
        HStack(spacing: 14) {
            Text("已选 \(model.selectedSessionIDs.count) 项 · \(ByteFormat.string(model.selectedSessionBytes))")
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Spacer()
            Picker("删除方式", selection: $model.sessionDeletionMode) {
                ForEach(SessionDeletionMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .labelsHidden()
            .frame(width: 180)
            .disabled(!model.appServerAvailable)
            .help(model.sessionDeletionMode.detail)

            Button("取消选择") { model.selectedSessionIDs.removeAll() }
                .disabled(model.selectedSessionIDs.isEmpty)
            Button("删除所选会话") { showingDelete = true }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .controlSize(.large)
                .disabled(model.selectedSessionIDs.isEmpty || model.isCleaning)
        }
    }

    private func count(for scope: Scope) -> Int {
        switch scope {
        case .all: model.snapshot.sessions.count
        case .active: model.snapshot.sessions.filter { $0.location == .active }.count
        case .archived: model.snapshot.sessions.filter { $0.location == .archived }.count
        }
    }

    private var deleteMessage: String {
        let images = model.selectedSessions.reduce(Int64(0)) { $0 + $1.embeddedImageBytes }
        var message = "将删除 \(model.selectedSessions.count) 个会话，预计释放 "
            + "\(ByteFormat.string(model.selectedSessionBytes))，其中内嵌图片 \(ByteFormat.string(images))。"
        switch model.sessionDeletionMode {
        case .appServer:
            message += "使用 codex app server 的 thread/delete，会一并清理元数据和派生子线程。"
        case .trash:
            message += model.appServerAvailable
                ? "会话文件和关联资产会移到废纸篓。"
                : "没有找到 codex 命令行，只能把会话文件和关联资产移到废纸篓。"
        }
        return message
    }
}

private struct SessionRow: View {
    let session: SessionItem
    @Binding var isSelected: Bool

    var body: some View {
        HStack(spacing: 10) {
            Toggle("", isOn: $isSelected)
                .labelsHidden()
                .toggleStyle(.checkbox)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(session.displayName).font(.headline).lineLimit(1)
                    ForEach(session.tags, id: \.rawValue) { tag in
                        StatusPill(text: tag.label, color: tag == .imageHeavy ? .cleanerAmber : .cleanerBlue)
                    }
                }
                Text(subtitle)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let warning {
                    Text(warning).font(.caption2).foregroundStyle(.orange)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            StatusPill(
                text: session.location.rawValue,
                color: session.location == .archived ? .cleanerAmber : .cleanerBlue
            )
            .frame(width: 84, alignment: .leading)

            Text(session.modifiedAt, format: .dateTime.year().month().day())
                .foregroundStyle(.secondary)
                .frame(width: 96, alignment: .trailing)
            Text(ByteFormat.string(session.fileBytes))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: 92, alignment: .trailing)
            Text(ByteFormat.string(session.embeddedImageBytes))
                .monospacedDigit()
                .foregroundStyle(session.embeddedImageBytes > 0 ? Color.cleanerAmber : .secondary)
                .help("\(session.embeddedImageCount) 张内嵌图片，占会话文件 \(Int(session.imageShare * 100))%")
                .frame(width: 102, alignment: .trailing)
            Text(ByteFormat.string(session.totalBytes))
                .font(.body.weight(.semibold))
                .monospacedDigit()
                .frame(width: 92, alignment: .trailing)

            Button {
                NSWorkspace.shared.activateFileViewerSelecting([session.fileURL])
            } label: {
                Image(systemName: "folder")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .frame(width: 24)
        }
        .padding(.vertical, 4)
    }

    private var subtitle: String {
        var parts = [String(session.threadID.prefix(8))]
        if let workingDirectory = session.workingDirectory, !workingDirectory.isEmpty {
            parts.append(workingDirectory)
        }
        if session.assetBytes > 0 {
            parts.append("关联资产 \(ByteFormat.string(session.assetBytes))")
        }
        return parts.joined(separator: " · ")
    }

    private var warning: String? {
        if session.isCompressed { return "压缩会话：没有分析内嵌图片" }
        if session.isUnstable { return "扫描期间仍在写入，可能是正在进行的会话" }
        if session.parseWarnings > 0 { return "\(session.parseWarnings) 个解析警告" }
        return nil
    }
}
