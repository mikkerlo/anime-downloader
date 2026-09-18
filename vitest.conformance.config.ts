import { defineConfig } from 'vitest/config'

// The conformance suite (#367). Deliberately a **second, separate** config with
// a **separate top-level directory**: `vitest.config.ts:17` is a positive
// `include` of `test/**/*.test.ts` and `src/**/*.test.ts`, so nothing under
// `conformance/` can be collected by the default run whatever anyone edits.
// Putting the suite under `test/` behind an `exclude` would be a negative guard
// whose failure mode is a deleted line turning every unrelated PR red on a
// runner with no Syncplay server.
//
// The `.conformance.ts` suffix is the second, independent reason: even pointed
// at this directory, the default `include` would still not match these files.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['conformance/**/*.conformance.ts'],
    globalSetup: ['./conformance/helpers/global-setup.ts'],
    // Every scenario is wall-clock-driven against a live server, and the
    // position tolerances in `conformance/helpers/trace-diff.ts` are sized from
    // measured scheduling jitter. Running files concurrently would put that
    // jitter under the mercy of however many other scenarios are sleeping, so
    // the suite trades wall time for a tolerance that stays honest.
    fileParallelism: false,
    maxConcurrency: 1,
    // A scenario is a sequence of real 1 Hz broadcast intervals; the longest
    // here spends about 25 s of that.
    testTimeout: 120000,
    hookTimeout: 60000
  }
})
