// The Tier 2 Syncplay rig's wiring (#489), asserted from the PR gate.
//
// Nothing in a pull request runs `e2e-syncplay/`: it needs a provisioned
// server, two Electron instances and ten-plus minutes. What a PR *can* check is
// the set of properties that decide whether that suite stays out of the
// blocking job and whether its verdicts mean anything:
//
//  - the default Playwright config cannot collect it (a separate top-level
//    directory and config, not a `projects` entry, per the #489 plan review);
//  - its own config never retries, because a row's verdict is a count;
//  - the workflow installs the same pinned server as the conformance nightly,
//    runs piped steps under `pipefail`, and stays non-blocking.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import { pinnedCommitFromWorkflow } from '../scripts/check-upstream-citations.mjs'

const ROOT = join(import.meta.dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

describe('syncplay e2e layout', () => {
  it('keeps the default Playwright run on ./e2e, which cannot reach e2e-syncplay/', () => {
    const cfg = read('playwright.config.ts')
    expect(cfg).toMatch(/testDir: '\.\/e2e',/)
    expect(cfg).not.toContain('e2e-syncplay')
    expect(cfg).not.toContain('projects')
  })

  it('runs e2e-syncplay/ only through its own config, with retries off', () => {
    const cfg = read('playwright.syncplay.config.ts')
    expect(cfg).toContain("testDir: './e2e-syncplay'")
    expect(cfg).toMatch(/retries: 0,/)
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['test:e2e']).toBe('playwright test')
    expect(pkg.scripts['test:e2e:syncplay']).toContain('--config playwright.syncplay.config.ts')
    expect(pkg.scripts['test:e2e:syncplay']).toMatch(/^xvfb-run -a /)
  })
})

describe('syncplay-e2e workflow', () => {
  const yml = read('.github', 'workflows', 'syncplay-e2e.yml')

  it('installs the same pinned Syncplay commit as the conformance nightly', () => {
    const conformance = read('.github', 'workflows', 'syncplay-conformance.yml')
    expect(pinnedCommitFromWorkflow(yml)).toBe(pinnedCommitFromWorkflow(conformance))
  })

  it('installs the TLS dependencies the StartTLS upgrade needs, and checks them', () => {
    // Without them the server answers `startTLS: "false"` and every spec fails
    // its StartTLS probe at setup (the first CI run on #495).
    const step = yml.slice(yml.indexOf('- name: Install Syncplay 1.7.6'))
    const block = step.slice(0, step.indexOf('\n      - '))
    expect(block).toMatch(/pip" install [^\n]*\bpyOpenSSL\b[^\n]*\bservice_identity\b/)
    expect(block).toContain("-c 'import OpenSSL, service_identity'")
  })

  it('is non-blocking and runs the suite under pipefail', () => {
    expect(yml).toMatch(/\n {4}continue-on-error: true\n/)
    const step = yml.slice(yml.indexOf('- name: Run the two-instance suite'))
    const block = step.slice(0, step.indexOf('\n      - '))
    expect(block).toContain('npm run test:e2e:syncplay')
    expect(block).toContain('| tee ')
    expect(block).toMatch(/\n {8}shell: bash\n/)
  })

  it('runs nightly, on dispatch and on PRs that touch the Syncplay client', () => {
    expect(yml).toMatch(/\n {2}schedule:\n/)
    expect(yml).toMatch(/\n {2}workflow_dispatch:\n/)
    expect(yml).toMatch(/\n {2}pull_request:\n {4}paths:\n/)
    for (const p of [
      'src/main/syncplay.ts',
      'src/renderer/src/composables/use-syncplay-client.ts',
      'e2e-syncplay/**'
    ]) {
      expect(yml).toContain(`- '${p}'`)
    }
  })
})
