import { defineConfig } from '@playwright/test'

/**
 * The two-instance Shared Library suite (#587): PC A exports, PC B opens the
 * drive offline and watches, the drive comes back to A, and A merges, against
 * local Shikimori and smotret stubs.
 *
 * A separate config over a separate top-level directory, as
 * `playwright.syncplay.config.ts` is: `playwright.config.ts` is
 * `testDir: './e2e'`, so the blocking `quality` job's `npm run test:e2e`
 * never collects it. Run it with `npm run test:e2e:shared-library` (built app,
 * under `xvfb-run -a`); CI runs it in `shared-library-e2e.yml`.
 *
 * One worker: two Electron instances are already a full rig on a CI runner.
 */
export default defineConfig({
  testDir: './e2e-shared-library',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 8 * 60_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/shared-library'
})
