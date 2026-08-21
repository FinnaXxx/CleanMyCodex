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
}
