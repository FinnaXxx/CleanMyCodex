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
                    group(.review)
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
                text: "Codex 正在运行。缓存可以照常清理，日志数据库的压缩会自动跳过。",
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
                        detail: "\(model.selectedEntries.count) 项 · 建议 \(ByteFormat.string(model.recommendedBytes))",
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
                    Text(ByteFormat.string(categories.reduce(0) { $0 + $1.reclaimableBytes }))
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
            .disabled(model.selectedEntries.isEmpty || model.isScanning || model.isCleaning)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 14)
        .background(.bar)
    }

    private var confirmMessage: String {
        let databases = model.selectedEntries.filter { $0.method == .compactDatabase }.count
        var message = "已选择 \(model.selectedEntries.count) 项，预计释放 \(ByteFormat.string(model.selectedBytes))。"
        if databases > 0 {
            message += "其中 \(databases) 个日志数据库会做 checkpoint 与 VACUUM，不会删除诊断记录。"
        }
        return message
    }

    private var subtitle: String {
        if model.isScanning { return "正在扫描…" }
        if model.snapshot.isEmpty { return model.codexHome.path }
        return "上次扫描 \(model.snapshot.scannedAt.formatted(date: .omitted, time: .shortened))"
    }
}

private struct CategoryRow: View {
    @EnvironmentObject private var model: AppModel
    let category: StorageCategory
    let isExpanded: Bool
    let onToggleExpanded: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                TriStateCheckbox(
                    state: model.selectionState(for: category),
                    isEnabled: category.isSelectable
                ) { selected in
                    model.setSelected(category, selected)
                }

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

                Button(action: onToggleExpanded) {
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .frame(width: 20)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .contentShape(Rectangle())

            if isExpanded {
                VStack(spacing: 0) {
                    ForEach(category.entries) { entry in
                        EntryRow(entry: entry, isSelectable: category.isSelectable)
                    }
                }
                .padding(.bottom, 8)
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
                Text(entry.title).font(.callout.weight(.medium))
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
            .frame(width: 20)
        }
        .padding(.leading, 70)
        .padding(.trailing, 18)
        .padding(.vertical, 6)
    }
}
