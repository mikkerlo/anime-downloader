// The nightly conformance workflow's own failure path, asserted from the PR gate.
//
// `.github/workflows/syncplay-conformance.yml` runs on a schedule, so nothing in
// a pull request exercises it; the first time anyone learns it is wrong is the
// first real divergence, which is precisely the run that has to be believed. The
// property here is the one that decides whether that run is visible at all.
//
// GitHub runs a `run:` block with no `shell:` as `bash -e {0}`, which does **not**
// set `pipefail`. A step whose command ends in `| tee conformance.log` therefore
// exits with `tee`'s status — 0 — and a diverged suite lands as a green nightly
// with the `if: failure()` filing step never reaching. Writing `shell: bash`
// expands to `bash --noprofile --norc -eo pipefail {0}`, which is the fix.
// Measured directly:
//
//   $ bash -e -c 'false | tee /dev/null'; echo $?
//   0
//   $ bash --noprofile --norc -eo pipefail -c 'false | tee /dev/null'; echo $?
//   1
//
// Shape borrowed from `test/release-assets.test.ts`, which reads `release.yml`
// with `readFileSync` and asserts a structural property of one job rather than
// pulling in a YAML parser the repo does not otherwise carry.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import { pinnedCommitFromWorkflow } from '../scripts/check-upstream-citations.mjs'

const ROOT = join(import.meta.dirname, '..')
const WORKFLOW = join(ROOT, '.github', 'workflows', 'syncplay-conformance.yml')

/** The `- ` entries under `steps:`, each as its own block of text. */
function steps(yml: string): string[] {
  const from = yml.indexOf('\n    steps:')
  if (from === -1) return []
  const body = yml.slice(from + '\n    steps:'.length)
  return body
    .split(/\n(?= {6}- )/)
    .map((s) => s.replace(/\n {0,5}\S[\s\S]*$/, ''))
    .filter((s) => s.trim().startsWith('- '))
}

/**
 * A step's shell command, with the YAML block-scalar indicator stripped.
 *
 * The indicator matters: `run: |` is a literal-block marker, not a pipeline, so
 * a naive search for `|` over the raw step text calls every multi-line step
 * piped and the assertion stops meaning anything.
 *
 * Both spellings of the key are matched. A step written compactly as `- run: …`
 * carries the key on the sequence-dash line; a pattern anchored at `run:`
 * alone could not see one, so such a step would return `null` here and drop
 * out of `piped` entirely, without moving the count the assertion below pins.
 * The workflow this reads uses that form for `npm ci`, so the shape is not
 * hypothetical.
 */
function runBody(step: string): string | null {
  const lines = step.split('\n')
  const i = lines.findIndex((l) => /^\s+(- )?run:/.test(l))
  if (i === -1) return null
  const m = lines[i].match(/^(\s*(?:- )?)run:[ \t]*(.*)$/)
  if (!m) return null
  const indent = m[1].replace('- ', '  ').length
  const inline = m[2].trim()
  if (inline !== '' && !/^[|>][-+]?\d*$/.test(inline)) return inline
  const out: string[] = []
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') {
      out.push('')
      continue
    }
    if ((lines[j].match(/^\s*/) as RegExpMatchArray)[0].length <= indent) break
    out.push(lines[j].trim())
  }
  return out.join('\n')
}

/** A `|` that is a shell pipeline, rather than half of a `||`. */
function hasPipeline(cmd: string): boolean {
  return /(^|[^|])\|([^|]|$)/.test(cmd.replace(/\\\n/g, ' '))
}

/** The `shell:` a step runs under, step-level or inherited from `defaults:`. */
function shellFor(step: string, yml: string): string | null {
  const own = step.match(/^\s+shell:[ \t]*(\S+)\s*$/m)
  if (own) return own[1]
  const fallback = yml.match(/^\s*defaults:\s*\n\s*run:\s*\n(?:\s+\w+:.*\n)*?\s*shell:[ \t]*(\S+)/m)
  return fallback ? fallback[1] : null
}

/** A step's `if:` expression, `${{ }}` and all, or null for an unconditional step. */
function ifFor(step: string): string | null {
  const m = step.match(/^\s+if:[ \t]*(.*)$/m)
  return m ? m[1].trim() : null
}

/** One `env:` value of a step, by key. */
function envOf(step: string, key: string): string | null {
  const m = step.match(new RegExp(`^\\s+${key}:[ \\t]*(.*)$`, 'm'))
  return m
    ? m[1]
        .trim()
        .replace(/^'(.*)'$/, '$1')
        .replace(/^"(.*)"$/, '$1')
    : null
}

/**
 * Whether an `if:` carries a status function.
 *
 * THE RULE THIS ENCODES IS A GITHUB DEFAULT THAT FAILS SILENTLY. A step whose
 * `if:` contains no status function is evaluated as `success() && <expr>`, so
 * after any earlier step fails it is SKIPPED however true its expression is.
 * Every conditional step in this file runs *because* something failed, so the one
 * spelling that reads most naturally — `if: steps.citations.outcome == 'failure'`
 * — is the one that never fires, and it does not warn: the step simply shows as
 * skipped in a run nobody opens.
 */
function hasStatusFunction(expr: string): boolean {
  return /\b(success|failure|always|cancelled)\s*\(\s*\)/.test(expr)
}

describe('syncplay-conformance workflow', () => {
  const yml = readFileSync(WORKFLOW, 'utf8')
  const piped = steps(yml).filter((s) => {
    const cmd = runBody(s)
    return cmd !== null && hasPipeline(cmd)
  })

  it('pipes something at all, so the assertion below is not vacuous', () => {
    // Pin the count rather than only looping over the set (`docs/testing.md`).
    // Without this the guard passes by finding nothing: drop the `| tee` and
    // every piped step trivially runs under a pipefail shell.
    //
    // TWO SINCE #395 STEP 2, and raising it is what drags the upstream-citation
    // step under the `pipefail` assertion below. That is load-bearing rather than
    // incidental: without `pipefail` the script's non-zero status is swallowed by
    // `tee`, the step's `outcome` reads `success`, and the filing step gated on
    // that outcome never runs — so a wrong anchor would be found, written to the
    // artefact, and reported to nobody.
    expect(piped.length).toBe(2)
    expect(runBody(piped[0])).toContain('| tee conformance.log')
    expect(runBody(piped[1])).toContain('check:upstream-citations')
    expect(runBody(piped[1])).toContain('| tee upstream-citations.md')
  })

  it('runs every piped step under a shell that sets pipefail', () => {
    // The whole point. `bash -e` without `pipefail` reports the *last* command's
    // status, so a red suite feeding `tee` is a green step and the divergence is
    // never filed.
    // The compact `- run: …` form never carries a `name:`, so falling back to
    // the literal `(unnamed step)` would tell whoever reads a red log nothing
    // about which step to go fix. Print the command instead.
    const nameOf = (step: string): string => {
      const m = step.match(/^\s+- name:[ \t]*(.*)$/m)
      if (m) return m[1]
      const cmd = runBody(step)
      return cmd === null ? '(unnamed step)' : `(unnamed step) run: ${cmd.split('\n')[0]}`
    }
    const unguarded = piped.filter((s) => shellFor(s, yml) !== 'bash').map(nameOf)

    expect({ pipedStepsWithoutPipefail: unguarded }).toEqual({ pipedStepsWithoutPipefail: [] })
  })

  it('writes the pinned commit identically in all four places', () => {
    // `conformance/helpers/real-server.ts`'s own docstring already promises "the
    // three must agree" (four, since `docs/syncplay.md` records the environment a
    // transcript was taken in), and until #395 step 2 nothing enforced it. It
    // matters more now than it did: the nightly citation check reads the pin out
    // of the WORKFLOW, because that is the line that decides what pip installs, so
    // a drifted copy elsewhere would have the suite and the anchors attested
    // against two different trees with nothing saying so.
    const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

    const fromWorkflow = pinnedCommitFromWorkflow(yml)
    expect(fromWorkflow).toMatch(/^[0-9a-f]{40}$/)

    const fromHelper = read('conformance', 'helpers', 'real-server.ts').match(
      /SYNCPLAY_PINNED_COMMIT = '([0-9a-f]{40})'/
    )
    const fromReadme = read('conformance', 'README.md').match(/syncplay@([0-9a-f]{40})/)
    // Narrowed to the line that names the server, because `docs/syncplay.md` also
    // records the APP commit a transcript was taken at, which is a 40-hex sha of
    // this repo and would match a bare pattern.
    const fromDocs = read('docs', 'syncplay.md').match(/`Syncplay\/syncplay` @ `([0-9a-f]{40})`/)

    expect({
      helper: fromHelper?.[1],
      readme: fromReadme?.[1],
      docs: fromDocs?.[1]
    }).toEqual({ helper: fromWorkflow, readme: fromWorkflow, docs: fromWorkflow })
  })

  it('files two differently titled issues and dedupes each on its own title', () => {
    // ONE LABEL, TWO FAILURES. `syncplay-conformance` is the only label this repo
    // carries for either, and `gh issue create` fails outright on a label that does
    // not exist, so both steps share it. That makes the dedupe lookup the thing
    // keeping them apart: keyed on the label alone — which is how the divergence
    // step was written before step 2 — the citation step would comment its report
    // onto the open "model diverged" issue, or the reverse, whichever opened first.
    const filing = steps(yml).filter((s) => (runBody(s) ?? '').includes('gh issue create'))
    expect(filing).toHaveLength(2)

    const titles = filing.map((s) => envOf(s, 'TITLE'))
    expect(titles.every((t) => typeof t === 'string' && t.length > 0)).toBe(true)
    expect(new Set(titles).size).toBe(2)

    for (const step of filing) {
      const cmd = runBody(step) as string
      expect(cmd).toContain('--label syncplay-conformance')
      expect(cmd).toContain('--assignee mikkerlo')
      // Both halves of the title-keyed lookup: ask for the field, then select on
      // it. Asking for `--json number` alone and selecting on `.title` returns
      // nothing at all, which looks exactly like "no open issue" and files a
      // duplicate every night.
      expect(cmd).toContain('--json number,title')
      expect(cmd).toContain('select(.title ==')
      expect(cmd).toContain('gh issue create --title "$TITLE"')
    }
  })

  it('gates each filing step on its own step outcome, with a status function', () => {
    // The two failures in this job are now independent, so each filing step must
    // read the outcome of the step it reports on. Bare `failure()` means "anything
    // earlier failed", which was unambiguous while the suite was the only thing
    // that could fail: with the citation check in the job it would file an issue
    // titled "model diverged from 1.7.6" over a wrong line number in a comment —
    // the exact mis-signal #395 is about.
    const byOutcome = (id: string): string =>
      steps(yml)
        .map((s) => ifFor(s))
        .filter((e): e is string => e !== null && e.includes(`steps.${id}.outcome`))
        .join('\n')

    const divergence = byOutcome('conformance')
    const citations = byOutcome('citations')
    expect(divergence).toContain("steps.conformance.outcome == 'failure'")
    expect(citations).toContain("steps.citations.outcome == 'failure'")
    expect(divergence).not.toContain('steps.citations.outcome')
    expect(citations).not.toContain('steps.conformance.outcome')

    // Both are still schedule-only: a manual dispatch is somebody watching the
    // run, and an issue filed at them is noise.
    for (const expr of [divergence, citations]) {
      expect(expr).toContain("github.event_name == 'schedule'")
    }

    // AND EVERY CONDITIONAL STEP CARRIES A STATUS FUNCTION. Without one the `if:`
    // is implicitly `success() && …`, so every step in this file that exists to
    // react to a failure would be skipped by exactly the failure it reacts to —
    // silently, as a skipped step in a nightly run nobody opens.
    const naked = steps(yml)
      .map((s) => ifFor(s))
      .filter((e): e is string => e !== null && !hasStatusFunction(e))
    expect({ conditionsWithoutAStatusFunction: naked }).toEqual({
      conditionsWithoutAStatusFunction: []
    })
  })
})
