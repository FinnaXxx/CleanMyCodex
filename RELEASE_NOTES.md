# Clean My Codex 0.1.5

## New

- Added **Worktree** management, grouped by repository with total size, build-output size, related conversations, and repository state—including uncommitted changes, unpushed commits, and branches without an upstream.
- Codex-managed worktrees can now be removed safely through `git worktree remove`, with an option to delete their related conversations and generated assets at the same time. Worktrees that are not verifiably owned by Codex remain visible but protected.
- Added detection of old Codex releases left behind by standalone installations. Superseded releases are offered for cleanup only when the current release can be confirmed.
- Added detection for abandoned desktop-state temporary files, Skills upgrade backups, and interrupted installation artifacts. Unrecognized entries are now listed separately and remain protected instead of being hidden under “Other.”

## Improvements

- Redesigned the Plugins page with status filters, search, storage totals, and clearer version ordering. Current third-party plugins can now be uninstalled through the Codex CLI, while outdated versions and uninstall leftovers can still be cleaned independently.
- Improved the classification of plugin installation caches, persistent data, and configuration to prevent double counting and clearly identify protected runtime data.
- Updated the overview and storage breakdown with worktree usage and direct navigation to the new management page.
- Tightened cleanup flows that require Codex to quit. Cleanup launched from a detail page now requires explicit confirmation, and Codex remains closed afterward to reduce the risk of deleting data that is still in use.
- Improved cleanup previews and progress reporting so worktrees, related conversations, plugin uninstalls, and their estimated reclaimed space are presented more clearly.
- Improved storage accounting for external worktree roots and Codex data categories to avoid double counting or including unrelated directories.
