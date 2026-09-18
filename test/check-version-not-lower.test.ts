// Fixtures for the version-ordering gate (#376). The workflow step is three
// lines of YAML around this script, so the decision the gate actually makes —
// "is the head strictly below the base?" — is tested here rather than by pushing
// throwaway branches, where the one case most likely to be written backwards
// (9 vs 10) is also the one nobody thinks to construct.
import { describe, it, expect } from 'vitest'

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import {
  check,
  compareVersions,
  nextPatch,
  parseVersion
} from '../scripts/check-version-not-lower.mjs'

type Result = { ok: boolean; out: string[]; err: string[] }

const run = (base: string, head: string, baseRef = 'main'): Result =>
  check({ base, head, baseRef }) as Result

describe('check-version-not-lower', () => {
  describe('parseVersion', () => {
    it('reads a bare major.minor.patch', () => {
      expect(parseVersion('4.6.96')).toEqual([4, 6, 96])
    })

    it('refuses anything carrying a suffix or a missing component', () => {
      // The middle one is the `build` job's `Set PR build version` rewrite; it
      // must never reach this gate, and if it does the gate says so rather than
      // comparing a prerelease string against a release one.
      for (const bad of ['v4.6.96', '4.6.96-pr376-20260918120000', '4.6', '4.6.96.1', '', ' ']) {
        expect(parseVersion(bad)).toBeNull()
      }
    })
  })

  describe('compareVersions', () => {
    it('orders patch, minor and major numerically', () => {
      expect(compareVersions('4.6.96', '4.6.97')).toBe(-1)
      expect(compareVersions('4.6.97', '4.6.96')).toBe(1)
      expect(compareVersions('4.6.96', '4.6.96')).toBe(0)
      expect(compareVersions('4.7.0', '4.6.99')).toBe(1)
      expect(compareVersions('5.0.0', '4.99.99')).toBe(1)
    })

    // The whole reason this is not a string compare. Lexically '4.6.9' > '4.6.10'
    // on every component boundary that crosses a digit count.
    it('orders across the 9-to-10 boundary', () => {
      expect(compareVersions('4.6.9', '4.6.10')).toBe(-1)
      expect(compareVersions('4.6.10', '4.6.9')).toBe(1)
      expect(compareVersions('4.9.0', '4.10.0')).toBe(-1)
      expect(compareVersions('9.0.0', '10.0.0')).toBe(-1)
    })

    it('throws rather than returning a sentinel on an unparseable side', () => {
      expect(() => compareVersions('4.6.96', 'nope')).toThrow(/major\.minor\.patch/)
      expect(() => compareVersions('nope', '4.6.96')).toThrow(/major\.minor\.patch/)
    })
  })

  describe('nextPatch', () => {
    it('names the number a lone PR should take', () => {
      expect(nextPatch('4.6.96')).toBe('4.6.97')
      expect(nextPatch('4.6.9')).toBe('4.6.10')
    })
  })

  describe('check', () => {
    it('fails when the head is strictly lower', () => {
      const r = run('4.6.96', '4.6.94')
      expect(r.ok).toBe(false)
    })

    it('passes when the head is equal — a docs-only PR does not bump', () => {
      expect(run('4.6.96', '4.6.96').ok).toBe(true)
    })

    it('passes when the head is greater', () => {
      expect(run('4.6.96', '4.6.97').ok).toBe(true)
    })

    it('passes a gap left by a dropped PR in a reserved-number queue', () => {
      expect(run('4.6.93', '4.6.96').ok).toBe(true)
    })

    // The case a lexical compare fails: '4.6.10' < '4.6.9' as strings, so a
    // string gate reds a legitimate bump, and its mirror image lets a real
    // downgrade through.
    it('passes 4.6.9 -> 4.6.10 and fails 4.6.10 -> 4.6.9', () => {
      expect(run('4.6.9', '4.6.10').ok).toBe(true)
      expect(run('4.6.10', '4.6.9').ok).toBe(false)
    })

    it('names both versions, the consequence and the number to take', () => {
      const err = run('4.6.96', '4.6.94').err.join('\n')
      expect(err).toContain('4.6.94')
      expect(err).toContain('4.6.96')
      expect(err).toContain('LOWER')
      expect(err).toMatch(/walk the update feed backwards/)
      expect(err).toMatch(/bump package\.json to at least 4\.6\.97/)
    })

    it('reports both versions on the passing path too', () => {
      const r = run('4.6.96', '4.6.97')
      expect(r.out.join('\n')).toContain('4.6.96')
      expect(r.out.join('\n')).toContain('4.6.97')
      expect(r.err).toEqual([])
    })

    it('uses the base ref name it was given', () => {
      expect(run('4.6.96', '4.6.94', 'release/4.6').err.join('\n')).toContain('release/4.6')
    })

    it('fails loudly on a PR-build version instead of comparing it', () => {
      const r = run('4.6.96', '4.6.96-pr376-20260918120000')
      expect(r.ok).toBe(false)
      expect(r.err.join('\n')).toContain('not a bare major.minor.patch')
      expect(r.err.join('\n')).toContain('4.6.96-pr376-20260918120000')
    })

    it('fails when the base side is the unparseable one', () => {
      const r = run('not-a-version', '4.6.97')
      expect(r.ok).toBe(false)
      expect(r.err.join('\n')).toContain('not-a-version')
    })
  })
})
