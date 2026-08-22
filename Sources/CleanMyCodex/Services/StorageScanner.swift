import CryptoKit
import Foundation

struct CodexStorageScanner: Sendable {
    let chunkSize: Int
    let libraryDirectory: URL?
    let documentsDirectory: URL?
    /// Temporary entries younger than this are assumed to belong to a running task.
    let temporaryGraceDays: Int
    /// Application logs younger than this are kept so Codex can still report on recent runs.
    let logRetentionDays: Int

    init(
        chunkSize: Int = 1_048_576,
        libraryDirectory: URL? = nil,
        documentsDirectory: URL? = nil,
        temporaryGraceDays: Int = 3,
        logRetentionDays: Int = 10
    ) {
        self.chunkSize = max(4, chunkSize)
        self.libraryDirectory = libraryDirectory
        self.documentsDirectory = documentsDirectory
        self.temporaryGraceDays = temporaryGraceDays
        self.logRetentionDays = logRetentionDays
    }

    /// How long an upgrade leftover has to sit still before it counts as abandoned.
    static let leftoverGraceSeconds: TimeInterval = 3_600

    static func idleDescription(since date: Date) -> String {
        let hours = Date().timeIntervalSince(date) / 3_600
        if hours >= 48 { return "\(Int(hours / 24)) 天" }
        if hours >= 1 { return "\(Int(hours)) 小时" }
        return "不到 1 小时"
    }

    func locations(for codexHome: URL) -> CodexLocations {
        CodexLocations(home: codexHome, library: libraryDirectory, documents: documentsDirectory)
    }

    func scan(
        codexHome: URL,
        installedPlugins: [InstalledPlugin]? = nil,
        progress: @Sendable @escaping (ScanProgress) -> Void = { _ in }
    ) throws -> ScanSnapshot {
        let places = locations(for: codexHome)
        let reporter = ProgressReporter(emit: progress)
        var notes: [String] = []

        let guards = ProtectedPaths(locations: places)

        reporter.enter(stage: "缓存与临时文件", base: 0, span: 0.18)
        let temporaryItems = temporaryCategories(in: places, guards: guards, reporter: reporter)
        let cacheItems = cacheCategories(in: places, reporter: reporter)

        reporter.enter(stage: "日志数据库", base: 0.18, span: 0.07)
        let (logCategory, logNotes) = logDatabaseCategory(in: places, reporter: reporter)
        notes += logNotes

        reporter.enter(stage: "插件", base: 0.25, span: 0.18)
        let plugins = pluginVersions(in: places, installedPlugins: installedPlugins, reporter: reporter)
        if installedPlugins == nil, !plugins.isEmpty {
            notes.append("没有连接到 codex app server，插件的当前版本未确认，已全部标记为受保护。")
        }

        reporter.enter(stage: "会话", base: 0.43, span: 0.49)
        let sessions = try sessionItems(in: places, reporter: reporter)

        if !sessions.isEmpty, !sessions.contains(where: { $0.title != nil }) {
            notes.append("没能从 state_*.sqlite 读到 Codex 的会话标题，列表会回落到会话首句和项目名。")
        }

        reporter.enter(stage: "资产目录", base: 0.92, span: 0.05)
        let assetItems = assetCategories(in: places, sessions: sessions, reporter: reporter)

        reporter.enter(stage: "工作产出", base: 0.97, span: 0.02)
        let workspace = workspaceSnapshot(in: places, reporter: reporter)

        reporter.enter(stage: "受保护的数据", base: 0.99, span: 0.01)
        let protectedItems = protectedCategories(in: places, guards: guards, reporter: reporter)

        let categories = temporaryItems
            + cacheItems
            + [logCategory]
            + [pluginCategory(from: plugins)]
            + assetItems
            + protectedItems

        let externalBytes = [places.appSupport, places.appLogs].reduce(Int64(0)) {
            $0 + directorySize($1, reporter: nil)
        } + places.appCaches.reduce(Int64(0)) { $0 + directorySize($1, reporter: nil) }

        reporter.finish()

        return ScanSnapshot(
            codexHome: places.home,
            scannedAt: .now,
            totalCodexBytes: directorySize(places.home, reporter: nil) + externalBytes,
            externalBytes: externalBytes,
            categories: categories.filter { !$0.isEmpty },
            sessions: sessions.sorted { $0.totalBytes > $1.totalBytes },
            workspace: workspace,
            pluginVersions: plugins.sorted {
                ($0.plugin, $0.version) < ($1.plugin, $1.version)
            },
            notes: notes
        )
    }

    // MARK: - Temporary files

    private func temporaryCategories(
        in places: CodexLocations,
        guards: ProtectedPaths,
        reporter: ProgressReporter?
    ) -> [StorageCategory] {
        let manager = FileManager()
        let children = contents(of: places.temporary, manager: manager)
        let cutoff = Calendar.current.date(byAdding: .day, value: -temporaryGraceDays, to: .now) ?? .distantPast

        var stale: [StorageEntry] = []
        var marketplace: [StorageEntry] = []
        for url in children {
            reporter?.note(url.path)
            let name = url.lastPathComponent
            let measured = measure(url, reporter: reporter)
            let modified = measured.latestActivity
            let bytes = measured.bytes
            guard bytes > 0 else { continue }
            // A marketplace Codex loads plugins from is not scratch, whatever it is called
            // or where it sits. It is listed under 受保护 instead.
            guard !guards.isProtected(url) else { continue }

            if name.localizedCaseInsensitiveContains("marketplace") {
                marketplace.append(
                    StorageEntry(
                        title: name,
                        detail: "插件市场副本，离线时需要重新下载",
                        url: url,
                        bytes: bytes,
                        risk: .rebuildable
                    )
                )
                continue
            }

            // Staging and clone directories are leftovers only once nothing is writing to
            // them; an upgrade unpacking right now looks exactly the same from outside.
            let looksLikeLeftover = name.contains(".staging-") || name.hasPrefix("plugins-clone-")
            let idleRequirement = looksLikeLeftover
                ? Self.leftoverGraceSeconds
                : TimeInterval(temporaryGraceDays) * 86_400
            guard modified < Date(timeIntervalSinceNow: -idleRequirement) else { continue }
            stale.append(
                StorageEntry(
                    title: name,
                    detail: looksLikeLeftover
                        ? "安装暂存或克隆残留，已 \(Self.idleDescription(since: modified)) 没有写入"
                        : "\(temporaryGraceDays) 天内没有改动的临时目录",
                    url: url,
                    bytes: bytes,
                    risk: .safe,
                    // Re-checked immediately before deletion: a scan result can be minutes
                    // old, and an upgrade can start in that window.
                    minimumIdleSeconds: idleRequirement,
                    // `.tmp` is where Codex unpacks upgrades. Nothing here is touched
                    // while it is running — an idle-time heuristic cannot tell an
                    // abandoned staging directory from one being written into.
                    requiresCodexStopped: true
                )
            )
        }

        return [
            StorageCategory(
                kind: .temporary,
                title: "过期临时目录",
                detail: "旧 staging、失败的 clone 和无人使用的临时目录；只在 Codex 退出后清理",
                group: .recommended,
                risk: .safe,
                entries: stale.sorted { $0.bytes > $1.bytes }
            ),
            StorageCategory(
                kind: .marketplaceCache,
                title: "插件市场缓存",
                detail: "可以重新下载，但离线时会影响插件安装",
                group: .review,
                risk: .rebuildable,
                entries: marketplace.sorted { $0.bytes > $1.bytes }
            )
        ]
    }

    // MARK: - Caches and logs outside ~/.codex

    private func cacheCategories(in places: CodexLocations, reporter: ProgressReporter?) -> [StorageCategory] {
        let manager = FileManager()

        let browser = places.browserCacheDirectories.compactMap { url -> StorageEntry? in
            reporter?.note(url.path)
            guard manager.fileExists(atPath: url.path) else { return nil }
            let bytes = directorySize(url, reporter: reporter)
            guard bytes > 0 else { return nil }
            return StorageEntry(
                title: url.lastPathComponent,
                detail: url.path.replacingOccurrences(of: places.appSupport.path + "/", with: ""),
                url: url,
                bytes: bytes,
                risk: .rebuildable
            )
        }

        let caches = places.appCaches.compactMap { url -> StorageEntry? in
            reporter?.note(url.path)
            guard manager.fileExists(atPath: url.path) else { return nil }
            let bytes = directorySize(url, reporter: reporter)
            guard bytes > 0 else { return nil }
            return StorageEntry(
                title: url.lastPathComponent,
                detail: "macOS URL 缓存与渲染缓存",
                url: url,
                bytes: bytes,
                risk: .rebuildable
            )
        }

        let logCutoff = Calendar.current.date(byAdding: .day, value: -logRetentionDays, to: .now) ?? .distantPast
        let logs = contents(of: places.appLogs, manager: manager).compactMap { url -> StorageEntry? in
            reporter?.note(url.path)
            guard modificationDate(of: url) < logCutoff else { return nil }
            let bytes = directorySize(url, reporter: reporter)
            guard bytes > 0 else { return nil }
            return StorageEntry(
                title: url.lastPathComponent,
                detail: "早于 \(logRetentionDays) 天的应用日志",
                url: url,
                bytes: bytes,
                risk: .rebuildable
            )
        }

        return [
            StorageCategory(
                kind: .browserCache,
                title: "浏览器与渲染缓存",
                detail: "Cache、Code Cache、GPU Cache，登录信息不在其中",
                group: .recommended,
                risk: .rebuildable,
                entries: browser.sorted { $0.bytes > $1.bytes }
            ),
            StorageCategory(
                kind: .appCache,
                title: "应用缓存",
                detail: "~/Library/Caches 中 Codex 的可重建缓存",
                group: .recommended,
                risk: .rebuildable,
                entries: caches.sorted { $0.bytes > $1.bytes }
            ),
            StorageCategory(
                kind: .appLogs,
                title: "旧应用日志",
                detail: "保留最近 \(logRetentionDays) 天，其余可以清理",
                group: .recommended,
                risk: .rebuildable,
                entries: logs.sorted { $0.bytes > $1.bytes }
            )
        ]
    }

    // MARK: - Log databases

    func logDatabaseURLs(in codexHome: URL) -> [URL] {
        let manager = FileManager()
        let children = (try? manager.contentsOfDirectory(
            at: codexHome,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        return children
            .filter { $0.lastPathComponent.hasPrefix("logs_") && $0.pathExtension == "sqlite" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func logDatabaseCategory(
        in places: CodexLocations,
        reporter: ProgressReporter?
    ) -> (StorageCategory, [String]) {
        var entries: [StorageEntry] = []
        var notes: [String] = []
        let maintenance = SQLiteMaintenance()

        for url in logDatabaseURLs(in: places.home) {
            reporter?.note(url.path)
            let footprint = FileSize.of(url)
                + FileSize.of(URL(fileURLWithPath: url.path + "-wal"))
                + FileSize.of(URL(fileURLWithPath: url.path + "-shm"))
            guard footprint > 0 else { continue }
            do {
                let inspection = try maintenance.inspect(url)
                guard inspection.reclaimableBytes > 1_048_576 else { continue }
                entries.append(
                    StorageEntry(
                        title: url.lastPathComponent,
                        detail: "已使用 \(ByteFormat.string(inspection.usedBytes))，空闲页 "
                            + "\(inspection.freeListCount) 页，可回收 \(ByteFormat.string(inspection.reclaimableBytes))",
                        url: url,
                        bytes: footprint,
                        reclaimableBytes: inspection.reclaimableBytes,
                        method: .compactDatabase,
                        risk: .lossless
                    )
                )
            } catch {
                notes.append("\(url.lastPathComponent) 暂时无法读取：\(error.localizedDescription)")
            }
        }

        return (
            StorageCategory(
                kind: .logDatabase,
                title: "日志数据库空闲页",
                detail: "Codex 只删除记录，文件不会自己变小；这里做 checkpoint 和 VACUUM，不丢诊断数据",
                group: .recommended,
                risk: .lossless,
                entries: entries
            ),
            notes
        )
    }

    // MARK: - Plugins

    func scanPluginVersions(in codexHome: URL) throws -> [PluginVersionItem] {
        pluginVersions(in: locations(for: codexHome), installedPlugins: nil, reporter: nil)
    }

    func pluginVersions(
        in places: CodexLocations,
        installedPlugins: [InstalledPlugin]?,
        reporter: ProgressReporter?
    ) -> [PluginVersionItem] {
        let manager = FileManager()
        var result: [PluginVersionItem] = []
        for versionURL in pluginVersionDirectories(under: places.plugins, manager: manager, depth: 0) {
            reporter?.note(versionURL.path)
            let manifest = readPluginManifest(at: versionURL)
            let name = manifest.name ?? versionURL.deletingLastPathComponent().lastPathComponent
            let version = manifest.version ?? versionURL.lastPathComponent
            let marketplace = marketplaceName(for: versionURL, under: places.plugins)
            let environment = directorySize(versionURL.appending(path: ".venv"), reporter: nil)
            result.append(
                PluginVersionItem(
                    marketplace: marketplace,
                    plugin: name,
                    version: version,
                    directoryURL: versionURL,
                    bytes: directorySize(versionURL, reporter: reporter),
                    environmentBytes: environment,
                    modifiedAt: modificationDate(of: versionURL),
                    status: status(
                        for: versionURL,
                        plugin: name,
                        version: version,
                        installedPlugins: installedPlugins
                    )
                )
            )
        }
        return result
    }

    private func status(
        for url: URL,
        plugin: String,
        version: String,
        installedPlugins: [InstalledPlugin]?
    ) -> PluginStatus {
        guard let installedPlugins else { return .unconfirmed }
        let matchesDirectory = installedPlugins.contains { installed in
            guard let directory = installed.directory else { return false }
            return ProtectedPaths.contains(directory.standardizedFileURL, url)
                || ProtectedPaths.contains(url, directory.standardizedFileURL)
        }
        if matchesDirectory { return .current }

        let known = installedPlugins.filter { $0.name == plugin }
        guard !known.isEmpty else { return .orphaned }
        let wanted = Self.normalizedVersion(version)
        if known.contains(where: { Self.normalizedVersion($0.version) == wanted }) { return .current }
        // The plugin is installed but the app server never told us which version,
        // so we cannot prove this directory is the stale one.
        guard known.contains(where: { $0.version?.isEmpty == false }) else { return .unconfirmed }
        return .outdated
    }

    static func normalizedVersion(_ version: String?) -> String? {
        guard var value = version?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !value.isEmpty else { return nil }
        if value.hasPrefix("v") { value.removeFirst() }
        return value
    }

    private func pluginCategory(from plugins: [PluginVersionItem]) -> StorageCategory {
        let entries = plugins.filter { $0.status.isRemovable }.map { item in
            StorageEntry(
                title: "\(item.plugin) · \(item.version)",
                detail: item.status == .orphaned
                    ? "插件已卸载，只剩下运行环境"
                    : "已有更新的版本在使用中",
                url: item.directoryURL,
                bytes: item.bytes,
                risk: .safe
            )
        }
        return StorageCategory(
            kind: .pluginRemnants,
            title: "老版本插件与卸载残留",
            detail: "只清理非当前版本，当前启用的版本永远受保护",
            group: .recommended,
            risk: .safe,
            entries: entries.sorted { $0.bytes > $1.bytes }
        )
    }

    private func pluginVersionDirectories(under url: URL, manager: FileManager, depth: Int) -> [URL] {
        guard depth <= 4, manager.fileExists(atPath: url.path) else { return [] }
        var result: [URL] = []
        for child in childDirectories(of: url, manager: manager) {
            if child.lastPathComponent.hasPrefix(".") { continue }
            if manager.fileExists(atPath: child.appending(path: ".codex-plugin/plugin.json").path) {
                result.append(child)
            } else {
                result += pluginVersionDirectories(under: child, manager: manager, depth: depth + 1)
            }
        }
        return result
    }

    private func readPluginManifest(at url: URL) -> (name: String?, version: String?) {
        let manifestURL = url.appending(path: ".codex-plugin/plugin.json")
        guard
            let data = try? Data(contentsOf: manifestURL),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return (nil, nil) }
        return (object["name"] as? String, object["version"] as? String)
    }

    private func marketplaceName(for versionURL: URL, under pluginsRoot: URL) -> String {
        let rootComponents = pluginsRoot.standardizedFileURL.pathComponents
        let components = versionURL.standardizedFileURL.pathComponents
        guard components.count > rootComponents.count else { return "本地" }
        let relative = Array(components.dropFirst(rootComponents.count))
        if relative.first == "cache", relative.count > 1 { return relative[1] }
        return relative.first ?? "本地"
    }

    // MARK: - Generated assets

    private func assetCategories(
        in places: CodexLocations,
        sessions: [SessionItem],
        reporter: ProgressReporter?
    ) -> [StorageCategory] {
        let manager = FileManager()
        // Image folders are named after the thread that produced them, so they can be
        // labelled with the session instead of showing a bare UUID.
        let byThread = Dictionary(sessions.map { ($0.threadID, $0) }, uniquingKeysWith: { first, _ in first })
        let images = contents(of: places.generatedImages, manager: manager).compactMap { url -> StorageEntry? in
            reporter?.note(url.path)
            let bytes = directorySize(url, reporter: reporter)
            guard bytes > 0 else { return nil }
            let session = byThread[url.lastPathComponent]
            return StorageEntry(
                title: session?.displayName ?? url.lastPathComponent,
                detail: Self.assetDetail(for: session, threadID: url.lastPathComponent),
                url: url,
                bytes: bytes,
                risk: session == nil ? .safe : .caution
            )
        }

        var computerUse: [StorageEntry] = []
        if manager.fileExists(atPath: places.computerUse.path) {
            reporter?.note(places.computerUse.path)
            let bytes = directorySize(places.computerUse, reporter: reporter)
            if bytes > 0 {
                computerUse.append(
                    StorageEntry(
                        title: "computer-use",
                        detail: "Computer Use 辅助 App，删除后下次使用会重新下载",
                        url: places.computerUse,
                        bytes: bytes,
                        risk: .caution
                    )
                )
            }
        }

        return [
            StorageCategory(
                kind: .generatedImages,
                title: "生成图片",
                detail: "按线程保存的图片；删除会话时会一起处理，会话已删除的图片可以安全清理",
                group: .review,
                risk: .caution,
                entries: images.sorted { $0.bytes > $1.bytes }
            ),
            StorageCategory(
                kind: .computerUse,
                title: "Computer Use 组件",
                detail: "不建议清理，除非确定不再使用",
                group: .review,
                risk: .caution,
                entries: computerUse
            )
        ]
    }

    /// `.tmp/bundled-marketplaces` reads better than `bundled-marketplaces` on its own.
    static func relativeName(of url: URL, under root: URL) -> String {
        let rootComponents = root.standardizedFileURL.pathComponents
        let components = url.standardizedFileURL.pathComponents
        guard components.count > rootComponents.count,
              Array(components.prefix(rootComponents.count)) == rootComponents
        else { return url.lastPathComponent }
        return components.dropFirst(rootComponents.count).joined(separator: "/")
    }

    static func assetDetail(for session: SessionItem?, threadID: String) -> String {
        guard let session else {
            return "会话已删除，只剩下图片 · \(threadID.prefix(8))"
        }
        var parts: [String] = []
        if let project = session.projectName { parts.append(project) }
        parts.append(session.location.rawValue)
        parts.append("最后活动 " + session.modifiedAt.formatted(date: .numeric, time: .omitted))
        return parts.joined(separator: " · ")
    }

    // MARK: - Protected data

    private func protectedCategories(
        in places: CodexLocations,
        guards: ProtectedPaths,
        reporter: ProgressReporter?
    ) -> [StorageCategory] {
        let manager = FileManager()

        var configuration: [StorageEntry] = []
        let marketplaceSources = Set(guards.localMarketplaceSources.map(\.path))
        for url in guards.protectedURLs
        where ProtectedPaths.contains(places.home, url) && !marketplaceSources.contains(url.path) {
            reporter?.note(url.path)
            guard manager.fileExists(atPath: url.path) else { continue }
            let bytes = directorySize(url, reporter: nil)
            configuration.append(
                StorageEntry(
                    title: url.lastPathComponent,
                    detail: "配置、凭据或用户规则",
                    url: url,
                    bytes: bytes,
                    risk: .shielded
                )
            )
        }
        for url in guards.localMarketplaceSources where manager.fileExists(atPath: url.path) {
            reporter?.note(url.path)
            configuration.append(
                StorageEntry(
                    title: Self.relativeName(of: url, under: places.home),
                    detail: "config.toml 里注册的本地插件市场，Codex 正在从这里加载插件",
                    url: url,
                    bytes: directorySize(url, reporter: nil),
                    risk: .shielded
                )
            )
        }
        for url in contents(of: places.home, manager: manager) {
            let name = url.lastPathComponent
            guard ProtectedPaths.protectedHomePrefixes.contains(where: { name.hasPrefix($0) }) else { continue }
            configuration.append(
                StorageEntry(
                    title: name,
                    detail: "会话索引与状态数据库",
                    url: url,
                    bytes: FileSize.of(url),
                    risk: .shielded
                )
            )
        }

        var userData: [StorageEntry] = []
        for relative in ProtectedPaths.protectedAppSupportEntries {
            let url = places.appSupport.appending(path: relative)
            guard manager.fileExists(atPath: url.path) else { continue }
            userData.append(
                StorageEntry(
                    title: relative,
                    detail: "浏览器配置与登录状态",
                    url: url,
                    bytes: directorySize(url, reporter: nil),
                    risk: .shielded
                )
            )
        }

        return [
            StorageCategory(
                kind: .protectedConfig,
                title: "配置与凭据",
                detail: "auth.json、config.toml、状态数据库、规则与技能",
                group: .protectedData,
                risk: .shielded,
                entries: configuration.sorted { $0.bytes > $1.bytes }
            ),
            StorageCategory(
                kind: .protectedUserData,
                title: "用户数据",
                detail: "项目目录与浏览器登录信息",
                group: .protectedData,
                risk: .shielded,
                entries: userData.sorted { $0.bytes > $1.bytes }
            )
        ]
    }

    // MARK: - Workspace (~/Documents/Codex)

    func workspaceSnapshot(in places: CodexLocations, reporter: ProgressReporter?) -> WorkspaceSnapshot {
        let manager = FileManager()
        let root = places.workspace
        guard manager.fileExists(atPath: root.path) else { return .empty(at: root) }

        let probe = GitProbe()
        var repositoryBudget = 32
        let entries = childDirectories(of: root, manager: manager)
            .compactMap { dateURL -> WorkspaceEntry? in
                reporter?.note(dateURL.path)
                let children = childDirectories(of: dateURL, manager: manager)
                    .compactMap { sessionURL -> WorkspaceEntry? in
                        workspaceEntry(
                            at: sessionURL,
                            manager: manager,
                            probe: probe,
                            budget: &repositoryBudget,
                            reporter: reporter
                        )
                    }
                    .sorted { $0.bytes > $1.bytes }

                // The date folder's own loose files, plus everything in its sessions.
                let own = walk(dateURL, manager: manager, includingSubdirectories: false)
                let bytes = own.bytes + children.reduce(Int64(0)) { $0 + $1.bytes }
                guard bytes > 0 || !children.isEmpty else { return nil }
                return WorkspaceEntry(
                    url: dateURL,
                    name: dateURL.lastPathComponent,
                    bytes: bytes,
                    fileCount: own.files,
                    modifiedAt: modificationDate(of: dateURL),
                    repositories: [],
                    children: children
                )
            }
            .sorted { $0.name > $1.name }

        return WorkspaceSnapshot(root: root, entries: entries)
    }

    private func workspaceEntry(
        at url: URL,
        manager: FileManager,
        probe: GitProbe,
        budget: inout Int,
        reporter: ProgressReporter?
    ) -> WorkspaceEntry? {
        reporter?.note(url.path)
        let walked = walk(url, manager: manager, includingSubdirectories: true)
        guard walked.bytes > 0 || walked.files > 0 else { return nil }

        var repositories: [WorkspaceRepository] = []
        for repository in walked.repositories {
            guard budget > 0 else {
                repositories.append(WorkspaceRepository(url: repository, state: .unknown))
                continue
            }
            budget -= 1
            repositories.append(WorkspaceRepository(url: repository, state: probe.state(of: repository)))
        }

        return WorkspaceEntry(
            url: url,
            name: url.lastPathComponent,
            bytes: walked.bytes,
            fileCount: walked.files,
            modifiedAt: modificationDate(of: url),
            repositories: repositories.sorted { $0.name < $1.name },
            children: []
        )
    }

    /// One walk that answers size, file count and where the git checkouts are.
    private func walk(
        _ url: URL,
        manager: FileManager,
        includingSubdirectories: Bool
    ) -> (bytes: Int64, files: Int, repositories: [URL]) {
        guard let contents = try? manager.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .totalFileAllocatedSizeKey, .fileSizeKey],
            options: []
        ) else { return (0, 0, []) }

        var bytes: Int64 = 0
        var files = 0
        var repositories: [URL] = []
        for child in contents {
            let isDirectory = (try? child.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
            if !isDirectory {
                bytes += FileSize.of(child)
                files += 1
                continue
            }
            if child.lastPathComponent == ".git" {
                repositories.append(url)
            }
            guard includingSubdirectories else { continue }
            let nested = walk(child, manager: manager, includingSubdirectories: true)
            bytes += nested.bytes
            files += nested.files
            repositories += nested.repositories
        }
        return (bytes, files, repositories)
    }

    // MARK: - Sessions

    func scanSessions(in codexHome: URL) throws -> [SessionItem] {
        try sessionItems(in: locations(for: codexHome), reporter: nil)
    }

    func sessionItems(in places: CodexLocations, reporter: ProgressReporter?) throws -> [SessionItem] {
        let files = sessionFiles(at: places.sessions, location: .active)
            + sessionFiles(at: places.archivedSessions, location: .archived)
        let totalBytes = max(1, files.reduce(Int64(0)) { $0 + FileSize.of($1.url) })

        // Codex' own thread titles, read straight from its state database.
        let titles = CodexThreadIndex.load(codexHome: places.home)
        var cache = SessionScanCache.load(from: places.scanCache)
        var processed: Int64 = 0
        var result: [SessionItem] = []
        var cancelled = false
        for file in files {
            if Task.isCancelled { cancelled = true; break }
            reporter?.note(file.url.path, fraction: Double(processed) / Double(totalBytes))
            result.append(sessionItem(for: file, in: places, titles: titles, cache: &cache))
            processed += FileSize.of(file.url)
        }
        // A cancelled pass has not seen every file, so pruning would throw away good records.
        if !cancelled { cache.save(to: places.scanCache) }
        return result
    }

    private func sessionFiles(at directory: URL, location: SessionLocation) -> [(url: URL, location: SessionLocation)] {
        let manager = FileManager()
        guard manager.fileExists(atPath: directory.path) else { return [] }
        guard let enumerator = manager.enumerator(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var result: [(url: URL, location: SessionLocation)] = []
        for case let url as URL in enumerator {
            let name = url.lastPathComponent
            guard name.hasSuffix(".jsonl") || name.hasSuffix(".jsonl.zst") else { continue }
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            result.append((url, location))
        }
        return result
    }

    private func sessionItem(
        for file: (url: URL, location: SessionLocation),
        in places: CodexLocations,
        titles: CodexThreadIndex,
        cache: inout SessionScanCache
    ) -> SessionItem {
        let url = file.url
        let before = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        let compressed = url.lastPathComponent.hasSuffix(".zst")
        let currentSize = FileSize.of(url)
        let currentModified = before?.contentModificationDate ?? .distantPast

        var content = SessionContentScan()
        var unstable = false
        if let cached = cache.record(for: url, size: currentSize, modified: currentModified) {
            content = cached.contentScan
        } else if compressed {
            content = SessionContentScan()
        } else {
            if let scanned = try? SessionContentScanner(chunkSize: chunkSize).scan(url) {
                content = scanned
            } else {
                content = SessionContentScan(parseWarnings: 1)
            }
            let after = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            unstable = before?.contentModificationDate != after?.contentModificationDate
                || before?.fileSize != after?.fileSize
            // Only a file that stopped moving is worth remembering.
            if !unstable {
                cache.store(
                    SessionScanCache.Record(scan: content, size: currentSize, modified: currentModified),
                    for: url
                )
            }
        }

        let metadata = content.metadata
        let threadID = metadata.id ?? Self.sessionID(from: url.lastPathComponent)
        let fileBytes = FileSize.of(url)

        var assetURLs: [URL] = []
        for root in [places.generatedImages, places.visualizations] {
            let candidate = root.appending(path: threadID, directoryHint: .isDirectory)
            if FileManager.default.fileExists(atPath: candidate.path) { assetURLs.append(candidate) }
        }
        let assetBytes = assetURLs.reduce(Int64(0)) { $0 + directorySize($1, reporter: nil) }

        var tags = Array(content.tags).sorted { $0.rawValue < $1.rawValue }
        if content.images.uriBytes > 32 * 1_048_576,
           fileBytes > 0,
           Double(content.images.uriBytes) / Double(fileBytes) > 0.4 {
            tags.insert(.imageHeavy, at: 0)
        }

        return SessionItem(
            id: url.standardizedFileURL.path,
            threadID: threadID,
            fileURL: url,
            location: file.location,
            modifiedAt: before?.contentModificationDate ?? .distantPast,
            fileBytes: fileBytes,
            assetBytes: assetBytes,
            assetURLs: assetURLs,
            embeddedImageBytes: content.images.uriBytes,
            embeddedImageCount: content.images.count,
            distinctImageCount: content.images.distinctCount,
            duplicateImageBytes: content.images.duplicateBytes,
            workingDirectory: metadata.workingDirectory,
            title: titles.title(forThreadID: threadID, rolloutPath: url) ?? metadata.title,
            preview: metadata.preview,
            tags: tags,
            isCompressed: compressed,
            isUnstable: unstable,
            parseWarnings: content.parseWarnings + content.images.truncatedCandidates
        )
    }

    static func sessionID(from filename: String) -> String {
        var value = filename
        if value.hasSuffix(".zst") { value.removeLast(4) }
        if value.hasSuffix(".jsonl") { value.removeLast(6) }
        let suffix = String(value.suffix(36))
        return UUID(uuidString: suffix) != nil ? suffix : value
    }

    // MARK: - Filesystem helpers

    private func contents(of url: URL, manager: FileManager) -> [URL] {
        (try? manager.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey],
            options: []
        )) ?? []
    }

    private func childDirectories(of url: URL, manager: FileManager) -> [URL] {
        contents(of: url, manager: manager).filter {
            (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        }
    }

    private func modificationDate(of url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    func directorySize(_ url: URL, reporter: ProgressReporter?) -> Int64 {
        measure(url, reporter: reporter).bytes
    }

    /// Size and, just as importantly, the most recent modification time **anywhere** in
    /// the subtree.
    ///
    /// A directory's own timestamp only moves when an entry is added or removed directly
    /// inside it, so an unpack writing into `staging-x/plugins/browser/…` leaves
    /// `staging-x` looking untouched since whenever `plugins/` was created. Judging
    /// "nothing is using this" from the top-level timestamp is therefore not a
    /// conservative guess, it is the wrong measurement.
    static func measure(
        _ url: URL,
        reporter: ProgressReporter?,
        isCancelled: () -> Bool = { Task.isCancelled }
    ) -> (bytes: Int64, latestActivity: Date) {
        let manager = FileManager()
        var isDirectory: ObjCBool = false
        guard manager.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            return (0, .distantPast)
        }

        let ownModified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate ?? .distantPast
        guard isDirectory.boolValue else { return (FileSize.of(url), ownModified) }

        guard let enumerator = manager.enumerator(
            at: url,
            includingPropertiesForKeys: [
                .isRegularFileKey,
                .contentModificationDateKey,
                .totalFileAllocatedSizeKey,
                .fileAllocatedSizeKey,
                .fileSizeKey
            ],
            options: [.skipsPackageDescendants]
        ) else { return (0, ownModified) }

        var total: Int64 = 0
        var latest = ownModified
        var counter = 0
        for case let fileURL as URL in enumerator {
            if isCancelled() { break }
            let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .contentModificationDateKey])
            // Directories count towards activity too: a new subdirectory is a write.
            if let modified = values?.contentModificationDate, modified > latest {
                latest = modified
            }
            guard values?.isRegularFile == true else { continue }
            total += FileSize.of(fileURL)
            counter += 1
            if counter % 256 == 0 { reporter?.note(fileURL.path) }
        }
        return (total, latest)
    }

    func measure(_ url: URL, reporter: ProgressReporter?) -> (bytes: Int64, latestActivity: Date) {
        Self.measure(url, reporter: reporter)
    }
}

/// Throttled progress updates. Scanning a large session directory produces tens of
/// thousands of events, so the UI only ever sees a few per second.
final class ProgressReporter {
    private let emit: (ScanProgress) -> Void
    private var stage = ""
    private var base = 0.0
    private var span = 0.0
    private var lastEmit = Date.distantPast
    private var scannedBytes: Int64 = 0

    init(emit: @escaping (ScanProgress) -> Void) {
        self.emit = emit
    }

    func enter(stage: String, base: Double, span: Double) {
        self.stage = stage
        self.base = base
        self.span = span
        push(path: "", fraction: 0, force: true)
    }

    func note(_ path: String, fraction: Double? = nil) {
        push(path: path, fraction: fraction ?? 0, force: false)
    }

    func finish() {
        stage = "完成"
        push(path: "", fraction: 1, force: true)
    }

    private func push(path: String, fraction: Double, force: Bool) {
        let now = Date()
        guard force || now.timeIntervalSince(lastEmit) > 0.12 else { return }
        lastEmit = now
        emit(
            ScanProgress(
                stage: stage,
                currentPath: path,
                scannedBytes: scannedBytes,
                fraction: min(1, base + span * min(1, max(0, fraction)))
            )
        )
    }
}

// MARK: - Session content

struct SessionMetadata: Sendable {
    var id: String?
    var workingDirectory: String?
    var title: String?
    /// First real user message, used as a title when the rollout has none.
    var preview: String?
}

struct SessionContentScan: Sendable {
    var images = EmbeddedImageScanResult()
    var tags: Set<SessionTag> = []
    var metadata = SessionMetadata()
    var parseWarnings = 0

    init() {}

    init(parseWarnings: Int) {
        self.parseWarnings = parseWarnings
    }
}

/// Single pass over a rollout file: counts embedded images, detects which tools the
/// session used, and reads the `session_meta` header. Never materializes base64 payloads.
struct SessionContentScanner: Sendable {
    let chunkSize: Int

    init(chunkSize: Int = 1_048_576) {
        self.chunkSize = max(4, chunkSize)
    }

    func scan(_ fileURL: URL) throws -> SessionContentScan {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }

        var counter = JSONStringImageCounter()
        var matcher = SessionTagMatcher()
        var header = SessionHeaderReader()

        while let chunk = try handle.read(upToCount: chunkSize), !chunk.isEmpty {
            counter.consume(chunk)
            matcher.consume(chunk)
            header.consume(chunk)
        }
        header.finish()

        var result = SessionContentScan()
        result.images = counter.finish()
        result.tags = matcher.result
        result.metadata = header.metadata ?? SessionMetadata()
        result.metadata.preview = header.preview
        result.parseWarnings += header.parseWarnings
        return result
    }

    static func parseMetadata(_ line: Data) -> SessionMetadata? {
        guard
            let root = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            root["type"] as? String == "session_meta",
            let payload = root["payload"] as? [String: Any]
        else { return nil }
        return SessionMetadata(
            id: payload["id"] as? String,
            workingDirectory: payload["cwd"] as? String,
            title: Self.cleanPreview((payload["title"] as? String) ?? (payload["name"] as? String))
        )
    }

    /// Pulls the text out of the first user turn. Rollouts store it either as an
    /// `event_msg`/`user_message` line or as a `response_item` message with role `user`.
    static func parsePreview(_ line: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return nil }
        let payload = root["payload"] as? [String: Any] ?? root

        var text: String?
        if payload["type"] as? String == "user_message" {
            text = (payload["message"] as? String) ?? (payload["text"] as? String)
        }
        if text == nil, payload["role"] as? String == "user" {
            if let content = payload["content"] as? [[String: Any]] {
                text = content.compactMap { $0["text"] as? String }
                    .first { cleanPreview($0) != nil }
            } else {
                text = payload["content"] as? String
            }
        }
        return cleanPreview(text)
    }

    /// Markers that mean the turn is machine preamble rather than something the user typed.
    private static let preambleMarkers = [
        "<environment_context",
        "<user_instructions",
        "<user_shell",
        "<agents",
        "# agents.md",
        "you are a coding agent"
    ]

    /// Only used when Codex has no title of its own for the thread. Codex opens every
    /// thread with injected context turns, so most of what comes first is not a summary
    /// of anything — drop those instead of showing their first line as a title.
    static func cleanPreview(_ raw: String?) -> String? {
        guard let raw else { return nil }
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }

        // Some Codex builds wrap the real request in a preamble on the first turn.
        if let marker = value.range(of: "My request for Codex:") {
            value = String(value[marker.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard !value.hasPrefix("<") else { return nil }
        let head = value.prefix(400).lowercased()
        for marker in preambleMarkers where head.contains(marker) { return nil }

        let collapsed = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !collapsed.isEmpty else { return nil }
        return collapsed.count > 90 ? String(collapsed.prefix(90)) + "…" : collapsed
    }
}

/// Reads the leading lines of a rollout file: the `session_meta` header plus the first
/// user turn. Bounded on both line length and line count so an embedded screenshot on
/// line two can never be pulled into memory.
struct SessionHeaderReader {
    private(set) var metadata: SessionMetadata?
    private(set) var preview: String?
    private(set) var parseWarnings = 0
    private(set) var isFinished = false

    private var current = Data()
    private var skippingLine = false
    private var lines = 0
    private let maxLineBytes = 131_072
    private let maxLines = 60

    mutating func consume(_ chunk: Data) {
        var slice = chunk[...]
        while !slice.isEmpty, !isFinished {
            guard let newline = slice.firstIndex(of: 0x0A) else {
                append(slice)
                return
            }
            append(slice[slice.startIndex..<newline])
            endLine()
            slice = slice[slice.index(after: newline)...]
        }
    }

    mutating func finish() {
        guard !isFinished else { return }
        endLine()
        if metadata == nil, lines > 0 { parseWarnings += 1 }
        isFinished = true
    }

    private mutating func append(_ bytes: Data.SubSequence) {
        guard !skippingLine, !isFinished else { return }
        guard current.count + bytes.count <= maxLineBytes else {
            current.removeAll(keepingCapacity: false)
            skippingLine = true
            return
        }
        current.append(contentsOf: bytes)
    }

    private mutating func endLine() {
        defer {
            current.removeAll(keepingCapacity: true)
            skippingLine = false
        }
        guard !skippingLine, !current.isEmpty else { return }
        lines += 1
        if metadata == nil, let parsed = SessionContentScanner.parseMetadata(current) {
            metadata = parsed
            preview = preview ?? parsed.title
        } else if preview == nil {
            preview = SessionContentScanner.parsePreview(current)
        }
        if metadata != nil, preview != nil { isFinished = true }
        if lines >= maxLines { isFinished = true }
    }
}

/// Byte-level needle search that survives chunk boundaries.
struct SessionTagMatcher {
    private static let needles: [(SessionTag, Data)] = [
        (.browser, Data("browser_".utf8)),
        (.computerUse, Data("computer_use".utf8)),
        (.imageGen, Data("image_gen".utf8))
    ]
    private static let carryLength = (needles.map { $0.1.count }.max() ?? 1) - 1

    private(set) var result: Set<SessionTag> = []
    private var carry = Data()

    mutating func consume(_ chunk: Data) {
        guard result.count < Self.needles.count else { return }
        var data = Data()
        data.reserveCapacity(carry.count + chunk.count)
        data.append(carry)
        data.append(chunk)
        for (tag, needle) in Self.needles where !result.contains(tag) {
            if data.range(of: needle) != nil { result.insert(tag) }
        }
        carry = Data(data.suffix(Self.carryLength))
    }
}

struct EmbeddedImageScanResult: Equatable, Sendable {
    var count = 0
    var uriBytes: Int64 = 0
    var base64Bytes: Int64 = 0
    var truncatedCandidates = 0
    /// How many of the occurrences are pictures we have not seen before in this file.
    var distinctCount = 0
    /// Bytes held by repeat occurrences — what deduplicating the file would give back.
    var duplicateBytes: Int64 = 0
}

/// Counts image data URIs directly from JSON bytes. It never materializes a base64 payload.
struct EmbeddedImageScanner: Sendable {
    let chunkSize: Int

    init(chunkSize: Int = 1_048_576) {
        self.chunkSize = max(4, chunkSize)
    }

    func scan(_ fileURL: URL) throws -> EmbeddedImageScanResult {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }

        var parser = JSONStringImageCounter()
        while let chunk = try handle.read(upToCount: chunkSize), !chunk.isEmpty {
            parser.consume(chunk)
        }
        return parser.finish()
    }
}

struct JSONStringImageCounter {
    private static let plainPrefix = Data("data:image/".utf8)
    private static let escapedSlashPrefix = Data(#"data:image\/"#.utf8)
    private static let carryLength = max(plainPrefix.count, escapedSlashPrefix.count) - 1

    private var carry = Data()
    private var active: ImageCandidate?
    private var result = EmbeddedImageScanResult()
    private var seen: Set<Data> = []

    mutating func consume(_ chunk: Data) {
        var data = Data()
        data.reserveCapacity(carry.count + chunk.count)
        data.append(carry)
        data.append(chunk)
        carry.removeAll(keepingCapacity: true)

        var cursor = data.startIndex
        while cursor < data.endIndex {
            if active != nil {
                if let quote = data[cursor...].firstIndex(of: 0x22) {
                    active?.append(data[cursor..<quote])
                    finishCandidate()
                    cursor = data.index(after: quote)
                } else {
                    active?.append(data[cursor...])
                    cursor = data.endIndex
                }
                continue
            }

            guard let match = earliestPrefix(in: data, from: cursor) else {
                let remaining = data.distance(from: cursor, to: data.endIndex)
                let preserved = min(Self.carryLength, remaining)
                if preserved > 0 {
                    carry.append(data.suffix(preserved))
                }
                break
            }
            active = ImageCandidate()
            cursor = match.lowerBound
        }
    }

    mutating func finish() -> EmbeddedImageScanResult {
        if active != nil {
            result.truncatedCandidates += 1
        }
        return result
    }

    private func earliestPrefix(in data: Data, from cursor: Data.Index) -> Range<Data.Index>? {
        let searchRange = cursor..<data.endIndex
        let plain = data.range(of: Self.plainPrefix, in: searchRange)
        let escaped = data.range(of: Self.escapedSlashPrefix, in: searchRange)
        return switch (plain, escaped) {
        case let (lhs?, rhs?): lhs.lowerBound <= rhs.lowerBound ? lhs : rhs
        case let (lhs?, nil): lhs
        case let (nil, rhs?): rhs
        case (nil, nil): nil
        }
    }

    private mutating func finishCandidate() {
        if let active, active.isBase64Image {
            result.count += 1
            result.uriBytes += active.rawBytes
            result.base64Bytes += max(0, active.rawBytes - active.headerBytesThroughComma)
            if seen.insert(active.payloadDigest()).inserted {
                result.distinctCount += 1
            } else {
                result.duplicateBytes += active.rawBytes
            }
        }
        active = nil
    }
}

struct ImageCandidate {
    private(set) var rawBytes: Int64 = 0
    private(set) var header = Data()
    private var hasher = SHA256()
    private var sawComma = false

    var isBase64Image: Bool {
        guard header.contains(0x2C) else { return false }
        return String(decoding: header, as: UTF8.self)
            .lowercased()
            .contains(";base64,")
    }

    var headerBytesThroughComma: Int64 {
        guard let comma = header.firstIndex(of: 0x2C) else { return rawBytes }
        return Int64(header.distance(from: header.startIndex, to: comma) + 1)
    }

    /// Identity of the picture itself: the base64 payload, not the surrounding JSON.
    /// The same screenshot re-serialized into a later turn hashes to the same value.
    func payloadDigest() -> Data {
        Data(hasher.finalize())
    }

    mutating func append<S: DataProtocol>(_ bytes: S) {
        let data = Data(bytes)
        rawBytes += Int64(data.count)

        var payloadStart = data.startIndex
        if !sawComma {
            if header.count < 256 {
                header.append(contentsOf: data.prefix(256 - header.count))
            }
            // base64 has no commas, so the first one always ends the data URI header.
            guard let comma = data.firstIndex(of: 0x2C) else { return }
            sawComma = true
            payloadStart = data.index(after: comma)
        }
        hasher.update(data: data[payloadStart...])
    }
}
