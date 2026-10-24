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
//    runs piped steps under `pipefail`, and stays non-blocking;
//  - it shards the suite across three runners with one worker each (#530), so
//    the timing rows never share cores with a second rig, and merges the
//    shards' blob reports into one.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import { pinnedCommitFromWorkflow } from '../scripts/check-upstream-citations.mjs'

const ROOT = join(import.meta.dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

// One top-level job of the workflow: from its `  <name>:` line to the next
// two-space-indented key, or the end of the file.
const jobBlock = (yml: string, name: string): string => {
  const start = yml.indexOf(`\n  ${name}:\n`)
  if (start < 0) return ''
  const rest = yml.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z]/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

// The steps of a job, one string each, split on the `      - ` list marker.
const stepsOf = (job: string): string[] => job.split('\n      - ').slice(1)

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

  it('runs one worker per shard, split by test rather than by file (#530)', () => {
    // A second worker would put two rigs on one runner's cores and skew the
    // timing rows (P6f / P7f / E7); without `fullyParallel`, `--shard` splits
    // by file and leaves all six pause rows on one shard.
    const cfg = read('playwright.syncplay.config.ts')
    expect(cfg).toMatch(/\n {2}workers: 1,\n/)
    expect(cfg).toMatch(/\n {2}fullyParallel: true,\n/)
    expect(cfg).toMatch(/\n {2}retries: 0,\n/)
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
    expect(block).toMatch(/pip" install [^\n]*(?:'twisted\[tls\]'|\bpyopenssl\b)/i)
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

describe('syncplay-e2e sharding (#530)', () => {
  const yml = read('.github', 'workflows', 'syncplay-e2e.yml')
  const shardJob = jobBlock(yml, 'syncplay-e2e')
  const mergeJob = jobBlock(yml, 'merge-reports')
  const step = (job: string, marker: string): string =>
    stepsOf(job).find((s) => s.includes(marker)) ?? ''

  it('runs three shards, and one red shard does not cancel the others', () => {
    expect(shardJob).toMatch(/\n {4}strategy:\n/)
    expect(shardJob).toMatch(/\n {6}fail-fast: false\n/)
    expect(shardJob).toMatch(/\n {8}shard: \[1, 2, 3\]\n/)
  })

  it('passes the shard through the npm script, which keeps the xvfb-run wrapper', () => {
    // A bare `npx playwright test --shard=…` would drop `xvfb-run -a`, and
    // Electron has no display on the runner without it.
    const run = /\n {8}run: ([^\n]*)\n/.exec(step(shardJob, 'name: Run the two-instance suite'))
    expect(run?.[1]).toBe(
      'npm run test:e2e:syncplay -- --shard=${{ matrix.shard }}/3 2>&1 | tee syncplay-e2e-${{ matrix.shard }}.log'
    )
  })

  it("uploads every shard's blob report on every outcome, not only on failure", () => {
    const upload = step(shardJob, 'name: blob-report-${{ matrix.shard }}')
    expect(upload).toContain('uses: actions/upload-artifact@')
    expect(upload).toMatch(/\n {8}if: \$\{\{ !cancelled\(\) \}\}\n/)
    expect(upload).not.toContain('failure()')
    // …from the directory the config's blob reporter writes to.
    const cfg = read('playwright.syncplay.config.ts')
    const outDir = /\['blob', \{ outputDir: '([^']+)' \}\]/.exec(cfg)?.[1]
    expect(outDir).toBeTruthy()
    expect(upload).toMatch(new RegExp(`\\n {10}path: ${outDir}/?\\n`))
    // The traces stay failure-only.
    expect(step(shardJob, 'name: syncplay-e2e-traces-')).toMatch(/\n {8}if: failure\(\)\n/)
  })

  it('gives every artifact a shard uploads a per-shard name', () => {
    // Artifact names must be unique within a run; two shards uploading under
    // one name would have the second fail its upload.
    const uploads = stepsOf(shardJob).filter((s) => s.includes('uses: actions/upload-artifact@'))
    expect(uploads.length).toBeGreaterThanOrEqual(2)
    for (const u of uploads) {
      expect(u).toMatch(/\n {10}name: [^\n]*\$\{\{ matrix\.shard \}\}[^\n]*\n/)
    }
  })

  it('merges the blob reports in a job that runs unless the run was cancelled', () => {
    expect(mergeJob).not.toBe('')
    expect(mergeJob).toMatch(/\n {4}needs: syncplay-e2e\n/)
    expect(mergeJob).toMatch(/\n {4}if: \$\{\{ !cancelled\(\) \}\}\n/)
    // The blob format is version-tied: the merge installs the same
    // `@playwright/test`, and has nothing to build.
    expect(mergeJob).toContain('- run: npm ci\n')
    expect(mergeJob).not.toContain('npm run build')
    const download = step(mergeJob, 'uses: actions/download-artifact@')
    expect(download).toContain('pattern: blob-report-*')
    expect(download).toContain('merge-multiple: true')
    expect(mergeJob).toContain('npx playwright merge-reports ')
    expect(step(mergeJob, 'uses: actions/upload-artifact@')).toContain(
      'name: playwright-report-syncplay'
    )
  })
})
