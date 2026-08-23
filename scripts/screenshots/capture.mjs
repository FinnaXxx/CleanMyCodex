/**
 * Regenerates the two README hero images.
 *
 * The renderer is bundled and run for real against `mock.js`, once per language and
 * theme, then the light and dark shots of the same language are composited into one
 * window split along the diagonal. Nothing here mocks the interface itself, so an image
 * that no longer matches the app means the app changed, not the screenshot script.
 *
 * Usage: `node scripts/screenshots/capture.mjs` (see ./README.md for the prerequisites).
 */

import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const OUT = join(ROOT, 'docs/images')
const PORT = Number(process.env.SCREENSHOT_PORT ?? 8391)

/** The Electron window's own size, captured at 2× for a retina-sharp README. */
const WIDTH = 1180
const HEIGHT = 800
const SCALE = 2

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

// Compositing happens in the page so the shots stay same-origin and the canvas untainted.
const compositor = await context.newPage()
await compositor.goto(`${origin}${page_}`)

await mkdir(OUT, { recursive: true })
for (const language of ['zh', 'en']) {
  const dataURL = await compositor.evaluate(async ({ light, dark, width, height, scale }) => {
    const load = (src) => new Promise((done, fail) => {
      const image = new Image()
      image.onload = () => done(image)
      image.onerror = fail
      image.src = src
    })
    const [lightShot, darkShot] = await Promise.all([load(light), load(dark)])

    const pad = 56 * scale
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

    // The page behind the image is transparent, so the drop shadow has to read on both
    // GitHub themes rather than sit on an assumed white background.
    ctx.save()
    ctx.shadowColor = 'rgba(12, 14, 28, 0.34)'
    ctx.shadowBlur = 44 * scale
    ctx.shadowOffsetY = 16 * scale
    window_()
    ctx.fill()
    ctx.restore()

    ctx.save()
    window_()
    ctx.clip()
    ctx.drawImage(lightShot, pad, pad, w, h)
    // Dark takes the half below the diagonal running top-left → bottom-right.
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(pad + w, pad)
    ctx.lineTo(pad + w, pad + h)
    ctx.lineTo(pad, pad + h)
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(darkShot, pad, pad, w, h)
    ctx.restore()

    const seam = ctx.createLinearGradient(pad + w, pad, pad, pad + h)
    seam.addColorStop(0, 'rgba(255, 255, 255, 0.16)')
    seam.addColorStop(0.5, 'rgba(255, 255, 255, 0.62)')
    seam.addColorStop(1, 'rgba(255, 255, 255, 0.16)')
    ctx.strokeStyle = seam
    ctx.lineWidth = 1.6 * scale
    ctx.beginPath()
    ctx.moveTo(pad + w, pad)
    ctx.lineTo(pad, pad + h)
    ctx.stroke()

    // The window keeps its traffic lights: the sidebar already reserves the room.
    ;['#ff5f57', '#febc2e', '#28c840'].forEach((color, index) => {
      ctx.beginPath()
      ctx.arc(pad + (25 + index * 20) * scale, pad + 27 * scale, 6 * scale, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    })
    ctx.restore()

    ctx.strokeStyle = 'rgba(20, 22, 40, 0.16)'
    ctx.lineWidth = scale
    window_(0.5)
    ctx.stroke()

    return canvas.toDataURL('image/png')
  }, {
    light: `${origin}/scripts/screenshots/build/shots/${language}-light.png`,
    dark: `${origin}/scripts/screenshots/build/shots/${language}-dark.png`,
    width: WIDTH,
    height: HEIGHT,
    scale: SCALE
  })

  const file = join(OUT, `overview-${language}.png`)
  const bytes = Buffer.from(dataURL.slice(dataURL.indexOf(',') + 1), 'base64')
  await writeFile(file, bytes)
  console.log(`wrote ${file} (${Math.round(bytes.length / 1024)} KiB)`)
}

await browser.close()
server.close()
