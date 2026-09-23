# Clean My Codex 0.1.7

The headline is a conversation preview: any conversation can now be read — messages, pasted images and generated images alike — before anything is deleted, and selected from inside the preview itself. Underneath, the platform moved forward by ten Electron majors, and that raises the macOS version required to run it.

## What's new

- **Preview a conversation before you delete it.** Every row on the Sessions page can open a read-only preview of the whole conversation: user and assistant messages reassembled from its rollout segments, oldest first, with Codex's scaffolding stripped the way the list preview strips it, tool calls counted rather than dumped, and long conversations capped. Images pasted into the conversation render inline with click-to-zoom, and images Codex generated for the thread are listed alongside — both under a shared per-preview budget, so a screenshot-heavy conversation is never loaded whole. Previews are only ever opened from the paths of the latest scan.
- **Browsing is separate from selecting.** Clicking a session row opens its preview; selection lives on the checkbox alone (with a wider hit area), so looking through every conversation on a deletion list never adds to what gets deleted. Inside the preview, ← / → or the previous/next buttons walk the filtered list, and a “Select this conversation” checkbox is bound to the same selection the list shows — decide while reading, not from a title alone.
- **The preview's chrome, tidied.** A single close button in the top-right corner replaces the footer's Close / Show in File Manager pair (each row keeps its own file-manager button), and Escape now closes only the preview instead of also sending the app back to the overview.
- **Stable download links.** Each installer is published twice on the release page — the versioned file plus an unversioned copy — so the `/releases/latest/download/…` links in the README always serve the newest release without ever changing.

## Before you update

- **macOS 12 (Monterey) or later is now required.** 0.1.6 ran on macOS 11; Electron 43 does not. If you are on Big Sur, stay on 0.1.6.
- **Windows 10 or later**, unchanged.
- The Windows installer published here is x64, as before, and it is compressed exactly the way 0.1.6's was.

## Under the hood

- **Electron 33 → 43** (Chromium 150, Node 24.18.1), **better-sqlite3 11 → 13**, Node 24 for development and CI, and the build toolchain moved to Vite 7 with electron-vite 5.
- **The native module no longer gets compiled at all.** better-sqlite3 13 is a Node-API addon that ships prebuilt binaries for every platform it supports, so the whole cross-rebuild apparatus is gone: no rebuild on install, no `electron-builder install-app-deps`, and no hand-written script for cross-building the Windows binary from macOS. Each artifact now carries only the one prebuilt binary it can actually load. This retires the failure mode where a macOS-built `.node` could end up inside the Windows installer.
- **Compile targets are now written down.** electron-vite derives its target from a table of Electron versions that does not include 43, and its fallback quietly picks the *oldest* entry in that table — the app would have been compiled for a decade-old target without a word of warning. The config now names node24 and chrome150 outright.

## Windows on ARM

**A Windows arm64 installer built from this source now installs completely.** Releases still publish the x64 installer only, so this matters if you build your own with `pnpm build:win-arm64`.

electron-builder 26 compresses the app payload with a 2024 build of 7-Zip, which inspects every executable and chooses a compression filter for it — for ARM64 binaries that is the ARM64 filter, added in 7-Zip 23.01. The NSIS installer still unpacks that payload with a plugin built in 2019, which has never heard of it. The result was an installer that ran to completion, reported success, and wrote everything except the nine files it could not decode: the application executable and its eight DLLs. x64 was never affected — it gets the BCJ2 filter, which that plugin does understand and which 0.1.6's installer already used.

The build now pins the filter to one the installer can read, for Windows arm64 only; x64 and macOS are untouched. And because "the installer succeeds and silently omits the program" is not something a failed build would ever have reported, every Windows installer is now re-tested as it is built, using a 7-Zip decoder older than the one inside the installer: a payload that cannot be unpacked fails the build instead of reaching a release page. CI builds and checks both architectures on every push.

## Tests

- **A fresh clone no longer races the Electron download.** Electron 43 dropped its install script, so the binary is fetched on first use rather than at install time. Test files run in parallel, and several would start that download at once while another was already launching the half-written binary. The suite now fetches Electron once, before the first test file.
- A test process killed by a signal now reports what the child actually printed instead of only the signal name, and CI decodes macOS crash reports when a job fails.
