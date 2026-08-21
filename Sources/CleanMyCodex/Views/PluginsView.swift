import AppKit
import SwiftUI

struct PluginsView: View {
    @EnvironmentObject private var model: AppModel

    private var groups: [(key: String, value: [PluginVersionItem])] {
        Dictionary(grouping: model.snapshot.pluginVersions, by: { "\($0.plugin)@\($0.marketplace)" })
            .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            PageHeader(
                title: "老版本插件",
                subtitle: "共 \(model.snapshot.pluginVersions.count) 个本地版本"
            )

            Label(
                "当前版本未确认时不提供清理。",
                systemImage: "exclamationmark.shield"
            )
            .foregroundStyle(.secondary)

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
                                    Text("\(group.value.count) 个版本")
                                        .foregroundStyle(.secondary)
                                }
                                Divider()
                                ForEach(group.value) { item in
                                    HStack {
                                        Text(item.version).font(.body.monospaced())
                                        StatusPill(text: "本地", color: .secondary)
                                        Spacer()
                                        Text(ByteFormat.string(item.bytes)).monospacedDigit()
                                        Button("显示") {
                                            NSWorkspace.shared.activateFileViewerSelecting([item.directoryURL])
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            HStack {
                Text("共 \(model.snapshot.pluginVersions.count) 个本地版本")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("打开插件目录") {
                    NSWorkspace.shared.open(model.codexHome.appending(path: "plugins/cache"))
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(28)
    }
}
