'use strict'

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

/**
 * Electron ships its prebuilt binaries ad-hoc signed, but electron-builder then renames the
 * executable, rewrites Info.plist, swaps the icon and injects app.asar, so the signature that
 * comes in the box no longer describes the bundle it sits in. macOS reads a quarantined app
 * whose signature fails to validate as damaged and offers only the Trash; the "unidentified
 * developer" prompt, the one Privacy & Security lets you approve, is what a *valid* signature
 * gets. Signing the finished bundle ad-hoc is what puts the app on that path. It stays
 * unnotarized either way, so the approval click remains.
 *
 * This runs from afterPack rather than afterSign because electron-builder skips afterSign
 * whenever its own signing step found no Developer ID identity, which is every build here.
 */
exports.default = function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.platform !== 'darwin') {
    console.log('  • skipped ad-hoc signing  reason=codesign is only available on macOS')
    return
  }

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--timestamp=none', '--sign', '-', app], { stdio: 'inherit' })
  // Shipping a bundle whose seal does not verify is the whole bug this hook exists to prevent,
  // so a build that cannot prove it worked has to fail rather than reach a release page.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed   app=${app}`)
}
