import Foundation
import Testing
@testable import CleanMyCodex

struct WorkspaceTests {
    private func locations(_ fixture: TemporaryFixture) -> CodexLocations {
        CodexLocations(
            home: fixture.directory("codex"),
            library: fixture.directory("Library"),
            documents: fixture.directory("Documents")
        )
    }

    @Test func workspaceRootIsNeverATargetButItsFoldersAre() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)
        let guards = ProtectedPaths(locations: places)
        let day = fixture.directory("Documents/Codex/2026-08-21")

        #expect(throws: CleanupGuardError.self) { try guards.validate(places.workspace) }
        // A folder inside it is a legitimate target once the user picks it.
        try guards.validate(day)
        #expect(!guards.isProtected(day))
    }

    @Test func scanGroupsWorkspaceByDateAndSession() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)

        let work = fixture.directory("Documents/Codex/2026-08-21/new-chat/work")
        try Data(repeating: 0x41, count: 120_000).write(to: work.appending(path: "preview.html"))
        let outputs = fixture.directory("Documents/Codex/2026-08-21/new-chat/outputs")
        try Data(repeating: 0x42, count: 40_000).write(to: outputs.appending(path: "icon.png"))
        let older = fixture.directory("Documents/Codex/2026-08-01/other")
        try Data(repeating: 0x43, count: 10_000).write(to: older.appending(path: "notes.md"))

        let scanner = CodexStorageScanner(libraryDirectory: places.library)
        let snapshot = scanner.workspaceSnapshot(in: places, reporter: nil)

        #expect(snapshot.entries.count == 2)
        // Newest date first.
        #expect(snapshot.entries.first?.name == "2026-08-21")
        let day = try #require(snapshot.entries.first)
        #expect(day.bytes >= 160_000)
        #expect(day.children.count == 1)
        #expect(day.children.first?.name == "new-chat")
        #expect(day.totalFileCount == 2)
        #expect(snapshot.fileCount == 3)
    }

    @Test func gitCheckoutsAreFoundAndReportedPerFolder() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)
        let repository = fixture.directory("Documents/Codex/2026-08-21/new-chat/work/openai-codex")
        _ = fixture.directory("Documents/Codex/2026-08-21/new-chat/work/openai-codex/.git")
        try Data("print()".utf8).write(to: repository.appending(path: "main.swift"))

        let snapshot = CodexStorageScanner().workspaceSnapshot(in: places, reporter: nil)
        let session = try #require(snapshot.entries.first?.children.first)

        #expect(session.repositories.count == 1)
        #expect(session.repositories.first?.name == "openai-codex")
        // A bare `.git` directory is not a working repository, so git cannot vouch for it
        // and the state must not come back as "safe to delete".
        #expect(session.repositories.first?.state.isSafeToDelete == false)
        #expect(session.hasUnsafeRepository)
        #expect(snapshot.entries.first?.hasUnsafeRepository == true)
    }

    @Test func selectingAParentCoversItsChildrenAndCollapsesToOneTarget() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)
        for session in ["new-chat", "second"] {
            let directory = fixture.directory("Documents/Codex/2026-08-21/\(session)")
            try Data(repeating: 0x41, count: 20_000).write(to: directory.appending(path: "file.bin"))
        }

        let snapshot = CodexStorageScanner(libraryDirectory: places.library)
            .workspaceSnapshot(in: places, reporter: nil)
        let day = try #require(snapshot.entries.first)

        // Selecting the date folder means selecting it and both sessions…
        #expect(day.flattened.count == 3)
        // …but trashing it once already removes the children, so one target is enough.
        let targets = ProtectedPaths.outermost(day.flattened.map(\.url)).map(\.lastPathComponent)
        #expect(targets == ["2026-08-21"])
    }

    @Test func nothingIsPreselectedAfterAScan() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)
        let directory = fixture.directory("Documents/Codex/2026-08-21/new-chat")
        try Data(repeating: 0x41, count: 20_000).write(to: directory.appending(path: "file.bin"))

        let snapshot = try CodexStorageScanner(
            libraryDirectory: places.library,
            documentsDirectory: places.documents
        ).scan(codexHome: places.home)

        #expect(!snapshot.workspace.isEmpty)
        // The workspace never appears among the things a cleanup would select.
        let selectable = snapshot.categories.flatMap(\.entries).map(\.url.path)
        #expect(!selectable.contains { $0.contains("Documents/Codex") })
    }

    @Test func automaticCleanupNeverTouchesTheWorkspace() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let places = locations(fixture)
        let directory = fixture.directory("Documents/Codex/2026-08-21/new-chat")
        try Data(repeating: 0x41, count: 20_000).write(to: directory.appending(path: "file.bin"))

        let snapshot = try CodexStorageScanner(
            libraryDirectory: places.library,
            documentsDirectory: places.documents
        ).scan(codexHome: places.home)
        var settings = AutomationSettings()
        settings.cleanCaches = true
        settings.cleanOldPlugins = true
        settings.cleanArchivedSessions = true

        let tasks = CleanupPlanner.automaticTasks(
            in: snapshot,
            settings: settings,
            sessionMode: .trash
        )

        #expect(!tasks.contains { $0.url.path.contains("Documents/Codex") })
    }
}
