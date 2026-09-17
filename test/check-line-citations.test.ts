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
  marked: { at: string; cited: string; target: string; quote: string }[]
  quoteFailures: {
    at: string
    cited: string
    target: string
    quote: string
    elsewhere: number[]
  }[]
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

  it('classifies a range by its start line only, except for blank interiors', () => {
    // `src/target.ts:5-8` opens on code and runs over a bare `}`, a `const g = (`
    // and a lone `)`. Thirteen of the tree's twenty-eight ranges have exactly
    // that shape — a cited block's last line is a closing brace by construction —
    // so judging a range's interior by the brace or comment predicates would red
    // the tree on legitimate citations. This is the half of #366's step C that
    // did NOT ship, stated as an assertion so a later widening has to delete it.
    const braces = run(base({ 'src/caller.ts': '// the tail (src/target.ts:5-8)' }))

    expect(braces.failures).toEqual([])
    expect(braces.suspicious).toEqual([])
    expect(braces.resolved).toHaveLength(1)

    // The blank-line predicate does extend inward (#366): a range is judged on
    // its start line for everything else, but a paragraph gap inside the span
    // means the range slid. `src/target.ts:2-6` spans the blank at line 4.
    const gap = run(base({ 'src/caller.ts': '// the whole function (src/target.ts:2-6)' }))

    expect(gap.failures).toEqual([])
    expect(gap.suspicious).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'src/target.ts:2-6',
        target: 'src/target.ts',
        start: 4,
        why: 'blank line'
      }
    ])
  })

  it('judges a range whose LAST line is the blank one', () => {
    // THE CASE THAT DECIDES THE BOUND. `interiorBlankLine()` runs `n <= endLine`,
    // and nothing in this file used to distinguish that from `n < endLine` — the
    // whole suite stayed green with the end line dropped out of scope, so a later
    // cleanup could have narrowed the rule to match the word "interior" and taken
    // the coverage with it. `src/target.ts:3-4` is the minimal decider: line 3 is
    // code, so the start-line predicates pass it, and line 4 — the range's last
    // line — is the blank. A range whose final line is a paragraph gap has slid
    // just as surely as one with a gap in the middle, which is why the end line
    // is in scope and why the prose now says so.
    const r = run(base({ 'src/caller.ts': '// the declaration (src/target.ts:3-4)' }))

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([
      {
        at: 'src/caller.ts:1',
        cited: 'src/target.ts:3-4',
        target: 'src/target.ts',
        start: 4,
        why: 'blank line'
      }
    ])
  })

  it('reports a range with two interior gaps once, not once per gap', () => {
    // The pin counts citations that look stale, not lines, so a range crossing
    // several paragraph boundaries must not move `SUSPICIOUS_LANDING_PIN` by
    // more than one — otherwise the pin's arithmetic depends on how airy the
    // target file is.
    const r = run({
      'docs/airy.md': 'One.\n\nTwo.\n\nThree.\n',
      'src/caller.ts': '// see docs/airy.md:1-5'
    })

    expect(r.suspicious).toHaveLength(1)
    expect(r.suspicious[0]).toMatchObject({ start: 2, why: 'blank line' })
  })

  it('reds on a broken anchor and goes green once it is repaired', () => {
    const broken = run(base({ 'src/caller.ts': '// the increment (src/target.ts:993)' }))
    expect(report(broken, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(false)

    const repaired = run(base({ 'src/caller.ts': '// the increment (src/target.ts:3)' }))
    expect(report(repaired, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  // --- the marked form (#366) -------------------------------------------------
  //
  // `resolved` attests that a path exists and a line is not obviously blank. It
  // does not attest that the line says what the citing comment claims, and #344
  // audited four `.md` anchors, cleared them, and watched two of them go 87
  // lines stale within three days with the gate still green. A citation that
  // carries its own target verbatim is the one case where meaning is decidable,
  // because the comparison is a substring test rather than a judgement.

  // Line 2 carries the subject; line 5 is where it moves to.
  const PROSE = [
    'The room mirror.',
    '**Pin the count, never just loop over the set.** A scan that walks',
    '',
    'A later section.',
    '**Pin the count, never just loop over the set.** A scan that walks',
    ''
  ].join('\n')

  it('reds a marked citation whose quote has moved, and names the corrected line', () => {
    // THE REGRESSION CASE. On the old gate this is green: `docs/prose.md:1` is
    // live prose, so `suspiciousLanding()` has nothing to say about it. Delete
    // the quote check and this goes green again — that is the mutation control.
    const r = run({
      'docs/prose.md': 'The room mirror.\n**Pin the count, never just loop over the set.**\n',
      'src/caller.ts': '// per docs/prose.md:1 ("Pin the count, never just loop over the set")'
    })

    expect(r.failures).toEqual([])
    expect(r.suspicious).toEqual([])
    expect(r.marked).toHaveLength(1)
    expect(r.quoteFailures).toHaveLength(1)
    expect(r.quoteFailures[0]).toMatchObject({
      at: 'src/caller.ts:1',
      cited: 'docs/prose.md:1',
      target: 'docs/prose.md',
      elsewhere: [2]
    })
    // Hard failure, no pin: there is no pin value that makes this pass.
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(false)
    expect(report(r, { suspiciousLanding: 1, uncheckable: 1, marked: 0 }).ok).toBe(false)
  })

  it('distinguishes a stale quote from a drifted one', () => {
    const r = run({
      'docs/prose.md': 'The room mirror.\nSomething else entirely.\n',
      'src/caller.ts': '// per docs/prose.md:1 ("Pin the count, never just loop over the set")'
    })

    expect(r.quoteFailures).toHaveLength(1)
    // Empty `elsewhere` is what the report reads as *stale* rather than *drift*:
    // there is no corrected line to offer, so the repair is a requote.
    expect(r.quoteFailures[0].elsewhere).toEqual([])
    const { err } = report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 })
    expect(err.join('\n')).toContain('stale — that text is nowhere in docs/prose.md')
    expect(err.join('\n')).not.toContain('drift —')
  })

  it('stays green on a marked citation whose quote is still correct', () => {
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:2 ("Pin the count, never just loop over the set")'
    })

    expect(r.quoteFailures).toEqual([])
    expect(r.marked).toHaveLength(1)
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('leaves a quoted string that is not a citation of the target alone', () => {
    // THE CASE THAT PINS "MARKED, NOT ADJACENT". Triggering on any quoted run
    // near a citation measures 75 candidates tree-wide of which 2 are at their
    // span; the misses are UI copy and scare-quoted concepts sitting next to an
    // anchor, exactly this shape. Even a ten-character gap between the citation
    // and the quote admits three of them, so the extractor pins `("` with no
    // slack — and this fixture is what stops a later loosening.
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': [
        '// the toast (docs/prose.md:1) reads "Paused by me" to the room',
        '// and docs/prose.md:1 says "Paused by me" too'
      ].join('\n')
    })

    expect(r.marked).toEqual([])
    expect(r.quoteFailures).toEqual([])
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('refuses to guess when a drifted quote matches more than one line', () => {
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:4 ("Pin the count, never just loop over the set")'
    })

    expect(r.quoteFailures).toHaveLength(1)
    expect(r.quoteFailures[0].elsewhere).toEqual([2, 5])
    const { err } = report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 })
    expect(err.join('\n')).toContain('docs/prose.md:2, docs/prose.md:5')
    expect(err.join('\n')).toContain('more than one match')
  })

  it('ignores multiplicity when the quote is at the cited line', () => {
    // Multiplicity governs the DRIFT REPORT ONLY. `docs/prose.md:5` carries the
    // same sentence as `:2`; the citation names one of them and is right, and
    // "how many other lines also say this" is not a question anyone asked. Under
    // the other reading — count matches, fail on more than one — this reds, and
    // so would four of the twelve anchors this PR retrofits.
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:5 ("Pin the count, never just loop over the set")'
    })

    expect(r.quoteFailures).toEqual([])
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('stays green on a self-file citation whose quote is also on the citing line', () => {
    // Four of the twelve retrofits are self-file: citing file IS target file, so
    // marking one puts the quoted string on the citing line as well as on the
    // target. A rule that counted matches would hard-fail every one of them, and
    // the failure would be manufactured by the repair itself.
    const r = run({
      'docs/prose.md': [
        'The room mirror.',
        '**Pin the count, never just loop over the set.**',
        '',
        'See docs/prose.md:2 ("Pin the count, never just loop over the set") above.',
        ''
      ].join('\n')
    })

    expect(r.marked).toHaveLength(1)
    expect(r.quoteFailures).toEqual([])
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('excludes the citing line from a self-file drift report', () => {
    // The other half of the same rule: when a self-file citation IS wrong, the
    // corrected line must not be the author's own sentence.
    const r = run({
      'docs/prose.md': [
        'The room mirror.',
        '**Pin the count, never just loop over the set.**',
        '',
        'See docs/prose.md:1 ("Pin the count, never just loop over the set") above.',
        ''
      ].join('\n')
    })

    expect(r.quoteFailures).toHaveLength(1)
    expect(r.quoteFailures[0].elsewhere).toEqual([2])
  })

  it('matches a quote anywhere inside a cited range', () => {
    // One of the twelve retrofits is a range, and its quote is in the interior.
    // Without this the gate's own header anchor is not retrofittable and the two
    // self-citations get covered asymmetrically.
    const r = run({
      'docs/prose.md': [
        '- **A rule.** Counting',
        '  the blocks a scan reached',
        '  is a shape check.',
        ''
      ].join('\n'),
      'src/caller.ts': '// per docs/prose.md:1-3 ("is a shape check")'
    })

    expect(r.marked).toHaveLength(1)
    expect(r.quoteFailures).toEqual([])
  })

  it('normalizes emphasis and whitespace on both sides of the comparison', () => {
    // CONSTRUCTED, because no live anchor exercises it: both of #366's repair
    // targets have their `**` outside the quoted span, so the raw substring
    // already matches. A quote with *internal* emphasis does not.
    const target = 'The mirror is refreshed by a **non-self** state.'
    const quote = 'refreshed by a non-self state'
    expect(target).not.toContain(quote) // raw substring fails

    const plainQuote = run({
      'docs/prose.md': `${target}\n`,
      'src/caller.ts': `// per docs/prose.md:1 ("${quote}")`
    })
    expect(plainQuote.quoteFailures).toEqual([])

    // And the mirror image: emphasis in the quote, plain prose in the target.
    const plainTarget = run({
      'docs/prose.md': 'The mirror is refreshed by a non-self state.\n',
      'src/caller.ts': '// per docs/prose.md:1 ("refreshed by a **non-self** state")'
    })
    expect(plainTarget.quoteFailures).toEqual([])

    // Whitespace collapse is the wrapped-quote half of the same rule.
    const wrapped = run({
      'docs/prose.md': `${target}\n`,
      'src/caller.ts': '// per docs/prose.md:1 ("refreshed    by a\n// non-self state")'
    })
    expect(wrapped.marked).toHaveLength(1)
    expect(wrapped.quoteFailures).toEqual([])
  })

  it('reads a quote that wraps across comment lines', () => {
    // The first anchor written in this form had its quote split across two
    // comment lines, so a single-line extractor would miss the very citation
    // that motivated the mechanism.
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': [
        '// Exact-match assertions, per docs/prose.md:2 ("Pin the count, never just',
        '// loop over the set"). Moving one is a deliberate act.'
      ].join('\n')
    })

    expect(r.marked).toHaveLength(1)
    expect(r.marked[0].quote).toBe('Pin the count, never just loop over the set')
    expect(r.quoteFailures).toEqual([])
  })

  it('reads a marked citation written with a backticked path', () => {
    // A backticked path is the same citation, and admitting the closing
    // backtick measures no new candidates tree-wide. Markdown prose backticks
    // paths by house style, so refusing it would make the retrofit unspellable
    // in half the citing files.
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per `docs/prose.md:1` ("Pin the count, never just loop over the set")'
    })

    expect(r.marked).toHaveLength(1)
    expect(r.quoteFailures[0]).toMatchObject({ cited: 'docs/prose.md:1', elsewhere: [2, 5] })
  })

  it('leaves an unmarked citation unverified rather than guessing', () => {
    // The escape hatch for a citation that genuinely points at "around here":
    // drop the `("…")` and the anchor degrades to the rest of this gate rather
    // than to a silenced failure. Opt-in is why the class needs no pin.
    const r = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:1, the counting rule'
    })

    expect(r.marked).toEqual([])
    expect(r.quoteFailures).toEqual([])
    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('reds when a marked anchor rots and goes green once it is repointed', () => {
    const rotted = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:1 ("Pin the count, never just loop over the set")'
    })
    expect(report(rotted, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(false)

    const repaired = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:2 ("Pin the count, never just loop over the set")'
    })
    expect(report(repaired, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(true)
  })

  it('reds when a marked anchor is quietly de-marked, and stays green on a new one', () => {
    // `marked` was printed and asserted nowhere, so an anchor could leave the
    // verified population with the gate green and exit 0 — and a floor, not an
    // exact pin, is the fix: the class cannot grow silently (marking is opt-in)
    // but it can shrink silently, and shrinking is what costs coverage.
    const marked = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:2 ("Pin the count, never just loop over the set")'
    })
    expect(marked.marked).toHaveLength(1)
    expect(report(marked, { suspiciousLanding: 0, uncheckable: 0, marked: 1 }).ok).toBe(true)

    // Each of these leaves the quote text intact and still takes the anchor out
    // of the population, because the spelling admits no slack: the reader sees a
    // sentence that still names its target and the gate sees an unmarked anchor.
    const demarked = {
      'a trailing clause before the paren':
        '// per docs/prose.md:2, which says ("Pin the count, never just loop over the set")',
      'single quotes': "// per docs/prose.md:2 ('Pin the count, never just loop over the set')",
      'a doubled space': '// per docs/prose.md:2  ("Pin the count, never just loop over the set")'
    }
    for (const [shape, citing] of Object.entries(demarked)) {
      const r = run({ 'docs/prose.md': PROSE, 'src/caller.ts': citing })
      expect(r.marked, shape).toEqual([])
      expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 1 }).ok, shape).toBe(false)
    }

    // The `("` wrapped onto the next line is the fourth shape — the continuation
    // rule joins a wrapped *quote*, not a wrapped opener.
    const wrapped = run({
      'docs/prose.md': PROSE,
      'src/caller.ts': '// per docs/prose.md:2\n// ("Pin the count, never just loop over the set")'
    })
    expect(wrapped.marked).toEqual([])
    expect(report(wrapped, { suspiciousLanding: 0, uncheckable: 0, marked: 1 }).ok).toBe(false)

    // Growth is the safe direction and must not cost a bump on every retrofit.
    const grown = run({
      'docs/prose.md': PROSE,
      'src/caller.ts':
        '// per docs/prose.md:2 ("Pin the count, never just loop over the set")\n' +
        '// and again per docs/prose.md:5 ("Pin the count, never just loop over the set")'
    })
    expect(grown.marked).toHaveLength(2)
    expect(report(grown, { suspiciousLanding: 0, uncheckable: 0, marked: 1 }).ok).toBe(true)
  })

  it('reds when a pin drifts in either direction, not just upward', () => {
    const r = run(base({ 'src/caller.ts': '// blank (src/target.ts:4)' }))

    expect(report(r, { suspiciousLanding: 0, uncheckable: 0, marked: 0 }).ok).toBe(false)
    // Pinned at the measured value: a real but deliberate landing.
    expect(report(r, { suspiciousLanding: 1, uncheckable: 0, marked: 0 }).ok).toBe(true)
    // And a pin left behind by a repair that removed the landing reds too, so a
    // stale pin cannot quietly license a new one.
    expect(report(run(base()), { suspiciousLanding: 1, uncheckable: 0, marked: 0 }).ok).toBe(false)
  })
})
