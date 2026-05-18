import { defineConfig } from '@playwright/test'

/**
 * Electron end-to-end config. Tests drive the *built* app (`out/`), so run
 * `npm run build` before `npm run test:e2e`. Kept separate from the Vitest
 * unit suite (`npm run test`).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 }
})
