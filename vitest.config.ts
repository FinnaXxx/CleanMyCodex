import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    // Electron is fetched on first require since Electron 43 dropped its install script;
    // this pulls it down once up front so parallel test files cannot race the download.
    globalSetup: ['tests/support/ensure-electron.ts']
  }
})
