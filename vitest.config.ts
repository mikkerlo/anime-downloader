import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // Vue plugin lets the renderer component tests (happy-dom) mount .vue SFCs.
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'e2e/**'],
    setupFiles: ['./test/setup/electron-mock.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.vue'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/renderer/src/main.ts',
        'src/main/index.ts'
      ],
      // Per-glob ratcheting floors on the seams Phase 7 actually covers
      // (#140). A single global threshold is meaningless here — it would be
      // dominated by the `.vue` components and main/ipc routers that are out
      // of scope for unit testing. Gating per-seam means a low-coverage file
      // can't hide behind a high-coverage one (epic #84 risk note). Floors
      // sit ~7–13 pts below current so normal churn doesn't flake CI; raise
      // them in follow-up PRs as coverage climbs. `perFile: false` so each
      // glob is checked as an aggregate. Statements + lines only — branch
      // coverage on a few seams (e.g. anime-cache) sits lower and is tracked
      // separately.
      //
      // Two of the entries below name a single file rather than a directory
      // (#361). `perFile: false` makes an aggregate out of everything a glob
      // matches, and the two most defect-dense files in the syncplay subsystem
      // were each hidden inside one: `src/main/syncplay.ts` matched no glob at
      // all — measured, never gated — and `use-syncplay-client.ts` could fall
      // a long way before the 55% composables aggregate noticed. A single-file
      // glob is its own aggregate, which is the point. Note the two overlap:
      // `use-syncplay-client.ts` is still counted into the composables number
      // as well, so its floor is the tighter of the two, not a carve-out.
      thresholds: {
        perFile: false,
        'src/shared/**': { statements: 90, lines: 90 },
        'src/main/lib/**': { statements: 85, lines: 85 },
        // Measured 98.49 at #361.
        'src/main/syncplay.ts': { statements: 88, lines: 88 },
        'src/main/store/**': { statements: 70, lines: 70 },
        'src/main/services/anime-cache/**': { statements: 88, lines: 88 },
        'src/main/services/mp4-stats/**': { statements: 95, lines: 95 },
        'src/main/services/shikimori-sync/**': { statements: 65, lines: 65 },
        'src/main/services/cold-storage/**': { statements: 65, lines: 65 },
        'src/renderer/src/stores/**': { statements: 85, lines: 85 },
        'src/renderer/src/composables/**': { statements: 55, lines: 55 },
        // Measured 97.15 at #361.
        'src/renderer/src/composables/use-syncplay-client.ts': { statements: 87, lines: 87 }
      }
    }
  }
})
