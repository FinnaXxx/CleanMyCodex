import { lstatSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * On-disk allocated size of a single file: block-rounded bytes, matching how macOS
 * reports Codex' own directories in Finder. Node exposes `stats.blocks` in 512-byte
 * units, so allocated = blocks * 512. NTFS does not always fill `blocks`, so fall back
 * to the logical size when it reports zero.
 */
export function fileAllocatedSize(path: string): number {
  try {
    const st = statSync(path)
    const allocated = st.blocks * 512
    return allocated > 0 ? allocated : st.size
  } catch {
    return 0
  }
}

/** Allocated bytes of a regular file from an already-fetched stat. */
function allocatedFromStat(st: { blocks: number; size: number }): number {
  const allocated = st.blocks * 512
  return allocated > 0 ? allocated : st.size
}

/**
 * Recursive allocated size of a directory tree. Symlinks are not followed (Codex' data
 * dirs occasionally contain links to outside trees that must not be counted).
 */
export function directoryAllocatedSize(root: string): number {
  let total = 0
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let st
      try {
        st = lstatSync(path)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        stack.push(path)
      } else {
        total += allocatedFromStat(st)
      }
    }
  }
  return total
}