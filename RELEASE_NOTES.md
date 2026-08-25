# Clean My Codex 0.1.6

## New

- **Plan output is now tracked as a session asset.** Codex's plan mode writes revisions under `~/.codex/plans/<thread-id>/`; each conversation's revisions collapse into one row named by the H1 of its newest revision, tagged `Plan`, and removed with the conversation that owned it.
- **Workspace cleanup can delete related conversations.** A workspace folder deletion now offers the same "also delete related conversations and their session assets" option that worktrees already had, so removing `~/Documents/Codex/xxx` can take the conversations that ran there with it. The rule is unchanged — session assets follow their session; the workspace does not.
- **Windows builds.** Releases now publish a Windows NSIS installer (`.exe`) alongside the macOS `.dmg`.

## Improvements

- **Renamed for clarity.** "Generated Assets" is now "Session Assets" (会话资产) and "Workspace Output" is now "Workspace" (工作区), across the sidebar, overview, and detail pages. The sidebar order also moves Session Assets next to Sessions.
- **Storage categories reorganized** so protected state is no longer blurred together:
  - Codex's runtime state — `state_`, `goals_`, `queue_`, `memories_` SQLite databases and the append-only `history*` files — gets its own **State Databases** row, separated from configuration.
  - The standalone **Log Databases** category is gone; the `logs_*.sqlite` diagnostic databases now sit under **Application Logs** alongside the desktop app logs and the `~/.codex/log` runtime log directory (all shielded, never offered).
  - The old "Current Plugins & Runtime" row is split: plugin **versions** move to the Plugins page, while the executables behind them get their own **Plugin Runtime Components** row so the runtime half of the old total is not silently lost.
  - "Unrecognized Items" is relabeled **Other** — files the Codex desktop app added that this app does not yet recognize, still protected.
- **Overview sessions row** now shows the per-session rollout total separately from the shared `thread_history_*.sqlite` projection, which gets its own protected row, so the two are no longer conflated in the chart or the total.
- **Plan-only-copy warning.** Deleting a Plan whose source conversation is already gone now warns that it may be the only surviving copy of that plan.
- Tightened cleanup dialog copy and button labels; worktree modification times are rounded for stable display.