import { defineConfig } from '@playwright/test'

/**
 * The Tier 2 Syncplay interaction suite (#489): two built app instances in one
 * room on a real Syncplay 1.7.6 server, playing generated fixtures.
 *
 * Deliberately a **second, separate** config over a **separate top-level
 * directory**, the layout `vitest.conformance.config.ts` uses for the same
 * reason. `playwright.config.ts` is `testDir: './e2e'`, and the blocking
 * `quality` job runs `npm run test:e2e` on every PR on a runner with no
 * Syncplay server; a Playwright `projects` entry would not keep these specs out
 * of that run, because `playwright test` runs every project unless filtered.
 * Nothing under `e2e-syncplay/` can be collected by the default config,
 * whatever anyone edits later. Run it with `npm run test:e2e:syncplay`.
 *
 * `retries: 0`, always. A row's verdict is a count over N timed runs, and a
 * runner-level retry would turn "bad ≥ 1" into "bad ≥ 1 twice" and a
 * flaky "bad == 0" into a pass. Setup steps (server boot, launch, connect,
 * positioning seeks) retry inside the helpers instead.
 *
 * `workers: 1`, always, with `fullyParallel: true` (#530). CI cuts the suite
 * into three `--shard`s on three runners, and `fullyParallel` is what lets
 * `--shard` split by test rather than by file. Each shard still runs one rig
 * at a time: P6f / P7f race a pause against a switch 0–200 ms later and E7
 * times the auto-advance countdown, so a second rig's two Electron instances,
 * server and relay on the same 4 vCPUs would turn those rows' `bad` counts into
 * a measure of CPU contention. More speed means more shards, never more
 * workers. A spec file's `beforeAll` boots one rig on each shard that runs a
 * test from it, and each test seats its own instances, profiles and room on
 * that rig (`seatDuo`), so no row depends on another row having run first.
 *
 * On CI each shard writes a `blob` report (plus `list` for its log), and the
 * workflow's merge job turns the three blobs into one `playwright-report-syncplay`
 * HTML report with `playwright merge-reports`.
 *
 * The timeout is per spec file's row, sized for N transitions of up to ~40 s
 * each plus two cold launches, not the default config's 60 s.
 */
export default defineConfig({
  testDir: './e2e-syncplay',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['blob', { outputDir: 'blob-report-syncplay' }], ['list']] : 'list',
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  outputDir: 'test-results/syncplay'
})
