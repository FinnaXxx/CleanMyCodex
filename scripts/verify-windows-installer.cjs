'use strict'

const { execFileSync } = require('node:child_process')
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join } = require('node:path')

/**
 * Prove every Windows installer can be unpacked by the extractor that will actually unpack it.
 *
 * The NSIS installer embeds the whole app as a 7z archive and hands it to the `Nsis7z` plugin,
 * whose reduced decoder is a 2019 build. electron-builder compresses that archive with a 2024
 * 7-Zip that picks per-file filters the plugin has never heard of, and nothing in the build fails
 * when it does: the installer is produced, it runs, it writes the data files, and it silently
 * drops every native binary it could not decode. The only way to catch that before a user does is
 * to test the payload with a decoder no younger than the plugin.
 *
 * `7zip-bin` ships 7-Zip 16.02 (2016) — older than the plugin, so anything it accepts the plugin
 * accepts too. `7za t` decodes every byte and checks every CRC, and the method allowlist below
 * turns "some future 7-Zip invented another filter" into a readable error instead of an installer
 * that quietly ships without its exe.
 *
 * Runs from afterAllArtifactBuild, so it covers every build path — local, CI, any target list.
 */

// Everything the LZMA SDK decoder behind Nsis7z implements. ARM64 (7-Zip 23.01) and anything
// newer is deliberately absent: that is the filter that broke the arm64 installer.
const DECODABLE_METHODS = new Set(['Copy', 'LZMA', 'LZMA2', 'BCJ', 'BCJ2', 'Delta', 'ARM', 'ARMT', 'PPC', 'SPARC', 'IA64'])

// A decoder that does not know a filter prints its raw method id instead of a name, which is
// exactly the case that matters here.
const METHOD_NAMES = { '0A': 'ARM64', '0B': 'RISCV' }

const SEVEN_ZIP_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])

function path7za() {
  // 7zip-bin resolves to the binary for the *host*, which is all we need: the archive is
  // inspected where it was built, never on the user's machine.
  const binary = require('7zip-bin').path7za
  // The package manager does not always keep the executable bit, and electron-builder chmods
  // its own copy of 7-Zip for the same reason.
  if (process.platform !== 'win32') chmodSync(binary, 0o755)
  return binary
}

/**
 * NSIS stores the app archive with `SetCompress off`, so it sits in the installer verbatim and
 * can be found by its signature. Trailing installer bytes after the archive are harmless — 7-Zip
 * reads the header offsets and only warns about them.
 */
function extractEmbeddedArchive(installerPath, workDir) {
  const installer = readFileSync(installerPath)
  const offset = installer.indexOf(SEVEN_ZIP_SIGNATURE)
  if (offset < 0) {
    throw new Error(`No embedded 7z archive found in ${basename(installerPath)}. If the NSIS payload format changed, this check has to change with it.`)
  }
  const archivePath = join(workDir, 'app.7z')
  writeFileSync(archivePath, installer.subarray(offset))
  return archivePath
}

function run7za(args) {
  try {
    return { status: 0, output: execFileSync(path7za(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }
  } catch (error) {
    if (error.status == null) throw error
    return { status: error.status, output: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

function methodsOf(listing) {
  const methods = new Set()
  for (const line of listing.split('\n')) {
    const match = /^Method = (.+)$/.exec(line.trim())
    if (!match) continue
    // "BCJ2 LZMA2:24m LZMA:20:lc0:lp2" -> BCJ2, LZMA2, LZMA
    for (const token of match[1].trim().split(/\s+/)) methods.add(token.split(':')[0])
  }
  return methods
}

function entriesOf(listing) {
  const entries = []
  for (const line of listing.split('\n')) {
    const match = /^Path = (.+)$/.exec(line.trim())
    if (match) entries.push(match[1].replace(/\\/g, '/'))
  }
  // The first `Path =` is the archive itself.
  return entries.slice(1)
}

function verifyArchive(archivePath, label, productExe) {
  const listed = run7za(['l', '-slt', archivePath])
  if (listed.status !== 0) {
    throw new Error(`Cannot read the app archive in ${label}:\n${listed.output}`)
  }

  const methods = methodsOf(listed.output)
  const undecodable = [...methods]
    .filter((method) => !DECODABLE_METHODS.has(method))
    .map((method) => (METHOD_NAMES[method.toUpperCase()] ? `${METHOD_NAMES[method.toUpperCase()]} (${method})` : method))
  if (undecodable.length > 0) {
    throw new Error(
      `${label} was compressed with ${undecodable.join(', ')}, which the NSIS extractor cannot decode. ` +
        `The installer would run and then leave those files out. Set ELECTRON_BUILDER_7Z_FILTER (see scripts/electron-builder.cjs).`
    )
  }

  const tested = run7za(['t', archivePath])
  if (tested.status !== 0 || /Unsupported Method|ERROR/.test(tested.output)) {
    const detail = tested.output
      .split('\n')
      .filter((line) => /Unsupported Method|ERROR/.test(line))
      .join('\n')
    throw new Error(`The app archive in ${label} does not decode:\n${detail || tested.output}`)
  }

  const entries = entriesOf(listed.output)
  if (!entries.includes(productExe)) {
    throw new Error(`${label} does not contain ${productExe}. Found ${entries.length} entries.`)
  }
  const libraries = entries.filter((entry) => entry.endsWith('.dll'))
  if (libraries.length < 5) {
    throw new Error(`${label} contains only ${libraries.length} DLL(s); an Electron app ships eight. The payload is incomplete.`)
  }

  console.log(`  • verified payload  archive=${label} methods=${[...methods].sort().join(',')} files=${entries.length} dlls=${libraries.length}`)
}

exports.default = function verifyWindowsInstallers(buildResult) {
  const installers = buildResult.artifactPaths.filter((artifact) => artifact.toLowerCase().endsWith('.exe'))
  if (installers.length === 0) return []

  const productExe = `${buildResult.configuration.productName}.exe`
  const workDir = mkdtempSync(join(tmpdir(), 'verify-installer-'))
  try {
    for (const installer of installers) {
      const archivePath = extractEmbeddedArchive(installer, workDir)
      verifyArchive(archivePath, basename(installer), productExe)
      rmSync(archivePath, { force: true })
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
  return []
}
