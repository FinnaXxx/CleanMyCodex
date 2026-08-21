import SwiftUI

struct OverviewView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selection = Set<StorageKind>([.temporary, .logs, .appCache])
    @State private var showingPreview = false

    private var candidates: [StorageItem] {
        model.snapshot.storageItems.filter(\.recommended)
    }

    private var selectedItems: [StorageItem] {
        candidates.filter { selection.contains($0.kind) }
    }

    private var selectedBytes: Int64 {
        selectedItems.reduce(0) { $0 + $1.bytes }
    }

    private var sessionBytes: Int64 {
        model.snapshot.sessions.reduce(0) { $0 + $1.totalBytes }
    }

    private var allSelected: Bool {
        !candidates.isEmpty && candidates.allSatisfy { selection.contains($0.kind) }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    PageHeader(title: "空间清理", subtitle: scanStatus, showsScanButton: true)

                    CleanerCard {
                        HStack(spacing: 26) {
                            MetricBlock(
                                title: "可清理",
                                value: ByteFormat.string(selectedBytes),
                                detail: "已选择 \(selectedItems.count) 项",
                                emphasized: true
                            )
                            Divider().frame(height: 72)
                            MetricBlock(
                                title: "Codex 数据",
                                value: ByteFormat.string(model.snapshot.totalCodexBytes),
                                detail: model.codexHome.lastPathComponent
                            )
                            Divider().frame(height: 72)
                            MetricBlock(
                                title: "会话",
                                value: ByteFormat.string(sessionBytes),
                                detail: "\(model.snapshot.sessions.count) 个"
                            )
                        }
                    }

                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("缓存与日志").font(.title2.bold())
                            Text("默认选择可重新生成的文件")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Toggle("全选", isOn: Binding(
                            get: { allSelected },
                            set: { enabled in
                                selection = enabled ? Set(candidates.map(\.kind)) : []
                            }
                        ))
                        .toggleStyle(.checkbox)
                    }

                    CleanerCard {
                        VStack(spacing: 0) {
                            ForEach(Array(candidates.enumerated()), id: \.element.id) { index, item in
                                CleanupItemRow(
                                    item: item,
                                    isSelected: Binding(
                                        get: { selection.contains(item.kind) },
                                        set: { enabled in
                                            if enabled { selection.insert(item.kind) }
                                            else { selection.remove(item.kind) }
                                        }
                                    )
                                )
                                if index < candidates.count - 1 { Divider() }
                            }
                        }
                    }
                }
                .padding(28)
            }

            Divider()
            HStack {
                Text(selection.isEmpty ? "未选择项目" : "已选择 \(selectedItems.count) 项")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("查看清理清单 · \(ByteFormat.string(selectedBytes))") {
                    showingPreview = true
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(selection.isEmpty || model.isScanning)
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 14)
            .background(.bar)
        }
        .sheet(isPresented: $showingPreview) {
            CleanupPreviewSheet(items: selectedItems)
        }
    }

    private var scanStatus: String {
        if model.isScanning { return "正在扫描…" }
        guard !model.snapshot.storageItems.isEmpty else { return model.codexHome.path }
        return "上次扫描 \(model.snapshot.scannedAt.formatted(date: .omitted, time: .shortened))"
    }
}

private struct MetricBlock: View {
    let title: String
    let value: String
    let detail: String
    var emphasized = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.callout).foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: emphasized ? 34 : 27, weight: .bold, design: .rounded))
                .foregroundStyle(emphasized ? Color.cleanerGreen : .primary)
                .monospacedDigit()
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct CleanupItemRow: View {
    let item: StorageItem
    @Binding var isSelected: Bool

    var body: some View {
        Toggle(isOn: $isSelected) {
            HStack(spacing: 14) {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color.cleanerGreen.opacity(0.12))
                    .frame(width: 42, height: 42)
                    .overlay {
                        Image(systemName: symbol)
                            .foregroundStyle(Color.cleanerGreen)
                    }
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title).font(.headline)
                    Text(item.detail).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                StatusPill(text: "可重建", color: .green)
                Text(ByteFormat.string(item.bytes))
                    .font(.body.weight(.semibold))
                    .monospacedDigit()
                    .frame(width: 88, alignment: .trailing)
            }
            .contentShape(Rectangle())
            .padding(.vertical, 11)
        }
        .toggleStyle(.checkbox)
    }

    private var symbol: String {
        switch item.kind {
        case .temporary: "clock.arrow.circlepath"
        case .logs: "doc.text"
        case .appCache: "safari"
        default: "shippingbox"
        }
    }
}

private struct CleanupPreviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let items: [StorageItem]

    private var total: Int64 { items.reduce(0) { $0 + $1.bytes } }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("清理清单").font(.title2.bold())
            Text("\(items.count) 项 · \(ByteFormat.string(total))")
                .foregroundStyle(.secondary)
            List(items) { item in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(item.title).font(.headline)
                        Spacer()
                        Text(ByteFormat.string(item.bytes)).monospacedDigit()
                    }
                    ForEach(item.paths, id: \.path) { path in
                        Text(path.path)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                .padding(.vertical, 5)
            }
            HStack {
                Spacer()
                Button("关闭") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 620, height: 460)
    }
}
