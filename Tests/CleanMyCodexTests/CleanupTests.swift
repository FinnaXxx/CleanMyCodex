import Foundation
import Testing
@testable import CleanMyCodex

struct ProtectedPathTests {
    @Test func rejectsCredentialsConfigurationAndStateDatabases() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        try fixture.write("secret", to: "auth.json")
        try fixture.write("[settings]", to: "config.toml")
        try fixture.write("state", to: "state_1.sqlite")
        try fixture.write("rule", to: "rules/team.md")

        let guards = ProtectedPaths(locations: CodexLocations(home: fixture.root, library: fixture.directory("Library")))

        #expect(throws: CleanupGuardError.self) { try guards.validate(fixture.file("auth.json")) }
        #expect(throws: CleanupGuardError.self) { try guards.validate(fixture.file("config.toml")) }
        #expect(throws: CleanupGuardError.self) { try guards.validate(fixture.file("state_1.sqlite")) }
        #expect(throws: CleanupGuardError.self) { try guards.validate(fixture.file("rules/team.md")) }
        #expect(throws: CleanupGuardError.self) { try guards.validate(fixture.root) }
        #expect(throws: CleanupGuardError.self) {
            try guards.validate(FileManager.default.homeDirectoryForCurrentUser.appending(path: "Documents"))
        }
    }

    @Test func allowsTemporaryDirectoriesAndLogDatabases() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let staging = fixture.directory(".tmp/openai-bundled.staging-1")
        try fixture.write("log", to: "logs_2.sqlite")

        let guards = ProtectedPaths(locations: CodexLocations(home: fixture.root, library: fixture.directory("Library")))

        try guards.validate(staging)
        try guards.validate(fixture.file("logs_2.sqlite"))
    }

    @Test func protectsTheActivePluginVersion() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let current = fixture.directory("plugins/cache/personal/example/2.0.0")
        let old = fixture.directory("plugins/cache/personal/example/1.0.0")

        let guards = ProtectedPaths(
            locations: CodexLocations(home: fixture.root, library: fixture.directory("Library")),
            activePluginDirectories: [current]
        )

        #expect(throws: CleanupGuardError.self) { try guards.validate(current) }
        #expect(throws: CleanupGuardError.self) { try guards.validate(current.appending(path: ".venv")) }
        try guards.validate(old)
    }

    @Test func containsComparesWholePathComponents() {
        let root = URL(fileURLWithPath: "/tmp/codex/log")
        #expect(ProtectedPaths.contains(root, URL(fileURLWithPath: "/tmp/codex/log/a.txt")))
        #expect(!ProtectedPaths.contains(root, URL(fileURLWithPath: "/tmp/codex/logs_2.sqlite")))
    }
}

struct CleanupEngineTests {
    @Test func refusesToTrashProtectedFiles() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let auth = try fixture.write("secret", to: "auth.json")
        let engine = CleanupEngine(
            locations: CodexLocations(home: fixture.root, library: fixture.directory("Library"))
        )

        let report = engine.run(tasks: [
            CleanupTask(
                id: "auth",
                title: "auth.json",
                detail: "",
                url: auth,
                method: .trash,
                expectedBytes: 6
            )
        ])

        #expect(report.freedBytes == 0)
        #expect(report.problems.count == 1)
        #expect(FileManager.default.fileExists(atPath: auth.path))
    }

    @Test func skipsPathsThatAreAlreadyGone() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let engine = CleanupEngine(
            locations: CodexLocations(home: fixture.root, library: fixture.directory("Library"))
        )

        let report = engine.run(tasks: [
            CleanupTask(
                id: "missing",
                title: "已删除的目录",
                detail: "",
                url: fixture.file(".tmp/gone"),
                method: .trash,
                expectedBytes: 10
            )
        ])

        #expect(report.outcomes.first?.status == .skipped("路径已不存在"))
    }

    @Test func threadDeletionFailsLoudlyWithoutAnAppServer() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let rollout = try fixture.write("{}", to: "sessions/rollout-abc.jsonl")
        let engine = CleanupEngine(
            locations: CodexLocations(home: fixture.root, library: fixture.directory("Library")),
            appServer: CodexAppServerClient(
                codexHome: fixture.root,
                executableURL: fixture.file("nonexistent-codex")
            )
        )

        let report = engine.run(tasks: [
            CleanupTask(
                id: "thread",
                title: "会话",
                detail: "",
                url: rollout,
                method: .deleteThread,
                expectedBytes: 2,
                threadID: "abc"
            )
        ])

        #expect(report.problems.count == 1)
        #expect(FileManager.default.fileExists(atPath: rollout.path))
    }
}

struct SQLiteMaintenanceTests {
    @Test func inspectReportsFreePagesAndCompactionShrinksTheFile() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let database = fixture.file("logs_2.sqlite")
        SQLiteFixture.makeLogDatabase(at: database)

        let maintenance = SQLiteMaintenance()
        let inspection = try maintenance.inspect(database)
        #expect(inspection.freeListCount > 0)
        #expect(inspection.reclaimableBytes > 1_048_576)

        let report = try maintenance.compact(database)
        #expect(report.integrityOK)
        #expect(report.freedBytes > 1_048_576)
        #expect(report.afterBytes < report.beforeBytes)

        let afterInspection = try maintenance.inspect(database)
        #expect(afterInspection.freeListCount == 0)
    }
}

struct CleanupPlannerTests {
    private func snapshot(with sessions: [SessionItem]) -> ScanSnapshot {
        ScanSnapshot(
            codexHome: URL(fileURLWithPath: "/tmp/codex"),
            scannedAt: .now,
            totalCodexBytes: 0,
            externalBytes: 0,
            categories: [],
            sessions: sessions,
            pluginVersions: [],
            notes: []
        )
    }

    private func session(
        id: String,
        location: SessionLocation,
        ageDays: Int,
        unstable: Bool = false
    ) -> SessionItem {
        SessionItem(
            id: id,
            threadID: id,
            fileURL: URL(fileURLWithPath: "/tmp/codex/sessions/\(id).jsonl"),
            location: location,
            modifiedAt: Calendar.current.date(byAdding: .day, value: -ageDays, to: .now) ?? .distantPast,
            fileBytes: 1_024,
            assetBytes: 0,
            assetURLs: [],
            embeddedImageBytes: 0,
            embeddedImageCount: 0,
            workingDirectory: nil,
            title: nil,
            preview: nil,
            tags: [],
            isCompressed: false,
            isUnstable: unstable,
            parseWarnings: 0
        )
    }

    @Test func automaticSessionSelectionRespectsRetentionAndScope() {
        var settings = AutomationSettings()
        settings.cleanArchivedSessions = true
        settings.archivedRetentionDays = 180
        settings.cleanActiveSessions = false

        let snapshot = snapshot(with: [
            session(id: "old-archived", location: .archived, ageDays: 400),
            session(id: "new-archived", location: .archived, ageDays: 10),
            session(id: "old-active", location: .active, ageDays: 400),
            session(id: "writing", location: .archived, ageDays: 400, unstable: true)
        ])

        let chosen = CleanupPlanner.automaticSessions(in: snapshot, settings: settings).map(\.id)

        #expect(chosen == ["old-archived"])
    }

    @Test func sessionTasksCarryThreadIDAndAssets() {
        let assets = [URL(fileURLWithPath: "/tmp/codex/generated_images/abc")]
        let item = SessionItem(
            id: "abc",
            threadID: "abc",
            fileURL: URL(fileURLWithPath: "/tmp/codex/sessions/abc.jsonl"),
            location: .archived,
            modifiedAt: .now,
            fileBytes: 10,
            assetBytes: 20,
            assetURLs: assets,
            embeddedImageBytes: 0,
            embeddedImageCount: 0,
            workingDirectory: nil,
            title: nil,
            preview: nil,
            tags: [],
            isCompressed: false,
            isUnstable: false,
            parseWarnings: 0
        )

        let viaAppServer = CleanupPlanner.sessionTasks(for: [item], mode: .appServer)
        #expect(viaAppServer.first?.method == .deleteThread)
        #expect(viaAppServer.first?.threadID == "abc")
        #expect(viaAppServer.first?.companionURLs == assets)
        #expect(viaAppServer.first?.expectedBytes == 30)

        let viaTrash = CleanupPlanner.sessionTasks(for: [item], mode: .trash)
        #expect(viaTrash.first?.method == .trash)
    }

    @Test func plannerNeverBuildsTasksForProtectedEntries() {
        let entries = [
            StorageEntry(title: "auth.json", detail: "", url: URL(fileURLWithPath: "/tmp/codex/auth.json"), bytes: 1, risk: .shielded),
            StorageEntry(title: "缓存", detail: "", url: URL(fileURLWithPath: "/tmp/codex/.tmp/a"), bytes: 2, risk: .safe)
        ]

        let tasks = CleanupPlanner.tasks(for: entries)

        #expect(tasks.count == 1)
        #expect(tasks.first?.title == "缓存")
    }
}

struct AppServerParsingTests {
    @Test func parsesPluginListFromObjectAndArrayShapes() {
        let object: [String: Any] = [
            "plugins": [
                ["name": "example", "version": "2.0.0", "path": "/tmp/codex/plugins/cache/personal/example/2.0.0"]
            ]
        ]
        let parsedObject = CodexAppServerClient.parsePlugins(object)
        #expect(parsedObject.count == 1)
        #expect(parsedObject.first?.name == "example")
        #expect(parsedObject.first?.version == "2.0.0")
        #expect(parsedObject.first?.directory?.lastPathComponent == "2.0.0")

        let array: [[String: Any]] = [["id": "browser", "installedVersion": "26.814"]]
        let parsedArray = CodexAppServerClient.parsePlugins(array)
        #expect(parsedArray.first?.name == "browser")
        #expect(parsedArray.first?.version == "26.814")
        #expect(parsedArray.first?.directory == nil)

        #expect(CodexAppServerClient.parsePlugins(nil).isEmpty)
    }

    /// The shape `codex app-server` actually answers with: plugins nested per
    /// marketplace, the version under `localVersion`, the path under `source`.
    @Test func parsesMarketplaceShapedPluginList() {
        let response: [String: Any] = [
            "marketplaces": [
                [
                    "name": "personal",
                    "plugins": [
                        [
                            "id": "codex-seo@personal",
                            "name": "codex-seo",
                            "localVersion": "1.9.6+codex.5",
                            "source": ["type": "local", "path": "/Users/someone/plugins/codex-seo"],
                            "installed": true,
                            "enabled": true
                        ]
                    ]
                ]
            ]
        ]

        let parsed = CodexAppServerClient.parsePlugins(response)

        #expect(parsed.count == 1)
        #expect(parsed.first?.name == "codex-seo")
        #expect(parsed.first?.version == "1.9.6+codex.5")
        #expect(parsed.first?.directory?.path == "/Users/someone/plugins/codex-seo")
    }

    @Test func versionMatchingIgnoresCaseAndVPrefix() {
        #expect(CodexStorageScanner.normalizedVersion("v1.9.6+Codex.5") == "1.9.6+codex.5")
        #expect(CodexStorageScanner.normalizedVersion("1.9.6+codex.5") == "1.9.6+codex.5")
        #expect(CodexStorageScanner.normalizedVersion("  ") == nil)
        #expect(CodexStorageScanner.normalizedVersion(nil) == nil)
    }
}

struct SessionPreviewTests {
    @Test func readsTheFirstUserMessageAsATitle() {
        let line = Data(#"{"type":"event_msg","payload":{"type":"user_message","message":"帮我修一下扫描器的进度条"}}"#.utf8)
        #expect(SessionContentScanner.parsePreview(line) == "帮我修一下扫描器的进度条")
    }

    @Test func readsResponseItemUserMessages() {
        let line = Data(#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"add a retry to the uploader"}]}}"#.utf8)
        #expect(SessionContentScanner.parsePreview(line) == "add a retry to the uploader")
    }

    @Test func skipsInjectedContextTurns() {
        let line = Data(#"{"payload":{"role":"user","content":[{"type":"input_text","text":"<environment_context>cwd=/tmp</environment_context>"}]}}"#.utf8)
        #expect(SessionContentScanner.parsePreview(line) == nil)
    }

    @Test func collapsesWhitespaceAndTruncates() throws {
        let long = String(repeating: "字", count: 200)
        let line = Data("{\"payload\":{\"type\":\"user_message\",\"message\":\"\(long)\"}}".utf8)
        let preview = try #require(SessionContentScanner.parsePreview(line))
        #expect(preview.count == 91)
        #expect(preview.hasSuffix("…"))

        let messy = Data(#"{"payload":{"type":"user_message","message":"  first line\nsecond   line  "}}"#.utf8)
        #expect(SessionContentScanner.parsePreview(messy) == "first line second line")
    }

    @Test func headerReaderStopsAfterMetadataAndPreview() {
        var reader = SessionHeaderReader()
        let meta = #"{"type":"session_meta","payload":{"id":"abc","cwd":"/Users/someone/work/api"}}"#
        let user = #"{"type":"event_msg","payload":{"type":"user_message","message":"写个测试"}}"#
        reader.consume(Data((meta + "
" + user + "
").utf8))
        reader.finish()

        #expect(reader.metadata?.id == "abc")
        #expect(reader.metadata?.workingDirectory == "/Users/someone/work/api")
        #expect(reader.preview == "写个测试")
        #expect(reader.isFinished)
    }

    @Test func headerReaderSkipsOversizedLinesInsteadOfBufferingThem() {
        var reader = SessionHeaderReader()
        let huge = #"{"payload":{"type":"user_message","message":""# + String(repeating: "A", count: 300_000) + #""}}"#
        let user = #"{"type":"event_msg","payload":{"type":"user_message","message":"真正的第一句"}}"#
        reader.consume(Data((huge + "
" + user + "
").utf8))
        reader.finish()

        #expect(reader.preview == "真正的第一句")
    }

    @Test func fallsBackFromTitleToPreviewToProject() {
        let base = SessionItem(
            id: "a",
            threadID: "0123456789abcdef",
            fileURL: URL(fileURLWithPath: "/tmp/a.jsonl"),
            location: .active,
            modifiedAt: .now,
            fileBytes: 1,
            assetBytes: 0,
            assetURLs: [],
            embeddedImageBytes: 0,
            embeddedImageCount: 0,
            workingDirectory: "/Users/someone/work/api",
            title: nil,
            preview: "修一下登录",
            tags: [],
            isCompressed: false,
            isUnstable: false,
            parseWarnings: 0
        )
        #expect(base.displayName == "修一下登录")
        #expect(base.projectName == "api")
        #expect(base.hasTitle)
    }
}
