/**
 * Regenerates the four README screenshots: one per language, per appearance.
 *
 * The renderer is bundled and run for real against `mock.js`, then each shot is drawn
 * into a macOS-shaped window with its own shadow and border. Nothing here mocks the
 * interface itself, so an image that no longer matches the app means the app changed,
 * not the screenshot script.
 *
 * The READMEs pick between light and dark with `<picture>`, so the screenshot follows
 * whichever appearance the reader is browsing GitHub in.
 *
 * Usage: `node scripts/screenshots/capture.mjs` (see ./README.md for the prerequisites).
 */

import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'
import * as esbuild from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const OUT = join(ROOT, 'docs/images')
const PORT = Number(process.env.SCREENSHOT_PORT ?? 8391)

/** The Electron window's own size, captured at 2× for a retina-sharp README. */
const WIDTH = 1180
const HEIGHT = 800
const SCALE = 2

/**
 * Canvas encodes its PNGs for speed, which costs about half the file again on an image
 * this size. Re-deflating the pixels it produced is lossless and gets that back.
 */
function recompress(png) {
  const chunks = []
  const parts = []
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    const body = png.subarray(at + 8, at + 8 + length)
    if (type === 'IDAT') parts.push(body)
    else if (type !== 'IEND') chunks.push({ type, body })
    at += length + 12
  }

  const deflated = deflateSync(inflateSync(Buffer.concat(parts)), { level: 9 })
  const framed = ({ type, body }) => {
    const chunk = Buffer.alloc(body.length + 12)
    chunk.writeUInt32BE(body.length, 0)
    chunk.write(type, 4, 'ascii')
    body.copy(chunk, 8)
    chunk.writeInt32BE(crc(chunk.subarray(4, body.length + 8)), body.length + 8)
    return chunk
  }
  return Buffer.concat([
    png.subarray(0, 8),
    ...chunks.map(framed),
    framed({ type: 'IDAT', body: deflated }),
    framed({ type: 'IEND', body: Buffer.alloc(0) })
  ])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
const crc = (bytes) => {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) | 0
}

const playwright = await import('playwright').catch(() => {
  throw new Error('playwright is not installed — see scripts/screenshots/README.md')
})

await esbuild.build({
  entryPoints: [join(ROOT, 'src/main.tsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  outdir: join(HERE, 'build'),
  loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' }
})

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2' }
const server = createServer((request, response) => {
  const path = join(ROOT, normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname)))
  if (!path.startsWith(ROOT)) return response.writeHead(403).end()
  stat(path).then(
    () => {
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
      createReadStream(path).pipe(response)
    },
    () => response.writeHead(404).end()
  )
})
await new Promise((done) => server.listen(PORT, '127.0.0.1', done))
const origin = `http://127.0.0.1:${PORT}`
const page_ = '/scripts/screenshots/page.html'

const browser = await playwright.chromium.launch({
  // Set when the local Playwright package and the installed browser build disagree.
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: ['--force-color-profile=srgb', '--font-render-hinting=none']
})
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE })
const page = await context.newPage()

await mkdir(join(HERE, 'build/shots'), { recursive: true })
for (const language of ['zh', 'en']) {
  for (const theme of ['light', 'dark']) {
    await page.goto(`${origin}${page_}?lang=${language === 'en' ? 'en' : 'zh-CN'}&theme=${theme}`)
    await page.waitForSelector('.summary-metrics .metric-value')
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(HERE, `build/shots/${language}-${theme}.png`) })
  }
}

// Framing happens in the page so the shots stay same-origin and the canvas untainted.
const compositor = await context.newPage()
await compositor.goto(`${origin}${page_}`)

await mkdir(OUT, { recursive: true })
for (const language of ['zh', 'en']) {
  for (const theme of ['light', 'dark']) {
    const dataURL = await compositor.evaluate(async ({ shot, dark, width, height, scale }) => {
      const image = await new Promise((done, fail) => {
        const element = new Image()
        element.onload = () => done(element)
        element.onerror = fail
        element.src = shot
      })

      const pad = 12 * scale
      const w = width * scale
      const h = height * scale
      const radius = 12 * scale
      const canvas = document.createElement('canvas')
      canvas.width = w + pad * 2
      canvas.height = h + pad * 2
      const ctx = canvas.getContext('2d')
      const window_ = (inset = 0) => {
        const [x, y, width_, height_, r] = [pad + inset, pad + inset, w - inset * 2, h - inset * 2, radius]
        ctx.beginPath()
        ctx.moveTo(x + r, y)
        ctx.arcTo(x + width_, y, x + width_, y + height_, r)
        ctx.arcTo(x + width_, y + height_, x, y + height_, r)
        ctx.arcTo(x, y + height_, x, y, r)
        ctx.arcTo(x, y, x + width_, y, r)
        ctx.closePath()
      }

      // No drop shadow: a soft gradient across a transparent canvas is the one thing a
      // PNG cannot compress, and it doubled the file for an effect GitHub's own page
      // never shows around anything else.
      ctx.save()
      window_()
      ctx.clip()
      ctx.drawImage(image, pad, pad, w, h)

      // The window keeps its traffic lights: the sidebar already reserves the room.
      ;['#ff5f57', '#febc2e', '#28c840'].forEach((color, index) => {
        ctx.beginPath()
        ctx.arc(pad + (25 + index * 20) * scale, pad + 27 * scale, 6 * scale, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
      })
      ctx.restore()

      ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(20, 22, 40, 0.16)'
      ctx.lineWidth = scale
      window_(0.5)
      ctx.stroke()

      return canvas.toDataURL('image/png')
    }, {
      shot: `${origin}/scripts/screenshots/build/shots/${language}-${theme}.png`,
      dark: theme === 'dark',
      width: WIDTH,
      height: HEIGHT,
      scale: SCALE
    })

    const file = join(OUT, `overview-${language}-${theme}.png`)
    const bytes = recompress(Buffer.from(dataURL.slice(dataURL.indexOf(',') + 1), 'base64'))
    await writeFile(file, bytes)
    console.log(`wrote ${file} (${Math.round(bytes.length / 1024)} KiB)`)
  }
}

await browser.close()
server.close()
