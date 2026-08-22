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
    /// Items that will be deferred unless Codex is closed first. Empty means nothing here
    /// needs exclusive access, and no restart choice is offered.
    let blockedTitles: [String]
    let start: () -> Void

    @State private var started = false

    init(
        title: String,
        confirmTitle: String,
        confirmMessage: String,
        rows: [CleanupPreviewRow],
        confirmLabel: String,
        isDestructive: Bool = false,
        blockedTitles: [String] = [],
        start: @escaping () -> Void
    ) {
        self.title = title
        self.confirmTitle = confirmTitle
        self.confirmMessage = confirmMessage
        self.rows = rows
        self.confirmLabel = confirmLabel
        self.isDestructive = isDestructive
        self.blockedTitles = blockedTitles
        self.start = start
    }

    /// Shown only when something in this batch needs Codex closed and Codex is up.
    @ViewBuilder
    private var restartChoice: some View {
        CleanerCard {
            VStack(alignment: .leading, spacing: 10) {
                Label(
                    "有 \(blockedTitles.count) 项需要 Codex 完全退出",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.callout.weight(.semibold))
                .foregroundStyle(Color.cleanerAmber)

                Text(blockedTitles.prefix(4).joined(separator: "、")
                    + (blockedTitles.count > 4 ? " 等" : ""))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if model.canRestartCodex {
                    Toggle(isOn: $model.restartCodexForCleanup) {
                        Text("先退出 Codex，清理完成后自动重新打开")
                    }
                    .toggleStyle(.checkbox)
                    Text("会像按 ⌘Q 一样请求退出，不会强制结束进程。有未保存内容而退不掉时会中止清理并告诉你。")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text((model.codexBlockerSummary ?? "Codex 正在运行")
                        + "。终端里的 codex 可能正在执行任务，不会被自动结束——"
                        + "请自己退出后再来一次。现在继续的话，这几项会推迟到下一次。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
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
                if !blockedTitles.isEmpty { restartChoice }
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
                    Button(model.restartStage ?? "正在清理…") {}
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
        .frame(width: 660, height: blockedTitles.isEmpty ? 480 : 620)
        .task { model.refreshEnvironment() }
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
