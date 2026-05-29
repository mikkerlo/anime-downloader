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
      thresholds: {
        perFile: false,
        'src/shared/**': { statements: 90, lines: 90 },
        'src/main/lib/**': { statements: 85, lines: 85 },
        'src/main/store/**': { statements: 70, lines: 70 },
        'src/main/services/anime-cache/**': { statements: 88, lines: 88 },
        'src/main/services/mp4-stats/**': { statements: 95, lines: 95 },
        'src/main/services/shikimori-sync/**': { statements: 65, lines: 65 },
        'src/main/services/cold-storage/**': { statements: 65, lines: 65 },
        'src/renderer/src/stores/**': { statements: 85, lines: 85 },
        'src/renderer/src/composables/**': { statements: 55, lines: 55 }
      }
    }
  }
})
