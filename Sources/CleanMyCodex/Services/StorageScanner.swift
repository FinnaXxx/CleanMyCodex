import Foundation

struct CodexStorageScanner: Sendable {
    let chunkSize: Int

    init(chunkSize: Int = 1_048_576) {
        self.chunkSize = max(4, chunkSize)
    }

    func scan(codexHome: URL) throws -> ScanSnapshot {
        let home = codexHome.standardizedFileURL
        let sessions = try scanSessions(in: home)
        let plugins = try scanPluginVersions(in: home)
        let storageItems = storageBreakdown(home: home)
        let externalBytes = storageItems
            .filter { $0.kind == .appCache }
            .reduce(Int64(0)) { $0 + $1.bytes }

        return ScanSnapshot(
            codexHome: home,
            scannedAt: .now,
            totalCodexBytes: allocatedSize(of: home) + externalBytes,
            storageItems: storageItems,
            sessions: sessions.sorted { $0.modifiedAt > $1.modifiedAt },
            pluginVersions: plugins.sorted {
                ($0.plugin, $0.version) < ($1.plugin, $1.version)
            }
        )
    }

    func scanSessions(in codexHome: URL) throws -> [SessionItem] {
        var result: [SessionItem] = []
        result += try scanSessionDirectory(
            codexHome.appending(path: "sessions", directoryHint: .isDirectory),
            location: .active
        )
        result += try scanSessionDirectory(
            codexHome.appending(path: "archived_sessions", directoryHint: .isDirectory),
            location: .archived
        )
        return result
    }

    func scanPluginVersions(in codexHome: URL) throws -> [PluginVersionItem] {
        let cache = codexHome.appending(path: "plugins/cache", directoryHint: .isDirectory)
        let manager = FileManager()
        guard manager.fileExists(atPath: cache.path) else { return [] }

        var result: [PluginVersionItem] = []
        for marketplaceURL in childDirectories(of: cache, manager: manager) {
            for pluginURL in childDirectories(of: marketplaceURL, manager: manager) {
                for versionURL in childDirectories(of: pluginURL, manager: manager) {
                    let manifest = versionURL.appending(path: ".codex-plugin/plugin.json")
                    guard manager.fileExists(atPath: manifest.path) else { continue }
                    result.append(
                        PluginVersionItem(
                            marketplace: marketplaceURL.lastPathComponent,
                            plugin: pluginURL.lastPathComponent,
                            version: versionURL.lastPathComponent,
                            directoryURL: versionURL,
                            bytes: allocatedSize(of: versionURL)
                        )
                    )
                }
            }
        }
        return result
    }

    private func scanSessionDirectory(
        _ directory: URL,
        location: SessionLocation
    ) throws -> [SessionItem] {
        let manager = FileManager()
        guard manager.fileExists(atPath: directory.path) else { return [] }
        guard let enumerator = manager.enumerator(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey, .fileAllocatedSizeKey, .totalFileAllocatedSizeKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var result: [SessionItem] = []
        for case let fileURL as URL in enumerator {
            let name = fileURL.lastPathComponent
            guard name.hasSuffix(".jsonl") || name.hasSuffix(".jsonl.zst") else { continue }
            let values = try? fileURL.resourceValues(forKeys: [
                .isRegularFileKey,
                .contentModificationDateKey,
                .fileAllocatedSizeKey,
                .totalFileAllocatedSizeKey,
                .fileSizeKey
            ])
            guard values?.isRegularFile == true else { continue }

            let compressed = name.hasSuffix(".zst")
            let probe = compressed ? SessionProbe() : probeSession(fileURL)
            let fallbackID = sessionID(from: name)
            let valuesAfterScan = try? fileURL.resourceValues(forKeys: [
                .contentModificationDateKey,
                .fileSizeKey
            ])
            let changedDuringScan = valuesAfterScan?.contentModificationDate != values?.contentModificationDate
                || valuesAfterScan?.fileSize != values?.fileSize
            result.append(
                SessionItem(
                    id: fileURL.standardizedFileURL.path,
                    threadID: probe.id ?? fallbackID,
                    fileURL: fileURL,
                    location: location,
                    modifiedAt: values?.contentModificationDate ?? .distantPast,
                    totalBytes: Int64(values?.totalFileAllocatedSize ?? values?.fileAllocatedSize ?? values?.fileSize ?? 0),
                    embeddedImageBytes: probe.embeddedImageBytes,
                    embeddedImageCount: probe.imageCount,
                    workingDirectory: probe.workingDirectory,
                    isCompressed: compressed,
                    isUnstable: changedDuringScan,
                    parseWarnings: probe.parseWarnings
                )
            )
        }
        return result
    }

    private func probeSession(_ fileURL: URL) -> SessionProbe {
        var probe = SessionProbe()
        do {
            if let metadata = try firstLine(in: fileURL, limit: 8 * 1_048_576) {
                do {
                    let object = try JSONSerialization.jsonObject(with: metadata)
                    readMetadata(from: object, into: &probe)
                } catch {
                    probe.parseWarnings += 1
                }
            }

            let imageResult = try EmbeddedImageScanner(chunkSize: chunkSize).scan(fileURL)
            probe.embeddedImageBytes = imageResult.uriBytes
            probe.imageCount = imageResult.count
            probe.parseWarnings += imageResult.truncatedCandidates
        } catch {
            probe.parseWarnings += 1
        }
        return probe
    }

    private func readMetadata(from object: Any, into probe: inout SessionProbe) {
        guard
            let root = object as? [String: Any],
            root["type"] as? String == "session_meta",
            let payload = root["payload"] as? [String: Any]
        else { return }
        probe.id = payload["id"] as? String
        probe.workingDirectory = payload["cwd"] as? String
    }

    private func firstLine(in fileURL: URL, limit: Int) throws -> Data? {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }

        var buffer = Data()
        while buffer.count <= limit,
              let chunk = try handle.read(upToCount: min(chunkSize, limit - buffer.count + 1)),
              !chunk.isEmpty {
            buffer.append(chunk)
            if let newline = buffer.firstIndex(of: 0x0A) {
                return Data(buffer[..<newline])
            }
        }
        guard !buffer.isEmpty, buffer.count <= limit else { return nil }
        return buffer
    }

    private func storageBreakdown(home: URL) -> [StorageItem] {
        let library = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library")
        let definitions: [(StorageKind, String, String, [URL], Bool)] = [
            (.temporary, "临时文件", "安装暂存、插件拉取和任务临时目录", [home.appending(path: ".tmp")], true),
            (.logs, "日志数据库", "logs_*.sqlite、WAL 与辅助日志", logDatabaseURLs(in: home), true),
            (.plugins, "插件缓存", "本地缓存的插件及其版本", [home.appending(path: "plugins/cache")], false),
            (.generatedImages, "生成图片", "按任务保存的本地生成图片", [home.appending(path: "generated_images")], false),
            (.computerUse, "Computer Use", "浏览器与电脑操作产生的本地资产", [home.appending(path: "computer-use")], false),
            (.activeSessions, "普通会话", "默认任务列表中的 rollout 文件", [home.appending(path: "sessions")], false),
            (.archivedSessions, "归档会话", "从默认列表隐藏，但没有压缩或删除", [home.appending(path: "archived_sessions")], false),
            (.appCache, "应用缓存与日志", "macOS Library 中 Codex 的可重建缓存和日志", [
                library.appending(path: "Caches/Codex"),
                library.appending(path: "Caches/com.openai.codex"),
                library.appending(path: "Logs/com.openai.codex")
            ], true)
        ]

        return definitions.map { kind, title, detail, paths, recommended in
            StorageItem(
                id: kind.rawValue,
                kind: kind,
                title: title,
                detail: detail,
                bytes: paths.reduce(Int64(0)) { $0 + allocatedSize(of: $1) },
                paths: paths.filter { FileManager.default.fileExists(atPath: $0.path) },
                recommended: recommended
            )
        }
    }

    private func logDatabaseURLs(in home: URL) -> [URL] {
        let manager = FileManager()
        let children = (try? manager.contentsOfDirectory(
            at: home,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        return children.filter {
            let name = $0.lastPathComponent
            return name.hasPrefix("logs_") && (name.contains(".sqlite") || name.hasSuffix(".db"))
        }
    }

    private func childDirectories(of url: URL, manager: FileManager) -> [URL] {
        let children = (try? manager.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        return children.filter {
            (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
        }
    }

    private func allocatedSize(of url: URL) -> Int64 {
        let manager = FileManager()
        var isDirectory: ObjCBool = false
        guard manager.fileExists(atPath: url.path, isDirectory: &isDirectory) else { return 0 }
        if !isDirectory.boolValue {
            let values = try? url.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .fileAllocatedSizeKey, .fileSizeKey])
            return Int64(values?.totalFileAllocatedSize ?? values?.fileAllocatedSize ?? values?.fileSize ?? 0)
        }

        guard let enumerator = manager.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey, .fileSizeKey],
            options: [.skipsPackageDescendants]
        ) else { return 0 }

        var total: Int64 = 0
        for case let fileURL as URL in enumerator {
            let values = try? fileURL.resourceValues(forKeys: [
                .isRegularFileKey,
                .totalFileAllocatedSizeKey,
                .fileAllocatedSizeKey,
                .fileSizeKey
            ])
            guard values?.isRegularFile == true else { continue }
            total += Int64(values?.totalFileAllocatedSize ?? values?.fileAllocatedSize ?? values?.fileSize ?? 0)
        }
        return total
    }

    private func sessionID(from filename: String) -> String {
        var value = filename
        if value.hasSuffix(".zst") { value.removeLast(4) }
        if value.hasSuffix(".jsonl") { value.removeLast(6) }
        let suffix = String(value.suffix(36))
        if UUID(uuidString: suffix) != nil {
            return suffix
        }
        return value
    }
}

private struct SessionProbe {
    var id: String?
    var workingDirectory: String?
    var embeddedImageBytes: Int64 = 0
    var imageCount = 0
    var parseWarnings = 0
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

private struct JSONStringImageCounter {
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
