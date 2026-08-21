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
    }

    @Test func scansRealCodexHomeOnlyWhenExplicitlyEnabled() throws {
        guard ProcessInfo.processInfo.environment["CODEX_CLEANER_REAL_SCAN"] == "1" else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".codex")

        let snapshot = try CodexStorageScanner().scan(codexHome: home)
        let imageBytes = snapshot.sessions.reduce(Int64(0)) { $0 + $1.embeddedImageBytes }
        print(
            "REAL_SCAN total=\(snapshot.totalCodexBytes) sessions=\(snapshot.sessions.count) "
                + "images=\(imageBytes) plugins=\(snapshot.pluginVersions.count)"
        )

        #expect(snapshot.totalCodexBytes > 0)
        #expect(!snapshot.sessions.isEmpty)
    }
}

private struct TemporaryFixture {
    let root: URL

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appending(path: "CleanMyCodexTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func directory(_ relativePath: String) -> URL {
        let url = root.appending(path: relativePath, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func file(_ relativePath: String) -> URL {
        root.appending(path: relativePath)
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }
}
