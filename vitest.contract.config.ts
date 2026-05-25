// Vitest config for the weekly live-API contract suite (#141).
//
// `vitest.config.ts` excludes `test/contract/**` so PRs don't hit the network;
// this config flips that — only the contract tests run, against real upstreams.
// Wired into `npm run test:contract` + the contract-check workflow.

import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['test/contract/**/*.test.ts'],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'e2e/**'],
    setupFiles: ['./test/setup/electron-mock.ts'],
    // Live network — give each request more headroom than the default 5s, and
    // run tests serially to be polite to upstream.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false
  }
})
