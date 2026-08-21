import Foundation

struct CodexStorageScanner: Sendable {
    let chunkSize: Int
    let libraryDirectory: URL?
    /// Temporary entries younger than this are assumed to belong to a running task.
    let temporaryGraceDays: Int
    /// Application logs younger than this are kept so Codex can still report on recent runs.
    let logRetentionDays: Int

    init(
        chunkSize: Int = 1_048_576,
        libraryDirectory: URL? = nil,
        temporaryGraceDays: Int = 3,
        logRetentionDays: Int = 10
    ) {
        self.chunkSize = max(4, chunkSize)
        self.libraryDirectory = libraryDirectory
        self.temporaryGraceDays = temporaryGraceDays
        self.logRetentionDays = logRetentionDays
    }

    func locations(for codexHome: URL) -> CodexLocations {
        CodexLocations(home: codexHome, library: libraryDirectory)
    }

    func scan(
        codexHome: URL,
        installedPlugins: [InstalledPlugin]? = nil,
        progress: @Sendable @escaping (ScanProgress) -> Void = { _ in }
    ) throws -> ScanSnapshot {
        let places = locations(for: codexHome)
        let reporter = ProgressReporter(emit: progress)
        var notes: [String] = []

        reporter.enter(stage: "缓存与临时文件", base: 0, span: 0.18)
        let temporaryItems = temporaryCategories(in: places, reporter: reporter)
        let cacheItems = cacheCategories(in: places, reporter: reporter)

        reporter.enter(stage: "日志数据库", base: 0.18, span: 0.07)
        let (logCategory, logNotes) = logDatabaseCategory(in: places, reporter: reporter)
        notes += logNotes

        reporter.enter(stage: "插件", base: 0.25, span: 0.18)
        let plugins = pluginVersions(in: places, installedPlugins: installedPlugins, reporter: reporter)
        if installedPlugins == nil, !plugins.isEmpty {
            notes.append("没有连接到 codex app server，插件的当前版本未确认，已全部标记为受保护。")
        }

        reporter.enter(stage: "资产目录", base: 0.43, span: 0.12)
        let assetItems = assetCategories(in: places, reporter: reporter)

        reporter.enter(stage: "会话", base: 0.55, span: 0.42)
        let sessions = try sessionItems(in: places, reporter: reporter)

        reporter.enter(stage: "受保护的数据", base: 0.97, span: 0.03)
        let protectedItems = protectedCategories(in: places, reporter: reporter)

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
            pluginVersions: plugins.sorted {
                ($0.plugin, $0.version) < ($1.plugin, $1.version)
            },
            notes: notes
        )
    }

    // MARK: - Temporary files

    private func temporaryCategories(in places: CodexLocations, reporter: ProgressReporter?) -> [StorageCategory] {
        let manager = FileManager()
        let children = contents(of: places.temporary, manager: manager)
        let cutoff = Calendar.current.date(byAdding: .day, value: -temporaryGraceDays, to: .now) ?? .distantPast

        var stale: [StorageEntry] = []
        var marketplace: [StorageEntry] = []
        for url in children {
            reporter?.note(url.path)
            let name = url.lastPathComponent
            let modified = modificationDate(of: url)
            let bytes = directorySize(url, reporter: reporter)
            guard bytes > 0 else { continue }

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

            let isLeftover = name.contains(".staging-") || name.hasPrefix("plugins-clone-")
            guard isLeftover || modified < cutoff else { continue }
            stale.append(
                StorageEntry(
                    title: name,
                    detail: isLeftover
                        ? "未完成的安装暂存或克隆残留"
                        : "\(temporaryGraceDays) 天内没有改动的临时目录",
                    url: url,
                    bytes: bytes,
                    risk: .safe
                )
            )
        }

        return [
            StorageCategory(
                kind: .temporary,
                title: "过期临时目录",
                detail: "旧 staging、失败的 clone 和无人使用的临时目录",
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
        if known.contains(where: { $0.version == version }) { return .current }
        return .outdated
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

    private func assetCategories(in places: CodexLocations, reporter: ProgressReporter?) -> [StorageCategory] {
        let manager = FileManager()
        let images = contents(of: places.generatedImages, manager: manager).compactMap { url -> StorageEntry? in
            reporter?.note(url.path)
            let bytes = directorySize(url, reporter: reporter)
            guard bytes > 0 else { return nil }
            return StorageEntry(
                title: url.lastPathComponent,
                detail: "线程生成的图片",
                url: url,
                bytes: bytes,
                risk: .caution
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
                detail: "按线程保存的图片；删除会话时会一起处理",
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

    // MARK: - Protected data

    private func protectedCategories(in places: CodexLocations, reporter: ProgressReporter?) -> [StorageCategory] {
        let manager = FileManager()
        let guards = ProtectedPaths(locations: places)

        var configuration: [StorageEntry] = []
        for url in guards.protectedURLs where ProtectedPaths.contains(places.home, url) {
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
        let documents = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Documents/Codex")
        if manager.fileExists(atPath: documents.path) {
            userData.append(
                StorageEntry(
                    title: "Documents/Codex",
                    detail: "Codex 生成的项目目录，可能包含你的成果",
                    url: documents,
                    bytes: directorySize(documents, reporter: nil),
                    risk: .shielded
                )
            )
        }
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

    // MARK: - Sessions

    func scanSessions(in codexHome: URL) throws -> [SessionItem] {
        try sessionItems(in: locations(for: codexHome), reporter: nil)
    }

    func sessionItems(in places: CodexLocations, reporter: ProgressReporter?) throws -> [SessionItem] {
        let files = sessionFiles(at: places.sessions, location: .active)
            + sessionFiles(at: places.archivedSessions, location: .archived)
        let totalBytes = max(1, files.reduce(Int64(0)) { $0 + FileSize.of($1.url) })

        var processed: Int64 = 0
        var result: [SessionItem] = []
        for file in files {
            if Task.isCancelled { break }
            reporter?.note(file.url.path, fraction: Double(processed) / Double(totalBytes))
            result.append(sessionItem(for: file, in: places))
            processed += FileSize.of(file.url)
        }
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
        in places: CodexLocations
    ) -> SessionItem {
        let url = file.url
        let before = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        let compressed = url.lastPathComponent.hasSuffix(".zst")
        var content = SessionContentScan()
        if !compressed {
            if let scanned = try? SessionContentScanner(chunkSize: chunkSize).scan(url) {
                content = scanned
            } else {
                content = SessionContentScan(parseWarnings: 1)
            }
        }
        let after = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        let unstable = before?.contentModificationDate != after?.contentModificationDate
            || before?.fileSize != after?.fileSize

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
            workingDirectory: metadata.workingDirectory,
            title: metadata.title,
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
        let manager = FileManager()
        var isDirectory: ObjCBool = false
        guard manager.fileExists(atPath: url.path, isDirectory: &isDirectory) else { return 0 }
        guard isDirectory.boolValue else { return FileSize.of(url) }

        guard let enumerator = manager.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey, .fileSizeKey],
            options: [.skipsPackageDescendants]
        ) else { return 0 }

        var total: Int64 = 0
        var counter = 0
        for case let fileURL as URL in enumerator {
            if Task.isCancelled { break }
            guard (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
            total += FileSize.of(fileURL)
            counter += 1
            if counter % 256 == 0 { reporter?.note(fileURL.path) }
        }
        return total
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
        var header = Data()
        var headerComplete = false

        while let chunk = try handle.read(upToCount: chunkSize), !chunk.isEmpty {
            counter.consume(chunk)
            matcher.consume(chunk)
            if !headerComplete {
                if let newline = chunk.firstIndex(of: 0x0A) {
                    header.append(chunk[chunk.startIndex..<newline])
                    headerComplete = true
                } else if header.count < 4_194_304 {
                    header.append(chunk)
                } else {
                    headerComplete = true
                }
            }
        }

        var result = SessionContentScan()
        result.images = counter.finish()
        result.tags = matcher.result
        if headerComplete, !header.isEmpty {
            if let metadata = Self.parseMetadata(header) {
                result.metadata = metadata
            } else {
                result.parseWarnings += 1
            }
        }
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
            title: (payload["title"] as? String) ?? (payload["name"] as? String)
        )
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
        }
        active = nil
    }
}

private struct ImageCandidate {
    private(set) var rawBytes: Int64 = 0
    private(set) var header = Data()

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

    mutating func append<S: DataProtocol>(_ bytes: S) {
        rawBytes += Int64(bytes.count)
        if header.count < 256 {
            header.append(contentsOf: bytes.prefix(256 - header.count))
        }
    }
}
