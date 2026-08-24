# README screenshots

`capture.mjs` regenerates the four screenshots the READMEs show:

    docs/images/overview-{en,zh}-{light,dark}.png

Each README picks between the two appearances with `<picture>` and `prefers-color-scheme`, so the screenshot matches whichever theme the reader is browsing GitHub in. `docs/images/banner.png` is not generated here.

The renderer is bundled and run for real; only the preload API is replaced, by the demo scan in `mock.js`. So the screenshots follow the interface automatically, and the only file to touch when the numbers should look different is `mock.js`.

## Regenerating

Run it on macOS when you can: the interface asks for `-apple-system` and `PingFang SC`, and elsewhere the images come out in whatever fallback the system picks.

```bash
pnpm install
npm install --no-save playwright && npx playwright install chromium
node scripts/screenshots/capture.mjs
```

`playwright` stays out of `package.json` on purpose — nothing else needs a browser, and `pnpm install` should not pull one down.

Away from macOS, fetch a stand-in for the two system fonts first. It writes `fonts/fonts.css`, which `page.html` already links and which is otherwise absent:

```bash
node scripts/screenshots/fetch-fonts.mjs
```

Both `build/` and `fonts/` are ignored by git.

`PLAYWRIGHT_CHROMIUM_EXECUTABLE` points the run at a browser Playwright did not install itself, for the case where the package and the available browser build disagree.
