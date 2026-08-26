'use strict'

const { spawnSync } = require('node:child_process')
const { dirname, join } = require('node:path')

/**
 * Run electron-builder with the 7-Zip filter that the NSIS installer can actually decode.
 *
 * electron-builder 26 compresses the app payload with a downloaded 7-Zip 24.09, but the NSIS
 * side still ships the `Nsis7z` plugin from `nsis-resources-3.4.1` — a 2019 build whose reduced
 * decoder predates the ARM64 filter that 7-Zip introduced in 23.01. 7-Zip inspects every PE file
 * and picks a filter for it, so an ARM64 build gets `-mf=ARM64` automatically, the plugin answers
 * "Unsupported Method" for exactly the nine native binaries (the app exe plus d3dcompiler_47,
 * dxcompiler, dxil, ffmpeg, libEGL, libGLESv2, vk_swiftshader and vulkan-1), and the installer
 * finishes "successfully" having written everything except the program itself.
 *
 * `ELECTRON_BUILDER_7Z_FILTER` is app-builder-lib's own escape hatch for this. BCJ is the x86
 * filter: on ARM64 code it buys nothing, but every 7z decoder ever built understands it, which is
 * the whole point. It costs ~15% on the arm64 binaries.
 *
 * This is deliberately scoped to Windows arm64. x64 keeps its default BCJ2 — that filter is what
 * today's shipping installers already use, so it is proven to decode — and macOS never reaches
 * this code path at all (`-mf=` is only emitted for the 7z format; dmg and zip targets are not).
 *
 * Delete the override once electron-builder stops selecting filters its own NSIS plugin cannot
 * read, or once that plugin is rebuilt from a modern 7-Zip. `scripts/verify-windows-installer.cjs`
 * is what proves either way: it re-tests every installer with a decoder older than the plugin.
 */
const args = process.argv.slice(2)
const isWindows = args.includes('--win') || args.includes('--windows')
const isArm64 = args.includes('--arm64')

const env = { ...process.env }
if (isWindows && isArm64 && env.ELECTRON_BUILDER_7Z_FILTER == null) {
  env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'
  console.log('  • 7z filter       value=BCJ reason=the bundled NSIS extractor cannot decode 7-Zip\'s ARM64 filter')
}

const packageJsonPath = require.resolve('electron-builder/package.json')
const { bin } = require(packageJsonPath)
const cli = join(dirname(packageJsonPath), typeof bin === 'string' ? bin : bin['electron-builder'])

const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', env })
if (result.error) throw result.error
process.exit(result.status ?? 1)
