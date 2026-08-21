import SwiftUI

struct CleanupPreviewRow: Identifiable {
    let id: String
    let title: String
    let detail: String
    let badge: String
    let bytes: Int64
}

/// Confirm → run → report, without losing the sheet in between.
struct CleanupFlowSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    let title: String
    let confirmTitle: String
    let confirmMessage: String
    let rows: [CleanupPreviewRow]
    let confirmLabel: String
    let isDestructive: Bool
    let start: () -> Void

    @State private var started = false

    init(
        title: String,
        confirmTitle: String,
        confirmMessage: String,
        rows: [CleanupPreviewRow],
        confirmLabel: String,
        isDestructive: Bool = false,
        start: @escaping () -> Void
    ) {
        self.title = title
        self.confirmTitle = confirmTitle
        self.confirmMessage = confirmMessage
        self.rows = rows
        self.confirmLabel = confirmLabel
        self.isDestructive = isDestructive
        self.start = start
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let report = model.lastReport, started, !model.isCleaning {
                ReportView(report: report)
            } else if started {
                RunningView(progress: model.cleanupProgress)
            } else {
                ConfirmView(
                    title: confirmTitle,
                    message: confirmMessage,
                    rows: rows
                )
            }

            HStack {
                if !started {
                    Text("总计 \(ByteFormat.string(rows.reduce(Int64(0)) { $0 + $1.bytes }))")
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                Spacer()
                if started, !model.isCleaning {
                    Button("完成") { dismiss() }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                } else if started {
                    Button("正在清理…") {}
                        .disabled(true)
                } else {
                    Button("取消") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                    Button(confirmLabel) {
                        started = true
                        start()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(isDestructive ? .red : .accentColor)
                    .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(24)
        .frame(width: 660, height: 480)
        .navigationTitle(title)
        .interactiveDismissDisabled(model.isCleaning)
    }
}

private struct ConfirmView: View {
    let title: String
    let message: String
    let rows: [CleanupPreviewRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.title2.bold())
            Text(message)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            List(rows) { row in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(row.title).font(.headline)
                        Text(row.detail)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                    Spacer()
                    StatusPill(text: row.badge, color: .cleanerBlue)
                    Text(ByteFormat.string(row.bytes))
                        .monospacedDigit()
                        .frame(width: 90, alignment: .trailing)
                }
                .padding(.vertical, 4)
            }
            .listStyle(.inset)
            .frame(maxHeight: .infinity)
        }
    }
}

private struct RunningView: View {
    let progress: CleanupProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("正在清理").font(.title2.bold())
            ProgressView(value: progress.fraction)
                .progressViewStyle(.linear)
                .tint(.cleanerGreen)
            Text(progress.currentTitle.isEmpty ? "准备中…" : progress.currentTitle)
                .foregroundStyle(.secondary)
            Text("\(progress.completed)/\(progress.total)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ReportView: View {
    let report: CleanupReport

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: report.problems.isEmpty ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(report.problems.isEmpty ? Color.cleanerGreen : Color.cleanerAmber)
                VStack(alignment: .leading, spacing: 3) {
                    Text(report.summary).font(.title2.bold())
                    Text("共处理 \(report.outcomes.count) 项")
                        .foregroundStyle(.secondary)
                }
            }
            List(report.outcomes) { outcome in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(outcome.title).font(.headline)
                        if let message = outcome.status.message {
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer()
                    StatusPill(text: outcome.status.label, color: color(for: outcome.status))
                    Text(ByteFormat.string(outcome.freedBytes))
                        .monospacedDigit()
                        .frame(width: 90, alignment: .trailing)
                }
                .padding(.vertical, 4)
            }
            .listStyle(.inset)
            .frame(maxHeight: .infinity)
        }
    }

    private func color(for status: CleanupStatus) -> Color {
        switch status {
        case .succeeded: .cleanerGreen
        case .skipped: .cleanerAmber
        case .failed: .red
        }
    }
}
