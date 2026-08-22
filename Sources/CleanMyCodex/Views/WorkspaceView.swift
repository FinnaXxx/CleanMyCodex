import AppKit
import SwiftUI

/// `~/Documents/Codex` is the one place the tool touches that holds work product rather
/// than Codex' own data. It gets its own screen, nothing is ever preselected, and folders
/// holding a git checkout with unpushed or uncommitted work are called out before anything
/// is trashed.
struct WorkspaceView: View {
    @EnvironmentObject private var model: AppModel
    @State private var expanded = Set<String>()
    @State private var showingCleanup = false

    private var snapshot: WorkspaceSnapshot { model.snapshot.workspace }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PageHeader(
                title: "工作产出",
                subtitle: "Codex 每次会话的工作目录和产出文件，按日期分组。"
            ) {
                SheetCloseButton()
            }

            NoticeBanner(
                text: "这里是你的成果，不是缓存：克隆的仓库、生成的文件、截图和导出物。"
                    + "默认一项都不勾选，自动清理永远不会碰这里。",
                symbol: "hand.raised",
                color: .cleanerAmber
            )

            summary

            if snapshot.isEmpty {
                ContentUnavailableView(
                    model.isScanning ? "正在扫描" : "没有找到工作产出目录",
                    systemImage: "folder",
                    description: Text(snapshot.root.path).font(.caption.monospaced())
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                tree
            }

            footer
        }
        .padding(24)
        .frame(minWidth: 900, idealWidth: 980, minHeight: 600, idealHeight: 700)
        .sheet(isPresented: $showingCleanup) {
            CleanupFlowSheet(
                title: "清理工作产出",
                confirmTitle: "把这些文件移到废纸篓？",
                confirmMessage: confirmMessage,
                rows: model.workspaceTargets.map {
                    CleanupPreviewRow(
                        id: $0.id,
                        title: $0.name,
                        detail: $0.url.path,
                        badge: $0.hasUnsafeRepository ? "有未保存的工作" : "\($0.totalFileCount) 个文件",
                        bytes: $0.bytes
                    )
                },
                confirmLabel: "移到废纸篓",
                isDestructive: true
            ) {
                model.cleanSelectedWorkspace()
            }
        }
    }

    private var summary: some View {
        CleanerCard {
            HStack(spacing: 24) {
                MetricBlock(
                    title: "总占用",
                    value: ByteFormat.string(snapshot.bytes),
                    detail: "\(snapshot.fileCount) 个文件 · \(snapshot.entries.count) 个日期"
                )
                Divider().frame(height: 60)
                MetricBlock(
                    title: "已选择",
                    value: ByteFormat.string(model.workspaceSelectedBytes),
                    detail: "\(model.workspaceTargets.count) 个目录",
                    emphasized: true
                )
                Divider().frame(height: 60)
                MetricBlock(
                    title: "git 仓库",
                    value: "\(snapshot.repositoryCount)",
                    detail: "有未提交或未推送内容的会单独标出"
                )
            }
        }
    }

    private var tree: some View {
        CleanerCard(padding: 0) {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(snapshot.entries) { entry in
                        WorkspaceRow(
                            entry: entry,
                            depth: 0,
                            isExpanded: expanded.contains(entry.id),
                            onToggleExpanded: { toggle(entry.id) }
                        )
                        if entry.children.isEmpty == false, expanded.contains(entry.id) {
                            ForEach(entry.children) { child in
                                WorkspaceRow(
                                    entry: child,
                                    depth: 1,
                                    isExpanded: false,
                                    onToggleExpanded: {}
                                )
                            }
                        }
                        Divider()
                    }
                }
            }
        }
        .frame(maxHeight: .infinity)
    }

    private var footer: some View {
        HStack(spacing: 14) {
            if model.workspaceHasUnsafeSelection {
                Label("所选内容里有未提交或未推送的 git 改动", systemImage: "exclamationmark.triangle.fill")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Color.cleanerAmber)
            } else {
                Text(snapshot.root.path)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            Button("取消选择") { model.clearWorkspaceSelection() }
                .disabled(model.selectedWorkspaceIDs.isEmpty)
            Button("移到废纸篓 · \(ByteFormat.string(model.workspaceSelectedBytes))") {
                showingCleanup = true
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .controlSize(.large)
            .disabled(model.workspaceTargets.isEmpty || model.isCleaning)
        }
    }

    private var confirmMessage: String {
        var message = "将把 \(model.workspaceTargets.count) 个目录移到废纸篓，"
            + "共 \(ByteFormat.string(model.workspaceSelectedBytes))。这些是你的工作产出，不是缓存。"
        if model.workspaceHasUnsafeSelection {
            message += "其中包含有未提交改动或未推送提交的 git 仓库——那些内容只存在本地，删除后无法从远端恢复。"
        }
        return message
    }

    private func toggle(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }
}

private struct WorkspaceRow: View {
    @EnvironmentObject private var model: AppModel
    let entry: WorkspaceEntry
    let depth: Int
    let isExpanded: Bool
    let onToggleExpanded: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            TriStateCheckbox(state: model.workspaceSelectionState(of: entry)) { selected in
                model.setWorkspaceSelected(entry, selected)
            }
            .frame(width: 24)

            Image(systemName: depth == 0 ? "calendar" : "folder")
                .foregroundStyle(.secondary)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(depth == 0 ? .headline : .callout.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 8) {
                    Text("\(entry.totalFileCount) 个文件")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    ForEach(entry.repositories) { repository in
                        StatusPill(
                            text: "\(repository.name) · \(repository.state.label)",
                            color: repository.state.isSafeToDelete ? .cleanerGreen : .cleanerAmber
                        )
                    }
                }
            }

            Spacer(minLength: 12)

            if entry.hasUnsafeRepository {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color.cleanerAmber)
                    .help("包含未提交或未推送的改动")
            }

            Text(ByteFormat.string(entry.bytes))
                .font(.body.weight(depth == 0 ? .semibold : .regular))
                .monospacedDigit()
                .frame(width: 92, alignment: .trailing)

            Button {
                NSWorkspace.shared.activateFileViewerSelecting([entry.url])
            } label: {
                Image(systemName: "folder")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .frame(width: 24, height: 24)
            .contentShape(Rectangle())

            if entry.children.isEmpty {
                Spacer().frame(width: 34)
            } else {
                Image(systemName: "chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 180 : 0))
                    .frame(width: 34, height: 30)
                    .contentShape(Rectangle())
                    .onTapGesture { onToggleExpanded() }
            }
        }
        .padding(.leading, 18 + CGFloat(depth) * 26)
        .padding(.trailing, 18)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}
