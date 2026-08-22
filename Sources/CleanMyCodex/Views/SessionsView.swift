import AppKit
import SwiftUI

struct SessionsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingDelete = false
    @State private var showingSlim = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            filters

            if model.duplicateImageBytes > 0 {
                NoticeBanner(
                    text: "会话里内嵌了 \(ByteFormat.string(model.snapshot.embeddedImageBytes)) 的截图，"
                        + "其中 \(ByteFormat.string(model.duplicateImageBytes)) 是同一张图在多轮里被反复写回文件。"
                        + "「会话瘦身」可以在保留会话的前提下把重复的那部分换成占位图。",
                    symbol: "photo.on.rectangle.angled",
                    color: .cleanerBlue
                )
            } else if model.snapshot.embeddedImageBytes > 0 {
                NoticeBanner(
                    text: "会话里内嵌了 \(ByteFormat.string(model.snapshot.embeddedImageBytes)) 的截图，没有发现重复。",
                    symbol: "photo",
                    color: .cleanerBlue
                )
            }

            table
            footer
        }
        .padding(24)
        .frame(minWidth: 1_040, idealWidth: 1_140, minHeight: 640, idealHeight: 720)
        .sheet(isPresented: $showingSlim) {
            CleanupFlowSheet(
                title: "会话瘦身",
                confirmTitle: "改写所选会话？",
                confirmMessage: slimMessage,
                rows: model.slimTasks.map {
                    CleanupPreviewRow(
                        id: $0.id,
                        title: $0.title,
                        detail: $0.detail,
                        badge: model.sessionSlimMode == .deduplicate ? "去重" : "剥离",
                        bytes: $0.expectedBytes
                    )
                },
                confirmLabel: "确认改写",
                isDestructive: true,
                blockedTitles: model.blockedTasks(in: model.slimTasks).map(\.title)
            ) {
                model.slimSelectedSessions()
            }
        }
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

    private var header: some View {
        PageHeader(
            title: "会话记录",
            subtitle: "归档只是隐藏，不释放空间；这里统一列出全部会话。"
        ) {
            HStack(spacing: 10) {
                Button("选择 \(model.sessionRetentionDays) 天前 · \(model.expiredSessionCount) 项") {
                    model.selectExpiredSessions()
                }
                .disabled(model.expiredSessionIDs.isEmpty)
                SheetCloseButton()
            }
        }
    }

    private var filters: some View {
        CleanerCard {
            HStack(spacing: 14) {
                Picker("范围", selection: $model.sessionScope) {
                    ForEach(AppModel.SessionScope.allCases) { item in
                        Text("\(item.rawValue) \(model.count(of: item))").tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 300)

                Picker("排序", selection: $model.sessionSort) {
                    ForEach(AppModel.SessionSort.allCases) { Text($0.rawValue).tag($0) }
                }
                .labelsHidden()
                .frame(width: 150)

                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("搜索标题或项目", text: $model.sessionQuery)
                        .textFieldStyle(.plain)
                    if !model.sessionQuery.isEmpty {
                        Button {
                            model.sessionQuery = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .frame(minWidth: 180)

                Stepper("早于 \(model.sessionRetentionDays) 天", value: $model.sessionRetentionDays, in: 7...1_825, step: 7)
                    .fixedSize()
            }
        }
    }

    private var table: some View {
        CleanerCard(padding: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    TriStateCheckbox(state: model.visibleSessionSelectionState) { selected in
                        model.setSessionsSelected(model.visibleSessions.map(\.id), selected)
                    }
                    .frame(width: 22)
                    Text("会话").frame(maxWidth: .infinity, alignment: .leading)
                    Text("状态").frame(width: 72, alignment: .leading)
                    Text("最后活动").frame(width: 92, alignment: .trailing)
                    Text("会话文件").frame(width: 88, alignment: .trailing)
                    Text("内嵌图片").frame(width: 98, alignment: .trailing)
                    Text("总占用").frame(width: 88, alignment: .trailing)
                    Spacer().frame(width: 24)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
                .padding(.vertical, 10)

                Divider()

                if model.visibleSessions.isEmpty {
                    ContentUnavailableView(
                        emptyTitle,
                        systemImage: model.isScanning ? "arrow.triangle.2.circlepath" : "bubble.left"
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    // LazyVStack keeps the row count off the main thread's critical path:
                    // only the rows on screen are built, no matter how long the list is.
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(model.visibleSessions) { session in
                                SessionRow(
                                    session: session,
                                    isSelected: model.isSessionSelected(session.id),
                                    onSelect: { model.setSessionSelected(session.id, $0) }
                                )
                                .equatable()
                                Divider().padding(.leading, 18)
                            }
                        }
                    }
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
            Picker("瘦身方式", selection: $model.sessionSlimMode) {
                ForEach(SessionSlimMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .labelsHidden()
            .frame(width: 220)
            .help(model.sessionSlimMode.detail)

            Picker("删除方式", selection: $model.sessionDeletionMode) {
                ForEach(SessionDeletionMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .labelsHidden()
            .frame(width: 180)
            .disabled(!model.appServerAvailable)
            .help(model.sessionDeletionMode.detail)

            Button("取消选择") { model.clearSessionSelection() }
                .disabled(model.selectedSessionIDs.isEmpty)
            Button("瘦身 · \(ByteFormat.string(model.slimmableBytes))") { showingSlim = true }
                .disabled(model.slimTasks.isEmpty || model.isCleaning)
                .help("保留会话，只处理内嵌图片；正在被写入的会话会自动跳过")
            Button("删除所选会话") { showingDelete = true }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .controlSize(.large)
                .disabled(model.selectedSessionIDs.isEmpty || model.isCleaning)
        }
    }

    private var emptyTitle: String {
        if model.isScanning { return "正在扫描会话" }
        return model.sessionQuery.isEmpty ? "没有找到会话" : "没有匹配的会话"
    }

    private var slimMessage: String {
        let tasks = model.slimTasks
        var message = "将改写 \(tasks.count) 个会话文件，预计释放 \(ByteFormat.string(model.slimmableBytes))。"
        message += model.sessionSlimMode.detail
        message += "原文件会先移到废纸篓，改写结果通过行数和 JSON 校验后才替换；"
        message += "只有 data:image 字段被替换，其它字节逐字节原样复制。"
        if model.codexRunning {
            message += "Codex 正在运行也可以进行：正在被写入的那个会话会自动跳过，其余照常处理。"
        }
        return message
    }

    private var deleteMessage: String {
        let sessions = model.selectedSessions
        let images = sessions.reduce(Int64(0)) { $0 + $1.embeddedImageBytes }
        var message = "将删除 \(sessions.count) 个会话，预计释放 "
            + "\(ByteFormat.string(model.selectedSessionBytes))，其中内嵌图片 \(ByteFormat.string(images))。"
        switch model.sessionDeletionMode {
        case .appServer:
            message += "使用 codex app server 的 thread/delete，会一并清理元数据和派生子线程。"
        case .trash:
            message += model.appServerAvailable
                ? "会话文件和关联资产会移到废纸篓。"
                : "没有找到 codex 命令行，只能把会话文件和关联资产移到废纸篓。"
            // Only thread/delete updates Codex' own thread index; a plain file removal
            // leaves the row in state_*.sqlite pointing at a rollout that is gone.
            message += "注意：这种方式不会更新 Codex 的线程索引（state_*.sqlite），"
                + "会话可能仍然出现在 Codex 的历史列表里但打不开。"
        }
        return message
    }
}

/// A pure value row: no environment object, so scrolling never re-reads the model.
private struct SessionRow: View, Equatable {
    // `SessionRow` is a `View`, so it inherits `@MainActor` isolation. The `Equatable`
    // conformance needs a nonisolated `==`, which can only read nonisolated stored
    // properties — hence the `nonisolated` markers below. Both compared values are
    // Sendable (`SessionItem` is a value type, `Bool` is trivial), so this is safe.
    nonisolated let session: SessionItem
    nonisolated let isSelected: Bool
    let onSelect: (Bool) -> Void

    nonisolated static func == (lhs: SessionRow, rhs: SessionRow) -> Bool {
        lhs.session.id == rhs.session.id && lhs.isSelected == rhs.isSelected
    }

    var body: some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(get: { isSelected }, set: onSelect))
                .labelsHidden()
                .toggleStyle(.checkbox)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(session.displayName)
                        .font(.headline)
                        .lineLimit(1)
                        .foregroundStyle(session.hasTitle ? Color.primary : Color.secondary)
                    ForEach(session.tags, id: \.rawValue) { tag in
                        StatusPill(text: tag.label, color: tag == .imageHeavy ? .cleanerAmber : .cleanerBlue)
                    }
                }
                HStack(spacing: 6) {
                    if let project = session.projectName {
                        Label(project, systemImage: "folder")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Text(String(session.threadID.prefix(8)))
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                    if session.assetBytes > 0 {
                        Text("关联资产 \(ByteFormat.string(session.assetBytes))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if let warning {
                    Text(warning).font(.caption2).foregroundStyle(.orange)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            StatusPill(
                text: session.location.rawValue,
                color: session.location == .archived ? .cleanerAmber : .cleanerBlue
            )
            .frame(width: 72, alignment: .leading)

            Text(session.modifiedAt, format: .dateTime.year().month().day())
                .foregroundStyle(.secondary)
                .frame(width: 92, alignment: .trailing)
            Text(ByteFormat.string(session.fileBytes))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: 88, alignment: .trailing)
            VStack(alignment: .trailing, spacing: 1) {
                Text(ByteFormat.string(session.embeddedImageBytes))
                    .monospacedDigit()
                    .foregroundStyle(session.embeddedImageBytes > 0 ? Color.cleanerAmber : .secondary)
                if session.hasDuplicateImages {
                    Text("重复 \(ByteFormat.string(session.duplicateImageBytes))")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            .help("\(session.embeddedImageCount) 张内嵌图片（\(session.distinctImageCount) 张不重复），"
                + "占会话文件 \(Int(session.imageShare * 100))%")
            .frame(width: 98, alignment: .trailing)
            Text(ByteFormat.string(session.totalBytes))
                .font(.body.weight(.semibold))
                .monospacedDigit()
                .frame(width: 88, alignment: .trailing)

            Button {
                NSWorkspace.shared.activateFileViewerSelecting([session.fileURL])
            } label: {
                Image(systemName: "folder")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .frame(width: 24, height: 24)
            .contentShape(Rectangle())
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onTapGesture { onSelect(!isSelected) }
    }

    private var warning: String? {
        if session.isCompressed { return "压缩会话：没有分析内嵌图片" }
        if session.isUnstable { return "扫描期间仍在写入，可能是正在进行的会话" }
        if session.parseWarnings > 0 { return "\(session.parseWarnings) 个解析警告" }
        return nil
    }
}
