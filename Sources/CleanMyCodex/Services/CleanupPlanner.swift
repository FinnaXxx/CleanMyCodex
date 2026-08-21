import Foundation

/// Turns a scan result plus a selection into the concrete task list the engine runs.
/// The GUI and the scheduled `--auto-clean` run share this so both obey the same rules.
enum CleanupPlanner {
    static let cacheKinds: Set<StorageKind> = [
        .temporary, .logDatabase, .browserCache, .appCache, .appLogs
    ]

    static func tasks(for entries: [StorageEntry]) -> [CleanupTask] {
        entries
            .filter { $0.risk.isSelectable }
            .map(CleanupTask.init(entry:))
    }

    static func sessionTasks(for sessions: [SessionItem], mode: SessionDeletionMode) -> [CleanupTask] {
        sessions.map { session in
            CleanupTask(
                id: session.id,
                title: session.displayName,
                detail: "\(session.location.rawValue) · \(session.threadID)",
                url: session.fileURL,
                method: mode == .appServer ? .deleteThread : .trash,
                expectedBytes: session.totalBytes,
                threadID: session.threadID,
                companionURLs: session.assetURLs
            )
        }
    }

    static func automaticSessions(
        in snapshot: ScanSnapshot,
        settings: AutomationSettings,
        now: Date = .now
    ) -> [SessionItem] {
        snapshot.sessions.filter { session in
            if settings.skipRecentSessions {
                guard !session.isUnstable else { return false }
                guard session.modifiedAt < now.addingTimeInterval(-86_400) else { return false }
            }
            switch session.location {
            case .archived:
                guard settings.cleanArchivedSessions else { return false }
                return session.modifiedAt < cutoff(days: settings.archivedRetentionDays, from: now)
            case .active:
                guard settings.cleanActiveSessions else { return false }
                return session.modifiedAt < cutoff(days: settings.activeRetentionDays, from: now)
            }
        }
    }

    static func automaticTasks(
        in snapshot: ScanSnapshot,
        settings: AutomationSettings,
        sessionMode: SessionDeletionMode,
        now: Date = .now
    ) -> [CleanupTask] {
        var entries: [StorageEntry] = []
        if settings.cleanCaches {
            entries += snapshot.categories
                .filter { $0.group == .recommended && cacheKinds.contains($0.kind) }
                .flatMap(\.entries)
        }
        if settings.cleanOldPlugins {
            entries += snapshot.categories
                .filter { $0.kind == .pluginRemnants }
                .flatMap(\.entries)
        }

        let sessions = automaticSessions(in: snapshot, settings: settings, now: now)
        return tasks(for: entries) + sessionTasks(for: sessions, mode: sessionMode)
    }

    private static func cutoff(days: Int, from now: Date) -> Date {
        Calendar.current.date(byAdding: .day, value: -max(1, days), to: now) ?? .distantPast
    }
}
