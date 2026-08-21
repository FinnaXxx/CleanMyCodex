import SwiftUI

struct AutomationView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeader(
                    title: "自动清理",
                    subtitle: "通过 macOS LaunchAgent 定期运行；Codex 正在运行时跳过，等下一次。"
                ) {
                    StatusPill(
                        text: model.automation.enabled ? model.automationStatus : "已关闭",
                        color: statusColor
                    )
                }

                CleanerCard {
                    VStack(alignment: .leading, spacing: 14) {
                        Toggle("定期自动清理", isOn: $model.automation.enabled)
                            .font(.headline)
                        HStack {
                            Text("每")
                            Stepper(
                                "\(model.automation.intervalDays) 天运行一次",
                                value: $model.automation.intervalDays,
                                in: 1...180
                            )
                            .fixedSize()
                            Spacer()
                            if let next = model.nextAutomaticRun {
                                Text("下次运行 \(next.formatted(date: .abbreviated, time: .shortened))")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        if let record = model.lastAutomaticRun {
                            Divider()
                            Label(lastRunText(record), systemImage: "clock.arrow.circlepath")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                CleanerCard {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("自动清理范围").font(.headline)
                        Text("会话删除需要单独明确授权，默认关闭。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Divider()
                        Toggle("缓存、日志数据库和过期临时文件", isOn: $model.automation.cleanCaches)
                        Toggle("老版本插件，只保留当前版本", isOn: $model.automation.cleanOldPlugins)
                        HStack {
                            Toggle("已归档会话", isOn: $model.automation.cleanArchivedSessions)
                            Stepper(
                                "保留 \(model.automation.archivedRetentionDays) 天",
                                value: $model.automation.archivedRetentionDays,
                                in: 7...1_825,
                                step: 7
                            )
                            .fixedSize()
                            .disabled(!model.automation.cleanArchivedSessions)
                            Spacer()
                        }
                        HStack {
                            Toggle("未归档会话", isOn: $model.automation.cleanActiveSessions)
                            Stepper(
                                "保留 \(model.automation.activeRetentionDays) 天",
                                value: $model.automation.activeRetentionDays,
                                in: 7...3_650,
                                step: 7
                            )
                            .fixedSize()
                            .disabled(!model.automation.cleanActiveSessions)
                            Spacer()
                        }
                    }
                }

                CleanerCard {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("安全规则").font(.headline)
                        Toggle("跳过 24 小时内活动过或正在写入的会话", isOn: $model.automation.skipRecentSessions)
                        Toggle("完成后显示通知", isOn: $model.automation.notifyWhenFinished)
                        Toggle("登录时打开 CleanMyCodex", isOn: $model.automation.launchAtLogin)
                        Divider()
                        Label(
                            "auth.json、config.toml、state_*.sqlite、rules、hooks、skills、memories、"
                                + "当前插件版本和 ~/Documents/Codex 永远不会被清理。",
                            systemImage: "lock.shield"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }

                HStack {
                    Text("修改后需要保存才会写入 LaunchAgent。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("保存设置") { model.applyAutomation() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                }
            }
            .padding(28)
        }
        .task { model.refreshAutomationStatus() }
    }

    private var statusColor: Color {
        guard model.automation.enabled else { return .secondary }
        return model.automationStatus == "已安装" ? .cleanerGreen : .cleanerAmber
    }

    private func lastRunText(_ record: AutomaticRunRecord) -> String {
        let time = record.finishedAt.formatted(date: .abbreviated, time: .shortened)
        if let reason = record.skippedReason {
            return "上次运行 \(time)：\(reason)，已跳过"
        }
        return "上次运行 \(time)：释放 \(ByteFormat.string(record.freedBytes))，"
            + "成功 \(record.succeeded) 项，未完成 \(record.failed) 项"
    }
}
