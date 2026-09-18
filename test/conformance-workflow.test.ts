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

const WORKFLOW = join(import.meta.dirname, '..', '.github', 'workflows', 'syncplay-conformance.yml')

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
    expect(piped.length).toBe(1)
    expect(runBody(piped[0])).toContain('| tee conformance.log')
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
})
