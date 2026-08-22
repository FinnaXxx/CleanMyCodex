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

struct CodexRunningTests {
    private func locations(_ fixture: TemporaryFixture) -> CodexLocations {
        CodexLocations(
            home: fixture.directory("codex"),
            library: fixture.directory("Library"),
            documents: fixture.directory("Documents")
        )
    }

    /// Codex being open must not hold up the work that does not need the file to itself.
    @Test func cachesAreCleanedWhileCodexRunsAndOnlyExclusiveWorkIsDeferred() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)

        let cache = fixture.directory("Library/Caches/Codex/blob")
        try Data(repeating: 0x41, count: 30_000).write(to: cache.appending(path: "payload.bin"))
        let database = fixture.file("codex/logs_2.sqlite")
        SQLiteFixture.makeLogDatabase(at: database)

        let engine = CleanupEngine(locations: places, isCodexRunning: { true })
        let report = engine.run(tasks: [
            CleanupTask(
                id: "cache",
                title: "browser-cache",
                detail: "",
                url: cache,
                method: .trash,
                expectedBytes: 30_000
            ),
            CleanupTask(
                id: "db",
                title: "logs_2.sqlite",
                detail: "",
                url: database,
                method: .compactDatabase,
                expectedBytes: 1_000
            )
        ])

        let cacheOutcome = try #require(report.outcomes.first { $0.id == "cache" })
        #expect(cacheOutcome.status == .succeeded)
        #expect(cacheOutcome.freedBytes > 0)
        #expect(!FileManager.default.fileExists(atPath: cache.path))

        let databaseOutcome = try #require(report.outcomes.first { $0.id == "db" })
        if case let .skipped(reason) = databaseOutcome.status {
            #expect(reason.contains("Codex"))
        } else {
            Issue.record("压缩应该被推迟，实际是 \(databaseOutcome.status)")
        }
        // Deferred means untouched, not lost.
        #expect(FileManager.default.fileExists(atPath: database.path))
    }

    @Test func everythingRunsWhenCodexIsClosed() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)
        let database = fixture.file("codex/logs_2.sqlite")
        SQLiteFixture.makeLogDatabase(at: database)

        let engine = CleanupEngine(locations: places, isCodexRunning: { false })
        let report = engine.run(tasks: [
            CleanupTask(
                id: "db",
                title: "logs_2.sqlite",
                detail: "",
                url: database,
                method: .compactDatabase,
                expectedBytes: 1_000
            )
        ])

        #expect(report.outcomes.first?.status == .succeeded)
        #expect(FileManager.default.fileExists(atPath: database.path))
    }

    /// An upgrade unpacking right now looks like a leftover; it must be left alone.
    @Test func freshStagingDirectoriesAreNotTreatedAsLeftovers() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let inFlight = fixture.directory(".tmp/openai-bundled.staging-inflight")
        try Data(repeating: 0x41, count: 50_000).write(to: inFlight.appending(path: "payload.bin"))
        let abandoned = fixture.directory(".tmp/openai-bundled.staging-old")
        try Data(repeating: 0x42, count: 50_000).write(to: abandoned.appending(path: "payload.bin"))
        fixture.ageTree(".tmp/openai-bundled.staging-old", hours: 6)

        let snapshot = try CodexStorageScanner(libraryDirectory: fixture.directory("Library"))
            .scan(codexHome: fixture.root)
        let temporary = try #require(snapshot.categories.first { $0.kind == .temporary })
        let names = temporary.entries.map(\.title)

        #expect(names.contains("openai-bundled.staging-old"))
        #expect(!names.contains("openai-bundled.staging-inflight"))
    }

    /// The hazard the timestamp rule exists for: a directory whose own mtime is old
    /// while an unpack is writing deep inside it.
    @Test func activityDeepInsideCountsEvenWhenTheFolderLooksOld() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let staging = fixture.directory(".tmp/openai-bundled.staging-deep")
        let nested = fixture.directory(".tmp/openai-bundled.staging-deep/plugins/browser")
        try Data(repeating: 0x41, count: 50_000).write(to: nested.appending(path: "payload.bin"))
        // Backdate only the top folder, the way a subdirectory write leaves it.
        fixture.age(".tmp/openai-bundled.staging-deep", hours: 6)
        fixture.age(".tmp/openai-bundled.staging-deep/plugins", hours: 6)

        let measured = CodexStorageScanner.measure(staging, reporter: nil, isCancelled: { false })
        #expect(measured.latestActivity > Date(timeIntervalSinceNow: -600))

        let snapshot = try CodexStorageScanner(libraryDirectory: fixture.directory("Library"))
            .scan(codexHome: fixture.root)
        let temporary = snapshot.categories.first { $0.kind == .temporary }
        #expect(temporary?.entries.contains { $0.title == "openai-bundled.staging-deep" } != true)
    }

    /// Between the scan and the deletion, something started writing again.
    @Test func aTargetTouchedAfterTheScanIsNotDeleted() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)
        let staging = fixture.directory("codex/.tmp/openai-bundled.staging-race")
        try Data(repeating: 0x41, count: 50_000).write(to: staging.appending(path: "payload.bin"))

        let engine = CleanupEngine(locations: places, isCodexRunning: { false })
        let report = engine.run(tasks: [
            CleanupTask(
                id: "staging",
                title: "openai-bundled.staging-race",
                detail: "",
                url: staging,
                method: .trash,
                expectedBytes: 50_000,
                minimumIdleSeconds: 3_600
            )
        ])

        if case let .skipped(reason) = report.outcomes.first?.status {
            #expect(reason.contains("写入"))
        } else {
            Issue.record("应该被推迟，实际是 \(String(describing: report.outcomes.first?.status))")
        }
        #expect(FileManager.default.fileExists(atPath: staging.path))
    }

    /// The user's call: `.tmp` is Codex' unpack area, so it waits for Codex to be gone
    /// rather than relying on an idle-time guess, the same way slimming does.
    @Test func temporaryScratchIsDeferredWhileCodexRuns() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)
        let staging = fixture.directory("codex/.tmp/openai-bundled.staging-gated")
        try Data(repeating: 0x41, count: 50_000).write(to: staging.appending(path: "payload.bin"))
        fixture.ageTree("codex/.tmp/openai-bundled.staging-gated", hours: 6)

        let task = CleanupTask(
            id: "staging",
            title: "openai-bundled.staging-gated",
            detail: "",
            url: staging,
            method: .trash,
            expectedBytes: 50_000,
            minimumIdleSeconds: 3_600,
            requiresCodexStopped: true
        )

        let running = CleanupEngine(locations: places, isCodexRunning: { true }).run(tasks: [task])
        if case let .skipped(reason) = running.outcomes.first?.status {
            #expect(reason.contains("Codex"))
        } else {
            Issue.record("应该被推迟，实际是 \(String(describing: running.outcomes.first?.status))")
        }
        #expect(FileManager.default.fileExists(atPath: staging.path))

        // Same task, Codex gone: it goes through.
        let stopped = CleanupEngine(locations: places, isCodexRunning: { false }).run(tasks: [task])
        #expect(stopped.outcomes.first?.status == .succeeded)
        #expect(!FileManager.default.fileExists(atPath: staging.path))
    }

    @Test func scannerMarksTemporaryEntriesAsNeedingCodexStopped() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let staging = fixture.directory(".tmp/openai-bundled.staging-old")
        try Data(repeating: 0x41, count: 50_000).write(to: staging.appending(path: "payload.bin"))
        fixture.ageTree(".tmp/openai-bundled.staging-old", hours: 6)

        let snapshot = try CodexStorageScanner(libraryDirectory: fixture.directory("Library"))
            .scan(codexHome: fixture.root)
        let temporary = try #require(snapshot.categories.first { $0.kind == .temporary })

        #expect(temporary.entries.allSatisfy(\.requiresCodexStopped))
        // Caches outside ~/.codex carry no such requirement.
        let caches = snapshot.categories.filter { $0.kind == .appCache || $0.kind == .browserCache }
        #expect(caches.flatMap(\.entries).allSatisfy { !$0.requiresCodexStopped })
    }

    @Test func aTargetThatStayedIdleIsStillDeleted() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)
        let staging = fixture.directory("codex/.tmp/openai-bundled.staging-settled")
        try Data(repeating: 0x41, count: 50_000).write(to: staging.appending(path: "payload.bin"))
        fixture.ageTree("codex/.tmp/openai-bundled.staging-settled", hours: 6)

        let engine = CleanupEngine(locations: places, isCodexRunning: { false })
        let report = engine.run(tasks: [
            CleanupTask(
                id: "staging",
                title: "openai-bundled.staging-settled",
                detail: "",
                url: staging,
                method: .trash,
                expectedBytes: 50_000,
                minimumIdleSeconds: 3_600
            )
        ])

        #expect(report.outcomes.first?.status == .succeeded)
        #expect(!FileManager.default.fileExists(atPath: staging.path))
    }
}

struct CodexLifecycleTests {
    /// A terminal session may be mid-task, so it is never something we offer to close.
    @Test func onlyTerminalSessionsCountAsCommandLineBlockers() {
        let commands = [
            "/Applications/Codex.app/Contents/MacOS/Codex",
            "/Applications/Codex.app/Contents/MacOS/Codex Helper (Renderer)",
            "codex",
            "/opt/homebrew/bin/codex app-server",
            "/Users/someone/.codex/bin/codex exec 'fix the tests'",
            "/usr/bin/ssh codex-host",
            "vim codex.swift"
        ]

        let cli = CodexRuntimeProbe.cliCommands(from: commands)

        #expect(cli.contains("codex"))
        #expect(cli.contains("/opt/homebrew/bin/codex app-server"))
        #expect(cli.contains("/Users/someone/.codex/bin/codex exec 'fix the tests'"))
        #expect(!cli.contains(where: { $0.contains("Codex.app/Contents/MacOS") }))
        // Neither of these is Codex.
        #expect(!cli.contains("/usr/bin/ssh codex-host"))
        #expect(!cli.contains("vim codex.swift"))
    }

    @Test func exclusiveWorkIsIdentifiedForTheRestartPrompt() {
        let tasks = [
            CleanupTask(
                id: "cache",
                title: "浏览器缓存",
                detail: "",
                url: URL(fileURLWithPath: "/tmp/codex/cache"),
                method: .trash,
                expectedBytes: 1
            ),
            CleanupTask(
                id: "staging",
                title: "openai-bundled.staging-1",
                detail: "",
                url: URL(fileURLWithPath: "/tmp/codex/.tmp/staging"),
                method: .trash,
                expectedBytes: 1,
                requiresCodexStopped: true
            ),
            CleanupTask(
                id: "db",
                title: "logs_2.sqlite",
                detail: "",
                url: URL(fileURLWithPath: "/tmp/codex/logs_2.sqlite"),
                method: .compactDatabase,
                expectedBytes: 1
            ),
            CleanupTask(
                id: "slim",
                title: "会话",
                detail: "",
                url: URL(fileURLWithPath: "/tmp/codex/sessions/a.jsonl"),
                method: .slimSession,
                expectedBytes: 1,
                slimMode: .deduplicate
            )
        ]

        let blocked = AppModel.requiresCodexStopped(tasks).map(\.id)

        #expect(blocked == ["staging", "db", "slim"])
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
            workspace: .empty(at: URL(fileURLWithPath: "/tmp/Documents/Codex")),
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
            distinctImageCount: 0,
            duplicateImageBytes: 0,
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
            distinctImageCount: 0,
            duplicateImageBytes: 0,
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

struct MarketplaceProtectionTests {
    @Test func readsLocalMarketplaceSourcesFromTOML() {
        let toml = """
        model = "gpt-5"

        [marketplaces.openai-bundled]
        source_type = "local"
        source = "/Users/someone/.codex/.tmp/bundled-marketplaces/openai-bundled"

        [marketplaces.remote]
        source_type = "git"
        source = "https://example.com/marketplace.git"
        """

        let sources = CodexConfiguration.marketplaceSources(inTOML: toml)

        #expect(sources.contains("/Users/someone/.codex/.tmp/bundled-marketplaces/openai-bundled"))
        #expect(sources.contains("https://example.com/marketplace.git"))
        // `source_type` must never be mistaken for `source`.
        #expect(!sources.contains("local"))
        #expect(!sources.contains("git"))
    }

    @Test func readsInlineTableForm() {
        let toml = #"marketplaces.openai-bundled = { source_type = "local", source = "~/.codex/.tmp/bundled-marketplaces/openai-bundled" }"#
        let sources = CodexConfiguration.marketplaceSources(inTOML: toml)
        #expect(sources == ["~/.codex/.tmp/bundled-marketplaces/openai-bundled"])
    }

    @Test func ignoresCommentedOutSources() {
        let toml = """
        [marketplaces.openai-bundled]
        # source = "/old/path"
        source = "/new/path"
        """
        #expect(CodexConfiguration.marketplaceSources(inTOML: toml) == ["/new/path"])
    }

    /// The bundled marketplace lives under `.tmp`, so it must be protected even when
    /// config.toml cannot be read at all.
    @Test func bundledMarketplaceIsProtectedWithoutConfig() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let locations = CodexLocations(home: fixture.root, library: fixture.directory("Library"))
        let guards = ProtectedPaths(locations: locations)

        let bundled = fixture.directory(".tmp/bundled-marketplaces/openai-bundled/plugins/browser")
        #expect(guards.isProtected(bundled))
        #expect(guards.isProtected(fixture.file(".tmp/bundled-marketplaces")))
        #expect(throws: CleanupGuardError.self) {
            try guards.validate(fixture.file(".tmp/bundled-marketplaces"))
        }

        // Upgrade leftovers sitting next to it are still fair game.
        let staging = fixture.file(".tmp/openai-bundled.staging-64e5ba9c")
        #expect(!guards.isProtected(staging))
    }

    /// Regression: containment was only checked one way, so deleting the parent of a
    /// protected directory was allowed and would have taken it along.
    @Test func deletingTheParentOfAProtectedPathIsRefused() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let locations = CodexLocations(home: fixture.root, library: fixture.directory("Library"))
        let active = fixture.directory("plugins/cache/personal/codex-seo/1.9.6+codex.5")
        let guards = ProtectedPaths(locations: locations, activePluginDirectories: [active])

        #expect(guards.isProtected(active))
        #expect(guards.isProtected(fixture.file("plugins/cache/personal/codex-seo")))
        #expect(guards.isProtected(fixture.file("plugins/cache")))
        #expect(throws: CleanupGuardError.self) {
            try guards.validate(fixture.file("plugins/cache/personal/codex-seo"))
        }

        // A sibling version is not a parent of anything protected.
        #expect(!guards.isProtected(fixture.file("plugins/cache/personal/codex-seo/1.0.0")))
    }

    @Test func configuredSourceOutsideTheBundledPathIsProtectedToo() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let locations = CodexLocations(home: fixture.root, library: fixture.directory("Library"))
        let custom = fixture.directory(".tmp/my-marketplace")
        try fixture.write(
            "[marketplaces.mine]\nsource_type = \"local\"\nsource = \"\(custom.path)\"\n",
            to: "config.toml"
        )

        let guards = ProtectedPaths(locations: locations)

        #expect(guards.isProtected(custom))
        #expect(throws: CleanupGuardError.self) { try guards.validate(custom) }
    }

    @Test func outermostDropsNestedDuplicates() {
        let parent = URL(fileURLWithPath: "/tmp/codex/.tmp/bundled-marketplaces")
        let child = parent.appending(path: "openai-bundled")
        let other = URL(fileURLWithPath: "/tmp/codex/.tmp/other")

        let result = ProtectedPaths.outermost([child, parent, other, parent]).map(\.path)

        #expect(result == [parent.path, other.path])
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

        let instructions = Data(#"{"payload":{"type":"user_message","message":"Here are the user_instructions:\n<user_instructions>be nice</user_instructions>"}}"#.utf8)
        #expect(SessionContentScanner.parsePreview(instructions) == nil)

        let agents = Data(#"{"payload":{"type":"user_message","message":"# AGENTS.md\nAlways run the tests."}}"#.utf8)
        #expect(SessionContentScanner.parsePreview(agents) == nil)
    }

    @Test func unwrapsTheRealRequestFromAPreamble() {
        let line = Data(#"{"payload":{"type":"user_message","message":"context blah blah My request for Codex: 把进度条修好"}}"#.utf8)
        #expect(SessionContentScanner.parsePreview(line) == "把进度条修好")
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
            distinctImageCount: 0,
            duplicateImageBytes: 0,
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
