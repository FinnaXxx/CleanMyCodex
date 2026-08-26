'use strict'

const { execFileSync } = require('node:child_process')
const { dirname, join } = require('node:path')

/**
 * Rebuild the better-sqlite3 native module for a specific (platform, arch)
 * Electron target by invoking `prebuild-install` directly.
 *
 * Why this exists: on an Apple Silicon host, `electron-builder install-app-deps`
 * (which delegates to @electron/rebuild) silently skips the rebuild whenever the
 * target arch matches the host arch. Cross-building win32-arm64 from darwin-arm64
 * therefore "finishes" without downloading anything, and the host's Mach-O
 * `better_sqlite3.node` gets packaged into the Windows installer. Windows then
 * rejects it with "%1 is not a valid Win32 application". Calling
 * `prebuild-install` with an explicit `--platform win32 --arch arm64` bypasses
 * that skip and fetches the real PE32+ Aarch64 prebuild.
 *
 * Usage: node scripts/rebuild-native.cjs <platform> <arch>
 *   platform: darwin | win32 | linux
 *   arch:     arm64 | x64 | ia32 | armv7l
 */
const [platform, arch] = process.argv.slice(2)
if (!platform || !arch) {
  console.error('usage: node scripts/rebuild-native.cjs <platform> <arch>')
  process.exit(2)
}

const electronVersion = require('electron/package.json').version
const pkgDir = dirname(require.resolve('better-sqlite3/package.json'))
const prebuildInstall = join(pkgDir, 'node_modules', '.bin', 'prebuild-install')

console.log(`• prebuild-install  module=better-sqlite3 platform=${platform} arch=${arch} electron=${electronVersion}`)
execFileSync(prebuildInstall, ['--runtime', 'electron', '--target', electronVersion, '--arch', arch, '--platform', platform], {
  cwd: pkgDir,
  stdio: 'inherit',
})