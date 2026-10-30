// The two-instance Shared Library suite's wiring (#587), asserted from the PR gate:
// it stays out of the blocking `npm run test:e2e`, runs under xvfb, and its
// workflow installs ffmpeg before the suite (the profile helper links it from
// PATH, so without it the first launch fails `assertNoDownloads()`).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
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
})
