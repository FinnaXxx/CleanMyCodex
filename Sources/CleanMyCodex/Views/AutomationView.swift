import SwiftUI

struct AutomationView: View {
    @AppStorage("automaticCleanupEnabled") private var automaticCleanupEnabled = false
    @AppStorage("launchAtLogin") private var launchAtLogin = false
    @AppStorage("cleanupIntervalDays") private var cleanupIntervalDays = 30
    @AppStorage("cleanCaches") private var cleanCaches = true
    @AppStorage("cleanOldPlugins") private var cleanOldPlugins = true
    @AppStorage("cleanArchivedSessions") private var cleanArchivedSessions = false
    @AppStorage("cleanActiveSessions") private var cleanActiveSessions = false
    @AppStorage("archivedRetentionDays") private var archivedRetentionDays = 180
    @AppStorage("activeRetentionDays") private var activeRetentionDays = 365

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeader(
                    title: "自动清理",
                    subtitle: "按设定的保留时间定期清理"
                )

                CleanerCard {
                    VStack(alignment: .leading, spacing: 14) {
                        Toggle("定期自动清理", isOn: $automaticCleanupEnabled)
                            .font(.headline)
                        HStack {
                            Text("每")
                            TextField("30", value: $cleanupIntervalDays, format: .number)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 70)
                            Text("天运行一次")
                            Spacer()
                            StatusPill(
                                text: automaticCleanupEnabled ? "待安装" : "已关闭",
                                color: automaticCleanupEnabled ? .orange : .secondary
                            )
                        }
                    }
                }

                CleanerCard {
                    VStack(spacing: 14) {
                        RuleToggle(title: "缓存与过期临时文件", subtitle: "缓存、日志和 .tmp", isOn: $cleanCaches)
                        Divider()
                        RuleToggle(title: "旧版本插件", subtitle: "保留当前版本和一个回退版本", isOn: $cleanOldPlugins)
                        Divider()
                        RuleToggle(title: "归档会话", subtitle: "单独设置保留时间", isOn: $cleanArchivedSessions) {
                            Stepper("保留 \(archivedRetentionDays) 天", value: $archivedRetentionDays, in: 30...1_825, step: 30)
                        }
                        Divider()
                        RuleToggle(title: "未归档会话", subtitle: "保护置顶和运行中的会话", isOn: $cleanActiveSessions) {
                            Stepper("保留 \(activeRetentionDays) 天", value: $activeRetentionDays, in: 30...3_650, step: 30)
                        }
                    }
                }

                CleanerCard {
                    Toggle("登录时打开 CleanMyCodex", isOn: $launchAtLogin)
                        .font(.headline)
                }

            }
            .padding(28)
        }
    }
}

private struct RuleToggle<Accessory: View>: View {
    let title: String
    let subtitle: String
    @Binding var isOn: Bool
    @ViewBuilder var accessory: () -> Accessory

    init(
        title: String,
        subtitle: String,
        isOn: Binding<Bool>,
        @ViewBuilder accessory: @escaping () -> Accessory
    ) {
        self.title = title
        self.subtitle = subtitle
        self._isOn = isOn
        self.accessory = accessory
    }

    var body: some View {
        HStack {
            Toggle(isOn: $isOn) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.headline)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            accessory().disabled(!isOn)
        }
    }
}

private extension RuleToggle where Accessory == EmptyView {
    init(title: String, subtitle: String, isOn: Binding<Bool>) {
        self.init(title: title, subtitle: subtitle, isOn: isOn) { EmptyView() }
    }
}
