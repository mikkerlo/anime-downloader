// The two-instance Shared Library suite's wiring (#587), asserted from the PR gate:
// it stays out of the blocking `npm run test:e2e`, runs under xvfb, and its
// workflow installs ffmpeg before the suite (the profile helper links it from
// PATH, so without it the first launch fails `assertNoDownloads()`).

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

describe('shared-library e2e layout', () => {
  it('keeps the default Playwright run on ./e2e, which cannot reach e2e-shared-library/', () => {
    const cfg = read('playwright.config.ts')
    expect(cfg).toMatch(/testDir: '\.\/e2e',/)
    expect(cfg).not.toContain('e2e-shared-library')
    expect(cfg).not.toContain('projects')
  })

  it('runs e2e-shared-library/ only through its own config, under xvfb', () => {
    expect(read('playwright.shared-library.config.ts')).toContain("testDir: './e2e-shared-library'")
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['test:e2e:shared-library']).toBe(
      'xvfb-run -a playwright test --config playwright.shared-library.config.ts'
    )
  })
})

describe('shared-library-e2e workflow', () => {
  const yml = read('.github', 'workflows', 'shared-library-e2e.yml')
  const at = (s: string): number => {
    const i = yml.indexOf(s)
    expect(i, s).toBeGreaterThan(-1)
    return i
  }

  it('installs ffmpeg and checks the Electron libs before it builds and runs the suite', () => {
    const ffmpeg = at('run: bash scripts/ci-install-ffmpeg.sh')
    const libs = at('run: bash scripts/ci-electron-libs.sh')
    const build = at('- run: npm run build')
    const suite = at('run: npm run test:e2e:shared-library')
    expect(ffmpeg).toBeLessThan(libs)
    expect(libs).toBeLessThan(build)
    expect(build).toBeLessThan(suite)
  })

  it('runs the piped suite step under bash, for pipefail', () => {
    const step = yml.slice(yml.indexOf('- name: Run the two-instance suite'))
    expect(step.slice(0, step.indexOf('run:'))).toContain('shell: bash')
  })

  it('lists the rig in its paths filter', () => {
    const paths = yml.slice(yml.indexOf('    paths:'), yml.indexOf('permissions:'))
    for (const p of [
      'scripts/ci-install-ffmpeg.sh',
      'scripts/ci-electron-libs.sh',
      'e2e-shared-library/**',
      'e2e/helpers/profile.ts',
      'playwright.shared-library.config.ts',
      '.github/workflows/shared-library-e2e.yml'
    ]) {
      expect(paths).toContain(`- '${p}'`)
    }
  })

  it("lists the code behind the round trip's outcomes in its paths filter (review of #647)", () => {
    // A PR breaking one of these would otherwise be caught only by the nightly,
    // after it merged: the drive and the merge; the watched rule and its clock
    // stamp; the decision 5 raise and the drain; the offline edge, the API-base
    // seam and the wiring; the UI the spec clicks.
    const paths = yml.slice(yml.indexOf('    paths:'), yml.indexOf('permissions:'))
    for (const p of [
      'src/main/lib/shared-library/**',
      'src/main/lib/sync-merge/**',
      'src/main/lib/sync-state/**',
      'src/main/services/attached-library/**',
      'src/main/services/shared-library-export/**',
      'src/main/services/sync-runner/**',
      'src/main/services/shikimori-sync/**',
      'src/main/services/offline/**',
      'src/main/ipc/shared-library.ipc.ts',
      'src/main/ipc/watch-progress.ipc.ts',
      'src/main/ipc/shikimori.ipc.ts',
      'src/main/ipc/library.ipc.ts',
      'src/main/lib/shikimori-rate.ts',
      'src/main/lib/shikimori-queue.ts',
      'src/main/lib/shikimori-rate-cache.ts',
      'src/main/lib/api-bases.ts',
      'src/main/store/sync-meta.ts',
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/shared/ipc/channels.ts',
      'src/renderer/src/components/shared-library/**',
      'src/renderer/src/components/sync/**',
      'src/renderer/src/components/views/PlayerView.vue',
      'src/renderer/src/components/detail/ShikimoriPanel.vue',
      'src/renderer/src/components/detail/EpisodeRow.vue',
      'src/renderer/src/composables/use-episode-downloads.ts',
      'src/renderer/src/composables/use-play-from-drive.ts',
      'src/renderer/src/stores/shared-libraries.ts',
      'src/renderer/src/stores/sync.ts',
      'src/renderer/src/stores/export.ts'
    ]) {
      expect(paths, p).toContain(`- '${p}'`)
    }
  })

  it('lists only paths that exist', () => {
    const paths = yml.slice(yml.indexOf('    paths:'), yml.indexOf('permissions:'))
    for (const m of paths.matchAll(/- '([^']+)'/g)) {
      const p = m[1].replace(/\/\*\*$/, '')
      expect(existsSync(join(ROOT, p)), p).toBe(true)
    }
  })
})
