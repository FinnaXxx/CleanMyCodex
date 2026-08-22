import AppKit
import SwiftUI

struct OverviewView: View {
    @EnvironmentObject private var model: AppModel
    @State private var expanded = Set<String>()
    @State private var showingCleanup = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    banners
                    summary

                    group(.recommended)
                    sessionsCard
                    group(.review)
                    workspaceCard
                    group(.protectedData)
                }
                .padding(28)
            }

            Divider()
            actionBar
        }
        .sheet(isPresented: $showingCleanup) {
            CleanupFlowSheet(
                title: "清理缓存与临时文件",
                confirmTitle: "准备清理",
                confirmMessage: confirmMessage,
                rows: model.selectedEntries.map {
                    CleanupPreviewRow(
                        id: $0.id,
                        title: $0.title,
                        detail: $0.url.path,
                        badge: $0.method.label,
                        bytes: $0.reclaimableBytes
                    )
                },
                confirmLabel: "确认清理"
            ) {
                model.cleanSelectedStorage()
            }
        }
    }

    private var header: some View {
        PageHeader(title: "空间扫描", subtitle: subtitle) {
            HStack(spacing: 10) {
                StatusPill(
                    text: model.codexRunning ? "Codex 正在运行" : "Codex 未运行",
                    color: model.codexRunning ? .cleanerAmber : .secondary
                )

                Button {
                    model.activeSheet = .automation
                } label: {
                    Label("自动清理", systemImage: "calendar.badge.clock")
                }
                .help("设置定期自动清理")

                if model.isScanning {
                    Button("停止") { model.cancelScan() }
                } else {
                    Button {
                        model.scan()
                    } label: {
                        Label("重新扫描", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    @ViewBuilder
    private var banners: some View {
        if model.codexRunning {
            NoticeBanner(
                text: "Codex 正在运行。缓存、临时文件、旧插件和会话都可以照常清理；只有日志数据库压缩和会话瘦身需要独占文件，会推迟到 Codex 退出后。",
                symbol: "exclamationmark.triangle"
            )
        }
        ForEach(model.snapshot.notes, id: \.self) { note in
            NoticeBanner(text: note, symbol: "info.circle", color: .cleanerBlue)
        }
    }

    private var summary: some View {
        CleanerCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 24) {
                    MetricBlock(
                        title: "Codex 总占用",
                        value: ByteFormat.string(model.snapshot.totalCodexBytes),
                        detail: "含 Library 中的缓存与日志"
                    )
                    Divider().frame(height: 70)
                    MetricBlock(
                        title: "已选择",
                        value: ByteFormat.string(model.selectedBytes),
                        detail: "\(model.selectedEntryCount) 项 · 建议 \(ByteFormat.string(model.recommendedBytes))",
                        emphasized: true
                    )
                    Divider().frame(height: 70)
                    MetricBlock(
                        title: "会话数据",
                        value: ByteFormat.string(model.snapshot.sessionBytes),
                        detail: "\(model.snapshot.sessions.count) 个 · 内嵌图片 \(ByteFormat.string(model.snapshot.embeddedImageBytes))"
                    )
                }
                if model.isScanning {
                    ScanProgressBar(progress: model.scanProgress)
                }
            }
        }
    }

    // MARK: - Sessions

    /// Sessions are not a checkbox category: each one needs a title, tags and a size
    /// breakdown before it can be judged, so the card links into the full list.
    private var sessionsCard: some View {
        CleanerCard(padding: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 14) {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Color.cleanerBlue.opacity(0.13))
                        .frame(width: 38, height: 38)
                        .overlay {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .foregroundStyle(Color.cleanerBlue)
                        }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("会话记录").font(.headline)
                        Text("归档只是隐藏，不释放空间。删除会连同内嵌截图和生成的图片一起处理。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(ByteFormat.string(model.snapshot.sessionBytes))
                            .font(.body.weight(.semibold))
                            .monospacedDigit()
                        Text("\(model.snapshot.sessions.count) 个会话")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Button("管理会话") { model.activeSheet = .sessions }
                        .disabled(model.snapshot.sessions.isEmpty)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)

                if !model.snapshot.sessions.isEmpty {
                    Divider()
                    VStack(spacing: 0) {
                        ForEach(model.largestSessions(3)) { session in
                            CompactSessionRow(session: session)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    /// Work product, kept out of the checkbox groups on purpose: nothing here is ever
    /// preselected, and the scheduled run never touches it.
    @ViewBuilder
    private var workspaceCard: some View {
        let workspace = model.snapshot.workspace
        if !workspace.isEmpty {
            CleanerCard(padding: 0) {
                HStack(spacing: 14) {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Color.cleanerAmber.opacity(0.13))
                        .frame(width: 38, height: 38)
                        .overlay {
                            Image(systemName: "folder.badge.person.crop")
                                .foregroundStyle(Color.cleanerAmber)
                        }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("工作产出 · \(workspace.root.lastPathComponent)").font(.headline)
                        Text("会话的工作目录和产出文件，属于你的成果。默认不勾选，自动清理不会碰。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    if workspace.repositoryCount > 0 {
                        StatusPill(text: "\(workspace.repositoryCount) 个 git 仓库", color: .cleanerBlue)
                    }
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(ByteFormat.string(workspace.bytes))
                            .font(.body.weight(.semibold))
                            .monospacedDigit()
                        Text("\(workspace.fileCount) 个文件")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Button("查看并选择") { model.activeSheet = .workspace }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
            }
        }
    }

    // MARK: - Groups

    @ViewBuilder
    private func group(_ group: StorageGroup) -> some View {
        let categories = model.snapshot.categoryList(in: group)
        if !categories.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(group.title).font(.title2.bold())
                        Text(group.subtitle).font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(ByteFormat.string(categories.reduce(Int64(0)) { $0 + $1.reclaimableBytes }))
                        .font(.headline)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    if group != .protectedData {
                        TriStateCheckbox(state: state(of: group)) { selected in
                            model.setSelected(group: group, selected)
                        }
                    }
                }

                CleanerCard(padding: 0) {
                    VStack(spacing: 0) {
                        ForEach(Array(categories.enumerated()), id: \.element.id) { index, category in
                            CategoryRow(
                                category: category,
                                isExpanded: expanded.contains(category.id),
                                onToggleExpanded: { toggleExpanded(category.id) }
                            )
                            if index < categories.count - 1 { Divider() }
                        }
                    }
                }
            }
        }
    }

    private func state(of group: StorageGroup) -> SelectionState {
        let states = model.snapshot.categoryList(in: group)
            .filter(\.isSelectable)
            .map { model.selectionState(for: $0) }
        guard !states.isEmpty else { return .none }
        if states.allSatisfy({ $0 == .all }) { return .all }
        if states.allSatisfy({ $0 == .none }) { return .none }
        return .partial
    }

    private func toggleExpanded(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }

    private var actionBar: some View {
        HStack(spacing: 14) {
            Label("普通文件先移到废纸篓，数据库只做压缩", systemImage: "trash")
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
            Button("取消选择") { model.selectedEntryIDs.removeAll() }
                .disabled(model.selectedEntryIDs.isEmpty)
            Button("立即清理 · \(ByteFormat.string(model.selectedBytes))") {
                showingCleanup = true
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.selectedEntryIDs.isEmpty || model.isScanning || model.isCleaning)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 14)
        .background(.bar)
    }

    private var confirmMessage: String {
        let databases = model.selectedEntries.filter { $0.method == .compactDatabase }.count
        var message = "已选择 \(model.selectedEntryCount) 项，预计释放 \(ByteFormat.string(model.selectedBytes))。"
        if databases > 0 {
            message += "其中 \(databases) 个日志数据库会做 checkpoint 与 VACUUM，不会删除诊断记录。"
        }
        return message
    }

    private var subtitle: String {
        if model.isScanning { return "正在扫描…" }
        if model.snapshot.isEmpty { return model.codexHome.path }
        return "上次扫描 \(model.snapshot.scannedAt.formatted(date: .omitted, time: .shortened)) · \(model.codexHome.path)"
    }
}

private struct CompactSessionRow: View {
    let session: SessionItem

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "text.bubble")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.displayName)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                if let project = session.projectName {
                    Text(project).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 12)
            if session.embeddedImageBytes > 0 {
                Text("图片 \(ByteFormat.string(session.embeddedImageBytes))")
                    .font(.caption2)
                    .foregroundStyle(Color.cleanerAmber)
                    .monospacedDigit()
            }
            Text(ByteFormat.string(session.totalBytes))
                .font(.callout)
                .monospacedDigit()
                .frame(width: 92, alignment: .trailing)
        }
        .padding(.leading, 52)
        .padding(.trailing, 18)
        .padding(.vertical, 5)
    }
}

private struct CategoryRow: View {
    @EnvironmentObject private var model: AppModel
    let category: StorageCategory
    let isExpanded: Bool
    let onToggleExpanded: () -> Void

    @State private var isHovering = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                TriStateCheckbox(
                    state: model.selectionState(for: category),
                    isEnabled: category.isSelectable
                ) { selected in
                    model.setSelected(category, selected)
                }
                .frame(width: 26, height: 30)

                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(category.risk.tint.opacity(0.13))
                    .frame(width: 38, height: 38)
                    .overlay {
                        Image(systemName: category.symbol)
                            .foregroundStyle(category.risk.tint)
                    }

                VStack(alignment: .leading, spacing: 3) {
                    Text(category.title).font(.headline)
                    Text(category.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 12)

                if category.kind == .pluginRemnants {
                    Button("查看全部版本") { model.activeSheet = .plugins }
                        .buttonStyle(.link)
                        .font(.callout)
                }

                RiskBadge(risk: category.risk)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(ByteFormat.string(category.reclaimableBytes))
                        .font(.body.weight(.semibold))
                        .monospacedDigit()
                    if category.reclaimableBytes != category.bytes {
                        Text("共 \(ByteFormat.string(category.bytes))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 104, alignment: .trailing)

                // Deliberately generous: the chevron is the affordance, but the whole
                // row toggles, so the target is the row height, not a 12pt glyph.
                Image(systemName: "chevron.down")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(isHovering ? Color.accentColor : .secondary)
                    .rotationEffect(.degrees(isExpanded ? 180 : 0))
                    .frame(width: 34, height: 34)
                    .background(
                        Circle().fill(isHovering ? Color.primary.opacity(0.07) : .clear)
                    )
                    .accessibilityLabel(isExpanded ? "收起 \(category.title)" : "展开 \(category.title)")
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
            .onTapGesture { onToggleExpanded() }
            .onHover { isHovering = $0 }
            .background(isHovering ? Color.primary.opacity(0.03) : .clear)

            if isExpanded {
                if category.entries.isEmpty {
                    Text("没有可以列出的内容")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 70)
                        .padding(.bottom, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(category.entries) { entry in
                            EntryRow(entry: entry, isSelectable: category.isSelectable)
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
        }
    }
}

private struct EntryRow: View {
    @EnvironmentObject private var model: AppModel
    let entry: StorageEntry
    let isSelectable: Bool

    var body: some View {
        HStack(spacing: 12) {
            Toggle("", isOn: Binding(
                get: { model.isSelected(entry) },
                set: { model.setSelected(entry, $0) }
            ))
            .labelsHidden()
            .toggleStyle(.checkbox)
            .disabled(!isSelectable)
            .opacity(isSelectable ? 1 : 0.35)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title).font(.callout.weight(.medium)).lineLimit(1)
                Text(entry.detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 12)
            Text(ByteFormat.string(entry.reclaimableBytes))
                .font(.callout)
                .monospacedDigit()
                .frame(width: 92, alignment: .trailing)
            Button {
                NSWorkspace.shared.activateFileViewerSelecting([entry.url])
            } label: {
                Image(systemName: "folder")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help(entry.url.path)
            .frame(width: 24, height: 24)
            .contentShape(Rectangle())
        }
        .padding(.leading, 70)
        .padding(.trailing, 18)
        .padding(.vertical, 6)
    }
}
