/**
 * Optional helper for capturing the README screenshots away from macOS.
 *
 * The interface asks for `-apple-system` and `PingFang SC`. A Linux box has neither, so
 * the shots come out in whatever fallback fontconfig picks and stop looking like the
 * application. This downloads Inter and Noto Sans SC into `fonts/` and writes the
 * stylesheet `page.html` already links, which also forces the two families on. On macOS
 * skip this: the real fonts are already there, and `fonts/fonts.css` simply 404s.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FONTS = join(HERE, 'fonts')
const API = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;700'

// A browser-shaped user agent gets woff2 split across a hundred subsets; this ancient one
// gets a single TrueType file per weight, which is what a local directory wants.
const response = await fetch(API, { headers: { 'user-agent': 'Mozilla/4.0' } })
if (!response.ok) throw new Error(`Google Fonts replied ${response.status}`)
let css = await response.text()

await mkdir(join(FONTS, 'files'), { recursive: true })
for (const url of new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((match) => match[1]))) {
  const name = url.slice(url.lastIndexOf('/') + 1)
  const file = await fetch(url)
  if (!file.ok) throw new Error(`${name} replied ${file.status}`)
  await writeFile(join(FONTS, 'files', name), Buffer.from(await file.arrayBuffer()))
  css = css.replaceAll(url, `files/${name}`)
  console.log('fetched', name)
}

css += `\n:root { font-family: 'Inter', 'Noto Sans SC', sans-serif !important; }\n* { -webkit-font-smoothing: antialiased; }\n`
await writeFile(join(FONTS, 'fonts.css'), css)
console.log('wrote', join(FONTS, 'fonts.css'))
