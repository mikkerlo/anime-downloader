// Fixtures for the version-ordering gate (#376). The workflow step is three
// lines of YAML around this script, so the decision the gate actually makes —
// "is the head strictly below the base?" — is tested here rather than by pushing
// throwaway branches, where the one case most likely to be written backwards
// (9 vs 10) is also the one nobody thinks to construct.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// `baseRevision` and `baseVersionFromOrigin` are the two parts of the script
// that talk to git, so the process boundary is stubbed rather than crossed: no
// clone is made, no ref is fetched, and the cases below are the answers git can
// give to each.
const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importActual) => ({
  ...(await importActual<typeof import('node:child_process')>()),
  execFileSync
}))

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import {
  baseRevision,
  baseVersionFromOrigin,
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

  describe('baseRevision', () => {
    let errors: string[]
    let exit: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      errors = []
      execFileSync.mockReset()
      vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
        errors.push(String(m))
      })
      // The real one does not return, so neither does this: letting it fall
      // through would run the `return 'FETCH_HEAD'` after the failure and hide
      // exactly the bug the case is about.
      exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`)
      }) as never)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('prefers the remote-tracking ref when it is already here', () => {
      execFileSync.mockReturnValueOnce('')
      expect(baseRevision('main')).toBe('refs/remotes/origin/main')
      expect(execFileSync).toHaveBeenCalledTimes(1)
      expect(execFileSync.mock.calls[0][1]).toContain('rev-parse')
    })

    it('falls back to one shallow fetch when the tracking ref is absent', () => {
      execFileSync.mockImplementationOnce(() => {
        throw new Error('not a valid ref')
      })
      execFileSync.mockReturnValueOnce('')
      expect(baseRevision('main')).toBe('FETCH_HEAD')
      expect(execFileSync.mock.calls[1][1]).toEqual(['fetch', '--depth=1', 'origin', 'main'])
    })

    // Before this was guarded the same input exited on an unhandled
    // `execFileSync` throw — a node stack trace through `baseRevision`, which
    // reads like the gate crashed rather than like the base could not be
    // resolved. Every other failure in this script explains itself in prose.
    it('explains itself and fails closed when the fetch fails too', () => {
      execFileSync.mockImplementation(() => {
        throw new Error("fatal: couldn't find remote ref no-such-ref")
      })

      expect(() => baseRevision('no-such-ref')).toThrow('process.exit(1)')

      expect(exit).toHaveBeenCalledWith(1)
      const said = errors.join('\n')
      expect(said).toContain('Could not read the base branch')
      expect(said).toContain('refs/remotes/origin/no-such-ref')
      expect(said).toContain('no-such-ref')
      expect(said).not.toMatch(/at baseRevision|node:internal/)
    })
  })

  // The other half of the same failure, and it has two shapes: `baseRevision`
  // can hand back a revision that resolves and still not carry a `package.json`
  // — a base branch older than the file — or one carrying bytes that are not
  // JSON. Bare, both exited on an unhandled throw with the node stack trace the
  // case above forbids for `baseRevision`. Hence the same assertions here.
  //
  // What is deliberately not covered: a revision carrying some *other*
  // project's valid `package.json`. That reaches `check()` with an `undefined`
  // version and fails there, which the `check` cases already cover.
  describe('baseVersionFromOrigin', () => {
    let errors: string[]
    let exit: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      errors = []
      execFileSync.mockReset()
      vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
        errors.push(String(m))
      })
      exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`)
      }) as never)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('reads the version out of the base revision', () => {
      execFileSync.mockReturnValueOnce('')
      execFileSync.mockReturnValueOnce('{ "version": "4.6.96" }')

      expect(baseVersionFromOrigin('main')).toBe('4.6.96')
      expect(execFileSync.mock.calls[1][1]).toEqual([
        'show',
        'refs/remotes/origin/main:package.json'
      ])
    })

    it('explains itself and fails closed when the revision carries no package.json', () => {
      execFileSync.mockReturnValueOnce('')
      execFileSync.mockImplementationOnce(() => {
        throw new Error(
          "fatal: path 'package.json' exists on disk, but not in 'refs/remotes/origin/main'"
        )
      })

      expect(() => baseVersionFromOrigin('main')).toThrow('process.exit(1)')

      expect(exit).toHaveBeenCalledWith(1)
      const said = errors.join('\n')
      expect(said).toContain('Could not read package.json from the base branch')
      expect(said).toContain('refs/remotes/origin/main')
      expect(said).not.toMatch(/at baseVersionFromOrigin|node:internal/)
    })

    // Third answer git can give: the revision resolves, `git show` succeeds, and
    // the bytes are not JSON. `JSON.parse` used to sit one line outside the
    // `try`, so this escaped as a raw `SyntaxError` — the same node stack trace
    // through this function that the two cases above forbid. Reproduced against
    // a base commit whose `package.json` read `not json at all`.
    //
    // This one inspects the thrown value rather than using `toThrow`, because
    // the claim is about its *type*: a `SyntaxError` reaching the caller is the
    // bug, and a message assertion alone would not say so.
    it('explains itself and fails closed when the revision carries invalid JSON', () => {
      execFileSync.mockReturnValueOnce('')
      execFileSync.mockReturnValueOnce('not json at all\n')

      let thrown: unknown
      try {
        baseVersionFromOrigin('main')
      } catch (e) {
        thrown = e
      }

      expect(thrown).not.toBeInstanceOf(SyntaxError)
      expect((thrown as Error | undefined)?.message).toBe('process.exit(1)')

      expect(exit).toHaveBeenCalledWith(1)
      const said = errors.join('\n')
      expect(said).toContain('Could not read package.json from the base branch')
      expect(said).toContain('refs/remotes/origin/main')
    })
  })
})
