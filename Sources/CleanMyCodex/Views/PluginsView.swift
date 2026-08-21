import AppKit
import SwiftUI

struct PluginsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingCleanup = false

    private var groups: [(key: String, value: [PluginVersionItem])] {
        Dictionary(grouping: model.snapshot.pluginVersions, by: \.groupKey)
            .map { (key: $0.key, value: $0.value.sorted { $0.modifiedAt > $1.modifiedAt }) }
            .sorted { lhs, rhs in
                let lhsBytes = lhs.value.reduce(Int64(0)) { $0 + $1.bytes }
                let rhsBytes = rhs.value.reduce(Int64(0)) { $0 + $1.bytes }
                return lhsBytes > rhsBytes
            }
    }

    private var removableBytes: Int64 {
        model.selectedPlugins.reduce(Int64(0)) { $0 + $1.bytes }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PageHeader(
                title: "插件版本",
                subtitle: "当前启用的版本始终受保护，只清理旧版本和卸载残留。"
            ) {
                Button("选择全部可清理版本") {
                    model.selectedPluginIDs = Set(model.removablePlugins.map(\.id))
                }
                .disabled(model.removablePlugins.isEmpty)
            }

            if !model.appServerAvailable {
                NoticeBanner(
                    text: "没有找到 codex 命令行，无法通过 plugin/list 确认当前版本，因此所有版本都不可清理。",
                    symbol: "exclamationmark.shield"
                )
            }

            ScrollView {
                LazyVStack(spacing: 14) {
                    ForEach(groups, id: \.key) { group in
                        CleanerCard {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack {
                                    Image(systemName: "puzzlepiece.extension.fill")
                                        .foregroundStyle(.purple)
                                    Text(group.key).font(.headline)
                                    Spacer()
                                    Text("\(group.value.count) 个版本 · \(ByteFormat.string(group.value.reduce(Int64(0)) { $0 + $1.bytes }))")
                                        .foregroundStyle(.secondary)
                                        .monospacedDigit()
                                }
                                Divider()
                                ForEach(group.value) { item in
                                    PluginRow(item: item)
                                }
                            }
                        }
                    }
                    if model.snapshot.pluginVersions.isEmpty {
                        ContentUnavailableView(
                            model.isScanning ? "正在扫描插件" : "没有找到本地插件",
                            systemImage: "puzzlepiece.extension"
                        )
                        .padding(.top, 40)
                    }
                }
            }

            HStack {
                Text(model.selectedPlugins.isEmpty
                    ? "可清理 \(model.removablePlugins.count) 个版本"
                    : "已选择 \(model.selectedPlugins.count) 个版本 · \(ByteFormat.string(removableBytes))")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("打开插件目录") {
                    NSWorkspace.shared.open(model.locations.plugins)
                }
                Button("清理所选版本") { showingCleanup = true }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(model.selectedPlugins.isEmpty || model.isCleaning)
            }
        }
        .padding(28)
        .sheet(isPresented: $showingCleanup) {
            CleanupFlowSheet(
                title: "清理老版本插件",
                confirmTitle: "清理老版本插件",
                confirmMessage: "将清理 \(model.selectedPlugins.count) 个非当前版本，预计释放 "
                    + "\(ByteFormat.string(removableBytes))。当前启用的版本和 .plugin-appserver 不会受影响。",
                rows: model.selectedPlugins.map {
                    CleanupPreviewRow(
                        id: $0.id,
                        title: "\($0.plugin) · \($0.version)",
                        detail: $0.directoryURL.path,
                        badge: $0.status.label,
                        bytes: $0.bytes
                    )
                },
                confirmLabel: "确认清理"
            ) {
                model.cleanSelectedPlugins()
            }
        }
    }
}

private struct PluginRow: View {
    @EnvironmentObject private var model: AppModel
    let item: PluginVersionItem

    var body: some View {
        HStack(spacing: 12) {
            Toggle("", isOn: Binding(
                get: { model.selectedPluginIDs.contains(item.id) },
                set: { enabled in
                    if enabled {
                        model.selectedPluginIDs.insert(item.id)
                    } else {
                        model.selectedPluginIDs.remove(item.id)
                    }
                }
            ))
            .labelsHidden()
            .toggleStyle(.checkbox)
            .disabled(!item.status.isRemovable)
            .opacity(item.status.isRemovable ? 1 : 0.35)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.version).font(.body.monospaced())
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            StatusPill(text: item.status.label, color: color)
            Text(ByteFormat.string(item.bytes))
                .monospacedDigit()
                .frame(width: 92, alignment: .trailing)
            Button {
                NSWorkspace.shared.activateFileViewerSelecting([item.directoryURL])
            } label: {
                Image(systemName: "folder")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
    }

    private var detail: String {
        var parts = ["最后改动 \(item.modifiedAt.formatted(date: .numeric, time: .omitted))"]
        if item.environmentBytes > 0 {
            parts.append("含 Python 运行环境 \(ByteFormat.string(item.environmentBytes))")
        }
        return parts.joined(separator: " · ")
    }

    private var color: Color {
        switch item.status {
        case .current: .cleanerGreen
        case .outdated: .cleanerAmber
        case .orphaned: .red
        case .unconfirmed: .secondary
        }
    }
}
