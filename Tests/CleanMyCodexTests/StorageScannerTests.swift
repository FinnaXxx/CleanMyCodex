import Foundation
import Testing
@testable import CleanMyCodex

struct StorageScannerTests {
    @Test func imageScannerHandlesChunkBoundariesAndIgnoresRemoteURLs() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let first = "data:image/png;base64,QUJDRA=="
        let second = "data:image/jpeg;charset=utf-8;base64,AAEC"
        let json = "{\"a\":\"\(first)\",\"remote\":\"https://example.com/a.png\",\"b\":\"\(second)\"}\n"
        try Data(json.utf8).write(to: fixture.file("sample.jsonl"))

        let result = try EmbeddedImageScanner(chunkSize: 7).scan(fixture.file("sample.jsonl"))

        #expect(result.count == 2)
        #expect(result.uriBytes == Int64(first.utf8.count + second.utf8.count))
        #expect(result.base64Bytes == 12)
        #expect(result.truncatedCandidates == 0)
    }

    @Test func imageScannerCountsEscapedSlashAsPhysicalBytes() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let encoded = "data:image\\/png;base64,QUJD"
        try Data("{\"image_url\":\"\(encoded)\"}\n".utf8).write(to: fixture.file("escaped.jsonl"))

        let result = try EmbeddedImageScanner(chunkSize: 5).scan(fixture.file("escaped.jsonl"))

        #expect(result.count == 1)
        #expect(result.uriBytes == Int64(encoded.utf8.count))
    }

    @Test func sessionScanSeparatesActiveAndArchivedAndReadsMetadata() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let activeDir = fixture.directory("sessions/2026/08/21")
        let archivedDir = fixture.directory("archived_sessions")
        let id = "11111111-2222-3333-4444-555555555555"
        let metadata = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"\(id)\",\"cwd\":\"/tmp/demo\"}}\n"
        try Data((metadata + "{\"image_url\":\"data:image/png;base64,QUJD\"}\n").utf8)
            .write(to: activeDir.appending(path: "rollout-2026-08-21T00-00-00-\(id).jsonl"))
        try Data(metadata.utf8)
            .write(to: archivedDir.appending(path: "rollout-2026-08-20T00-00-00-\(id).jsonl"))

        let sessions = try CodexStorageScanner(chunkSize: 11).scanSessions(in: fixture.root)

        #expect(sessions.count == 2)
        #expect(sessions.contains { $0.location == .active && $0.threadID == id && $0.workingDirectory == "/tmp/demo" })
        #expect(sessions.contains { $0.location == .archived })
        #expect(sessions.first { $0.location == .active }?.embeddedImageBytes == 26)
    }

    @Test func sessionScanPicksUpToolTagsAcrossChunkBoundaries() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let id = "22222222-3333-4444-5555-666666666666"
        let metadata = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"\(id)\",\"cwd\":\"/tmp/demo\"}}\n"
        let body = "{\"tool\":\"browser_navigate\"}\n{\"tool\":\"image_gen\"}\n"
        try Data((metadata + body).utf8)
            .write(to: fixture.directory("sessions").appending(path: "rollout-\(id).jsonl"))

        let sessions = try CodexStorageScanner(chunkSize: 5).scanSessions(in: fixture.root)

        let tags = Set(sessions.first?.tags ?? [])
        #expect(tags.contains(.browser))
        #expect(tags.contains(.imageGen))
        #expect(!tags.contains(.computerUse))
    }

    @Test func sessionScanCountsGeneratedImagesAsAssets() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let id = "33333333-4444-5555-6666-777777777777"
        let metadata = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"\(id)\"}}\n"
        try Data(metadata.utf8)
            .write(to: fixture.directory("sessions").appending(path: "rollout-\(id).jsonl"))
        try Data(repeating: 0x41, count: 4_096)
            .write(to: fixture.directory("generated_images/\(id)").appending(path: "a.png"))

        let sessions = try CodexStorageScanner().scanSessions(in: fixture.root)

        #expect(sessions.count == 1)
        #expect((sessions.first?.assetBytes ?? 0) >= 4_096)
        #expect(sessions.first?.assetURLs.count == 1)
    }

    @Test func pluginScannerOnlyIncludesVersionDirectoriesWithManifest() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let valid = fixture.directory("plugins/cache/personal/example/1.2.3/.codex-plugin")
        try Data("{}".utf8).write(to: valid.appending(path: "plugin.json"))
        _ = fixture.directory("plugins/cache/personal/example/incomplete")

        let plugins = try CodexStorageScanner().scanPluginVersions(in: fixture.root)

        #expect(plugins.count == 1)
        #expect(plugins.first?.plugin == "example")
        #expect(plugins.first?.version == "1.2.3")
        #expect(plugins.first?.marketplace == "personal")
        #expect(plugins.first?.status == .unconfirmed)
    }

    @Test func pluginStatusMarksCurrentOutdatedAndOrphaned() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        for version in ["1.0.0", "2.0.0"] {
            let manifest = fixture.directory("plugins/cache/personal/example/\(version)/.codex-plugin")
            try Data("{\"name\":\"example\",\"version\":\"\(version)\"}".utf8)
                .write(to: manifest.appending(path: "plugin.json"))
        }
        let orphan = fixture.directory("plugins/cache/personal/gone/0.1.0/.codex-plugin")
        try Data("{\"name\":\"gone\",\"version\":\"0.1.0\"}".utf8)
            .write(to: orphan.appending(path: "plugin.json"))

        let scanner = CodexStorageScanner()
        let plugins = scanner.pluginVersions(
            in: scanner.locations(for: fixture.root),
            installedPlugins: [InstalledPlugin(name: "example", version: "2.0.0", directory: nil)],
            reporter: nil
        )

        #expect(plugins.first { $0.version == "2.0.0" }?.status == .current)
        #expect(plugins.first { $0.version == "1.0.0" }?.status == .outdated)
        #expect(plugins.first { $0.plugin == "gone" }?.status == .orphaned)
    }

    @Test func scanClassifiesTemporaryCachesAndProtectedData() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let library = fixture.directory("Library")

        let staging = fixture.directory(".tmp/openai-bundled.staging-1234")
        try Data(repeating: 0x41, count: 200_000).write(to: staging.appending(path: "payload.bin"))
        let marketplace = fixture.directory(".tmp/plugins-marketplace-cache")
        try Data(repeating: 0x42, count: 120_000).write(to: marketplace.appending(path: "index.json"))
        let fresh = fixture.directory(".tmp/in-flight")
        try Data(repeating: 0x43, count: 100_000).write(to: fresh.appending(path: "task.bin"))

        let cache = fixture.directory("Library/Caches/Codex")
        try Data(repeating: 0x44, count: 90_000).write(to: cache.appending(path: "blob"))

        try fixture.write("secret", to: "auth.json")
        try fixture.write("[settings]", to: "config.toml")

        let scanner = CodexStorageScanner(libraryDirectory: library)
        let snapshot = try scanner.scan(codexHome: fixture.root)

        let temporary = snapshot.categories.first { $0.kind == .temporary }
        #expect(temporary?.entries.contains { $0.title.contains("staging") } == true)
        #expect(temporary?.entries.contains { $0.title == "in-flight" } == false)

        let marketplaceCategory = snapshot.categories.first { $0.kind == .marketplaceCache }
        #expect(marketplaceCategory?.entries.count == 1)

        let appCache = snapshot.categories.first { $0.kind == .appCache }
        #expect((appCache?.bytes ?? 0) >= 90_000)

        let protectedConfig = snapshot.categories.first { $0.kind == .protectedConfig }
        #expect(protectedConfig?.entries.contains { $0.title == "auth.json" } == true)
        #expect(protectedConfig?.risk == .shielded)
        #expect(snapshot.categoryList(in: .recommended).allSatisfy { $0.risk.isSelectable })
    }

    @Test func scanReportsLogDatabaseFreeListAsReclaimable() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        SQLiteFixture.makeLogDatabase(at: fixture.file("logs_2.sqlite"))

        let scanner = CodexStorageScanner(libraryDirectory: fixture.directory("Library"))
        let snapshot = try scanner.scan(codexHome: fixture.root)

        let category = snapshot.categories.first { $0.kind == .logDatabase }
        #expect(category?.entries.count == 1)
        #expect(category?.entries.first?.method == .compactDatabase)
        #expect((category?.reclaimableBytes ?? 0) > 1_048_576)
        #expect((category?.reclaimableBytes ?? 0) < (category?.bytes ?? 0) + 1)
    }

    @Test func scanReportsProgressAndFinishesAtOne() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        try fixture.write("{}", to: "sessions/rollout-abc.jsonl")

        let box = ProgressBox()
        _ = try CodexStorageScanner(libraryDirectory: fixture.directory("Library"))
            .scan(codexHome: fixture.root) { progress in box.append(progress) }

        #expect(box.values.count > 1)
        #expect(box.values.last?.fraction == 1)
        #expect(box.values.contains { $0.stage == "会话" })
    }

    @Test func byteFormatUsesBinaryUnits() {
        #expect(ByteFormat.string(0) == "0 B")
        #expect(ByteFormat.string(512) == "512 B")
        #expect(ByteFormat.string(1_048_576) == "1.00 MiB")
        #expect(ByteFormat.string(1_073_741_824) == "1.00 GiB")
    }

    @Test func scansRealCodexHomeOnlyWhenExplicitlyEnabled() throws {
        guard ProcessInfo.processInfo.environment["CODEX_CLEANER_REAL_SCAN"] == "1" else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".codex")

        let snapshot = try CodexStorageScanner().scan(codexHome: home)
        print(
            "REAL_SCAN total=\(snapshot.totalCodexBytes) sessions=\(snapshot.sessions.count) "
                + "images=\(snapshot.embeddedImageBytes) plugins=\(snapshot.pluginVersions.count)"
        )

        #expect(snapshot.totalCodexBytes > 0)
        #expect(!snapshot.sessions.isEmpty)
    }
}

/// Collects progress callbacks from the scanner, which reports from the calling thread.
private final class ProgressBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [ScanProgress] = []

    var values: [ScanProgress] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func append(_ progress: ScanProgress) {
        lock.lock()
        storage.append(progress)
        lock.unlock()
    }
}
