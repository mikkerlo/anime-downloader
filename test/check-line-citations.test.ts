// Fixtures for the citation gate (#336). Each case drives `analyze()` over a
// synthetic corpus rather than the real tree, so the assertions stay exact:
// the real tree's counts are the gate's own pins and move with every repair.
//
// This file is in `EXCLUDED_PATHS`, and has to be. Its fixtures are citation
// shapes on purpose — several are deliberately broken — so scanning it would
// make the gate fail on its own test data.
import { describe, it, expect } from 'vitest'

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import { analyze, report } from '../scripts/check-line-citations.mjs'

type Corpus = Record<string, string>

type Result = {
  scannedCount: number
  resolved: { at: string; cited: string; target: string }[]
  resolvedFullPath: number
  resolvedUniqueBasename: number
  unresolvableByExtension: number
  failures: { at: string; cited: string; why: string }[]
  suspicious: { at: string; cited: string; target: string; start: number; why: string }[]
  ambiguous: { at: string; cited: string; candidates: string[] }[]
  pathless: { at: string; anchor: string }[]
  uncheckable: number
}

// Line 1 is a comment, 4 is blank, 6 is a bare `}`, 8 is a lone `)`, and 3, 5
// and 7 are code. One target file covers every landing class the heuristic has.
const TARGET = [
  '// why the function exists',
  'export function f(): number {',
  '  const a = 1',
  '',
  '  return a',
  '}',
  'const g = (',
  ')',
  ''
].join('\n')

const run = (files: Corpus, excludedPaths: string[] = []): Result =>
  analyze({
    files: Object.keys(files),
    readLines: (p: string) => files[p].split('\n'),
    scanRoots: ['src', 'docs', 'test'],
    excludedPaths
  }) as Result

const base = (extra: Corpus = {}): Corpus => ({ 'src/target.ts': TARGET, ...extra })

describe('check-line-citations', () => {
  it('resolves a full-path citation that lands on code', () => {
    const r = run(base({ 'src/caller.ts': '// the increment (src/target.ts:3)' }))

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([])
    expect(r.resolvedFullPath).toBe(1)
    expect(r.resolved[0]).toMatchObject({ cited: 'src/target.ts:3', target: 'src/target.ts' })
  })

  it('fails a citation past the end of the file', () => {
    const r = run(base({ 'src/caller.ts': '// see src/target.ts:999' }))

    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({
      at: 'src/caller.ts:1',
      cited: 'src/target.ts:999',
      why: 'src/target.ts has 8 lines'
    })
  })

  it('counts the last real line rather than the phantom one after the newline', () => {
    // TARGET is newline-terminated, so splitting on '\n' yields a ninth, empty
    // element. Counting it would put the EOF boundary one line too far out and
    // report a line count nobody else agrees with.
    const r = run(
      base({ 'src/caller.ts': '// last line (src/target.ts:8)\n// past it (src/target.ts:9)' })
    )

    expect(r.resolved.map((x) => x.cited)).toEqual(['src/target.ts:8'])
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({ cited: 'src/target.ts:9' })
  })

  it('fails a citation to a path that does not exist', () => {
    const r = run(base({ 'src/caller.ts': '// see src/renamed-away.ts:3' }))

    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({
      cited: 'src/renamed-away.ts:3',
      why: 'no such file in this repo'
    })
  })

  it('fails an inverted range', () => {
    const r = run(base({ 'src/caller.ts': '// see src/target.ts:5-3' }))

    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatchObject({
      cited: 'src/target.ts:5-3',
      why: 'range starts after it ends'
    })
  })

  it('resolves a bare basename exactly one tracked file carries', () => {
    const r = run(base({ 'src/caller.ts': '// the increment (target.ts:3)' }))

    expect(r.failures).toEqual([])
    expect(r.resolvedUniqueBasename).toBe(1)
    expect(r.resolved[0].target).toBe('src/target.ts')
  })

  it('resolves a unique path suffix but fails a wrong directory', () => {
    // The suffix filter is what makes `dir/target.ts:3` checkable at all, and
    // what lets an anchor stay inside its paragraph instead of running to 130
    // columns. Its other half is that a wrong directory must NOT quietly fall
    // back to a unique basename: the gate's advice when the pin rises ("give it
    // a path the gate can resolve") is only sound if a typo'd directory reds.
    const ok = run({ 'src/dir/target.ts': TARGET, 'src/caller.ts': '// see dir/target.ts:3' })

    expect(ok.failures).toEqual([])
    expect(ok.resolvedUniqueBasename).toBe(1)
    expect(ok.resolved[0].target).toBe('src/dir/target.ts')

    const bad = run(base({ 'src/caller.ts': '// see src/wrong/target.ts:3' }))

    expect(bad.resolved).toEqual([])
    expect(bad.failures[0]).toMatchObject({
      cited: 'src/wrong/target.ts:3',
      why: 'no such file in this repo'
    })
  })

  it('scans repo-root files under the `.` root', () => {
    // Six named directories cannot reach a file with no directory component,
    // and the root holds the architecture index and the rules file — prose
    // *about* paths. An anchor there used to be invisible twice over: unchecked,
    // and absent from the uncheckable pin, so the gate printed OK.
    const corpus = base({ 'DESIGN.md': 'the mirror election (src/target.ts:999)' })

    const named = run(corpus)
    expect(named.scannedCount).toBe(1)
    expect(named.failures).toEqual([])

    // No `scanRoots` here: `analyze` falls back to the exported `SCAN_ROOTS`,
    // so this pins the `'.'` entry in the config as well as the arm in
    // `underRoot` that reads it. Passing a list instead made the two separable,
    // and deleting `'.'` from the constant then left every test green and the
    // gate printing OK — a regression as silent as the bug it undoes.
    const withRoot = analyze({
      files: Object.keys(corpus),
      readLines: (p: string) => corpus[p].split('\n'),
      excludedPaths: []
    }) as Result

    expect(withRoot.scannedCount).toBe(2)
    expect(withRoot.failures).toHaveLength(1)
    expect(withRoot.failures[0]).toMatchObject({
      at: 'DESIGN.md:1',
      cited: 'src/target.ts:999',
      why: 'src/target.ts has 8 lines'
    })
  })

  it('counts a basename two tracked files carry instead of guessing', () => {
    const r = run({
      'src/main/dup.ts': TARGET,
      'src/renderer/dup.ts': TARGET,
      'src/caller.ts': '// see dup.ts:3'
    })

    // Neither resolved nor failed: resolving it would be a coin flip, and
    // failing it would red the gate on a citation that is probably fine.
    expect(r.failures).toEqual([])
    expect(r.resolved).toEqual([])
    expect(r.ambiguous).toHaveLength(1)
    expect(r.ambiguous[0]).toMatchObject({
      cited: 'dup.ts:3',
      candidates: ['src/main/dup.ts', 'src/renderer/dup.ts']
    })
    expect(r.uncheckable).toBe(1)
  })

  it('counts a pathless anchor rather than silently ignoring it', () => {
    const r = run(base({ 'src/caller.ts': '// and the guard just below (:42)' }))

    expect(r.failures).toEqual([])
    expect(r.pathless).toEqual([{ at: 'src/caller.ts:1', anchor: ':42' }])
    expect(r.uncheckable).toBe(1)
  })

  it('does not count the line number of a full citation as a pathless anchor too', () => {
    const r = run(base({ 'src/caller.ts': '// see src/target.ts:3' }))

    expect(r.pathless).toEqual([])
    expect(r.uncheckable).toBe(0)
  })

  it('does not count a JSON value or a stream selector as a pathless anchor', () => {
    // A fifth of the first pin measured these: wire transcripts quoted verbatim
    // in docs, and a `${sel}:0` ffmpeg selector. Nothing can be spelled out to
    // fix one, so counting them means a new transcript line reds the gate with
    // advice its author cannot follow. A backtick- or paren-wrapped anchor in
    // the same file still counts, which is the half that has to keep working.
    const r = run({
      'docs/wire.md': '`{"playstate":{"position":20.998,"paused":false}}` then the gate at `:296`',
      'src/caller.ts': '// ffmpeg map is `${sel}:0`, and the early-out (:1326) skips it'
    })

    expect(r.pathless.map((p) => p.anchor)).toEqual([':296', ':1326'])
    expect(r.uncheckable).toBe(2)
  })

  it('treats an extension this repo does not contain as unresolvable, not missing', () => {
    const r = run(base({ 'src/caller.ts': "// upstream's election (server.py:597-604)" }))

    expect(r.failures).toEqual([])
    expect(r.unresolvableByExtension).toBe(1)
    expect(r.uncheckable).toBe(0)
  })

  it('leaves a host:port that matches the citation shape alone', () => {
    // `syncplay.pl:8999` is the default reference server and port. It parses as
    // a citation under any path regex; the resolvable-extension rule is the only
    // thing between it and a spurious failure.
    const r = run(base({ 'src/caller.ts': '// default server is syncplay.pl:8999' }))

    expect(r.failures).toEqual([])
    expect(r.unresolvableByExtension).toBe(1)
  })

  it('does not scan a file under an excluded path', () => {
    const r = run(base({ 'src/vendor/bundle.js': '// see src/gone.ts:5 and node.id:1 and (:7)' }), [
      'src/vendor/'
    ])

    expect(r.failures).toEqual([])
    expect(r.pathless).toEqual([])
    expect(r.scannedCount).toBe(1)
  })

  it('subjects a markdown target to the blank-line test and exempts the markup one', () => {
    // Line 1 of the target is an HTML comment and line 3 is blank — both would
    // warn in a .ts file, and before #344 neither warned in prose. Line 3 warns
    // now: a paragraph boundary is not a line anyone cites deliberately, so the
    // blank test is decidable on prose where the markup one is not.
    const r = run({
      'docs/notes.md': '<!-- a note -->\nThe room mirror.\n\n',
      'src/caller.ts': '// see docs/notes.md:1 and docs/notes.md:3'
    })

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'docs/notes.md:3',
        target: 'docs/notes.md',
        start: 3,
        why: 'blank line'
      }
    ])
    // The companion half, stated on its own so a later loosening of the
    // expectation above cannot drop it silently: `<!--` is tested *below* the
    // `.md` return, so deleting that return rather than moving it reds line 1
    // here. This case alone distinguishes the move from the deletion.
    expect(r.suspicious.some((s) => s.cited === 'docs/notes.md:1')).toBe(false)
    expect(r.resolved).toHaveLength(2)
  })

  it('exempts a markdown target landing on a bare brace inside a fenced block', () => {
    // The bare-brace test also sits below the `.md` return, and this pins it
    // there. `docs/types.md:19` is the live shape: the `}` closing a fenced
    // `interface`, which has code semantics and so reads as drift — but no
    // anchor in the tree lands on one, so the predicate stays exempt on that
    // argument rather than on a measurement.
    const r = run({
      'docs/types.md': ['```ts', 'interface Room {', '  id: string', '}', '```', ''].join('\n'),
      'src/caller.ts': '// the room shape (docs/types.md:4)'
    })

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([])
    expect(r.resolved).toHaveLength(1)
  })

  it('warns on a markdown landing on the second of two consecutive blank lines', () => {
    // The one way the narrowed rule could misfire: a markdown file whose
    // paragraphs are separated by more than one blank line puts a
    // legitimately-aimed anchor on a blank. No tracked `.md` is written that
    // way today, so this pins the assumption rather than leaving it to a tree
    // scan — if it ever stops holding, this case is where it surfaces.
    const r = run({
      'docs/airy.md': 'First paragraph.\n\n\nSecond paragraph.\n',
      'src/caller.ts': '// see docs/airy.md:3'
    })

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'docs/airy.md:3',
        target: 'docs/airy.md',
        start: 3,
        why: 'blank line'
      }
    ])
  })

  it('warns on a landing on a blank line, a bare brace, a lone paren or a comment', () => {
    const r = run(
      base({
        'src/caller.ts': [
          '// blank (src/target.ts:4)',
          '// brace (src/target.ts:6)',
          '// paren (src/target.ts:8)',
          '// comment (src/target.ts:1)'
        ].join('\n')
      })
    )

    expect(r.failures).toEqual([])
    expect(r.suspicious.map((s) => [s.start, s.why])).toEqual([
      [4, 'blank line'],
      [6, 'bare `}`'],
      [8, 'bare `)`'],
      [1, 'comment line']
    ])
  })

  it('classifies a range by its start line only', () => {
    // `src/target.ts:2-6` opens on a declaration and closes on a bare `}`. Three
    // of the repair targets in this PR have exactly that shape, so judging a
    // range by any line but its first would red the tree the repair just fixed.
    const r = run(base({ 'src/caller.ts': '// the whole function (src/target.ts:2-6)' }))

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([])
    expect(r.resolved).toHaveLength(1)
  })

  it('reds on a broken anchor and goes green once it is repaired', () => {
    const broken = run(base({ 'src/caller.ts': '// the increment (src/target.ts:993)' }))
    expect(report(broken, { suspiciousLanding: 0, uncheckable: 0 }).ok).toBe(false)

    const repaired = run(base({ 'src/caller.ts': '// the increment (src/target.ts:3)' }))
    expect(report(repaired, { suspiciousLanding: 0, uncheckable: 0 }).ok).toBe(true)
  })

  it('reds when a pin drifts in either direction, not just upward', () => {
    const r = run(base({ 'src/caller.ts': '// blank (src/target.ts:4)' }))

    expect(report(r, { suspiciousLanding: 0, uncheckable: 0 }).ok).toBe(false)
    // Pinned at the measured value: a real but deliberate landing.
    expect(report(r, { suspiciousLanding: 1, uncheckable: 0 }).ok).toBe(true)
    // And a pin left behind by a repair that removed the landing reds too, so a
    // stale pin cannot quietly license a new one.
    expect(report(run(base()), { suspiciousLanding: 1, uncheckable: 0 }).ok).toBe(false)
  })
})
