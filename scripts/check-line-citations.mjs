#!/usr/bin/env node
// CI gate for `<path>:<line>` citations written in comments and docs prose (#336).
//
// A stale anchor is worse than no anchor. It lands on a brace, a comment or a
// declaration; the reader sees prose that could plausibly describe the
// neighbourhood, and either believes it or stops trusting the comment block.
// `typecheck`, `lint`, `format:check` and the whole test suite are indifferent
// to a number inside a comment, so four PRs (#326, #333, #335 and the repair
// half of this one) moved these by hand after the fact.
//
// What is decidable here is whether a citation resolves to a line that exists.
// Whether that line *means* what the prose says is generally not, so the gate is
// split into unambiguous failures plus a heuristic that only warns — and two
// pinned counts, which are what give the warn teeth and what stop the gate
// from passing by seeing nothing. A printed-only number is the shape check
// docs/testing.md:199-203 ("it is never the assertion that catches set rot")
// warns about: nobody diffs it.
//
// The one case where meaning *is* decidable is #366's marked form: a citation
// that carries its own target verbatim, `<path>:<n> ("quoted text")`. Comparing
// that quote against the cited line is a substring test, not a judgement about
// prose, so it hard-fails rather than warns. See `extractMarkedQuote()`.
//
// Run: npm run check:line-citations

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

// --- pins ---------------------------------------------------------------------
//
// Exact-match assertions, per docs/testing.md:193 ("Pin the count, never just
// loop over the set"). Moving one is a deliberate act with a reason in the
// commit message, not a side effect of an unrelated edit.

// Citations landing on a blank line, a bare brace or a comment line — and
// since #344 that enumeration is not uniform: blank applies to every tracked
// extension, the other three to code only, because `.md` is exempt from those
// three and subject to blank. Zero is not an aspiration: every such landing on
// this tree was stale, and the repair half of #336 fixed all thirteen while
// #344 repaired the two markdown anchors its narrowing exposed, so the
// heuristic's measured false-positive rate here is zero. The first genuinely
// deliberate comment landing raises this by one, with its reason.
//
// What this pin does not cover, and what `resolved` does not attest: an anchor
// landing on a live code line is checked for existence only. The four
// same-file anchors in the `suspiciousLanding()` comment below all target
// `if (…)` lines, which blank, bare brace and comment line can never see go
// stale — they are attested as "the target line exists", not as drift-checked.
// The bare-brace and comment-line predicates are also consecutive, so those
// two anchors differ by one: a single line inserted above the ladder re-points
// each at its neighbour's test, green and wrong. #345 kept them for the
// inbound-anchor coverage on the record that `resolved` counts anchors that
// resolve, not anchors that are checked.
export const SUSPICIOUS_LANDING_PIN = 0

// Anchors that name something in this repo and still cannot be checked:
// basenames carried by more than one tracked file, plus pathless `:NNN`
// anchors that inherit their path from a neighbouring line. Bounding the
// blindness is the point — a gate that silently resolves nothing and a gate
// that resolves everything and passes are otherwise indistinguishable. Adding
// an anchor the gate cannot see reds this, and the fix is almost always to
// spell the path out rather than to raise the number.
//
// 11 ambiguous basenames + 106 pathless anchors on this tree.
export const UNCHECKABLE_PIN = 117

// A FLOOR, not an exact count — the only pin here that is one-sided, because
// the marked class is asymmetric. It cannot grow silently: marking is opt-in,
// so every arrival is someone deliberately writing `("…")`. It can shrink
// silently, and shrinking is the direction that costs coverage — an anchor
// leaves the verified population, `marked` prints one lower, and nobody diffs
// a printed number. Four ordinary edits do it with the quote text left intact
// and the gate still green, measured against the extractor above: writing
// `path:2, which says ("…")`, wrapping the `("` onto the next line, closing
// with `('…')`, or leaving two spaces before the paren. All four are what
// rewriting the surrounding sentence produces, and the strictness that earns
// `MARKED_OPEN` its zero false-positive rate is exactly what makes them quiet.
// Growth must not cost a bump on every retrofit, so only the fall reds.
//
// 12 marked citations on this tree.
export const MARKED_PIN = 12

// --- configuration ------------------------------------------------------------

// `'.'` is the repo root itself — files with no directory component, which a
// list of named directories cannot reach. The root holds the two most
// anchor-prone prose files in the repo (the architecture index and the rules
// file), and an anchor there is worse than unchecked: it does not enter the
// uncheckable pin either, so the gate prints OK, no pin moves, and nobody
// learns it exists. Naming the root files individually would rot the first time
// a root doc is added, so the root is a root instead. Nine root files join the
// scan under this arm and none carries an anchor today.
export const SCAN_ROOTS = ['.', 'src', 'test', 'docs', 'e2e', 'scripts', '.github']

// `src/renderer/public/` is vendored minified libass: noise under any rule, and
// its worker bundles carry `node.id:1` tokens that match the citation shape
// exactly. The fixture corpus is citation-shaped on purpose — it contains
// deliberately broken anchors — so scanning it would make the gate fail on its
// own test data.
export const EXCLUDED_PATHS = ['src/renderer/public/', 'test/check-line-citations.test.ts']

// Files whose text is searched for citations.
export const SCANNED_EXT = new Set([
  '.ts',
  '.tsx',
  '.vue',
  '.md',
  '.js',
  '.mjs',
  '.cjs',
  '.yml',
  '.yaml',
  '.sh'
])

// Extensions this repo actually contains. Anything else is unresolvable by
// construction rather than a failure — which is what lets the upstream Syncplay
// citations (`server.py:597-604` and eighty-odd more) through with no filename
// allowlist to maintain, and is also the only thing that handles
// `syncplay.pl:8999`: a host and port that matches the citation shape exactly
// and is not a citation at all. A typo'd *repo* path still fails, because it
// still ends in `.ts`.
export const RESOLVABLE_EXT = new Set([
  '.ts',
  '.tsx',
  '.vue',
  '.md',
  '.js',
  '.mjs',
  '.cjs',
  '.yml',
  '.yaml',
  '.json',
  '.sh'
])

// `<path>:<n>` / `<path>:<n>-<m>`. The path part must carry a dot-extension, so
// bare words and `key: 1` pairs do not match.
const CITATION = /\b([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z][A-Za-z0-9]{0,4}):(\d+)(?:-(\d+))?\b/g

// Second token class: a pathless `:NNN` that inherits its path from a
// neighbouring line. `<path>:<n>` cannot see these at all, so without their own
// pattern they fall out of the accounting entirely and a file scores clean
// while carrying a stale citation — three of this PR's own repair rows were
// written this way. Resolving them as "same file as the last anchor" is out of
// scope; counting them is not. Anchored on a preceding non-path character so
// `localhost:3000` and `12:30` do not match — and not a quote or a closing
// brace either, because `"position":20.99` inside a wire transcript is not an
// anchor and nothing can be spelled out to fix it. On this tree the looser
// class counts 90 of these and this one 70; the 20 dropped are JSON values in
// the transcripts under docs/syncplay.md, an ffmpeg stream selector, a TLS
// fixture buffer, and this comment's own example. A pin a fifth of which
// measures non-citations does not bound the gate's blindness, and appending
// one more transcript line would have redded it with advice nobody can follow.
const PATHLESS = /(^|[^A-Za-z0-9_./\\:"'}-]):(\d+)(?:-(\d+))?\b/g

// The marked form (#366): a citation that carries its own target verbatim,
// spelled `<path>:<n> ("quoted text")` — the citation optionally closed by a
// backtick, because a backticked path is the same citation and admits nothing
// new (measured: still exactly one hit tree-wide). Everything after that is
// fixed: one space, one open paren, one double quote, no slack.
//
// THE STRICTNESS IS THE DESIGN, and a later reader will see a fussy regex and
// want to relax it. Measured across the resolvable citations on the tree this
// shipped on, counting by admitted gap between the end of the citation and the
// opening quote:
//
//   no slack (this rule)  1 candidate    0 false positives
//   up to 10 characters   4 candidates   3 false positives
//   up to 40 characters   5 candidates   4 false positives
//
// Triggering on mere adjacency instead — any double-quoted run of >= 12
// characters on the citing line or the two below it — gives 75 candidates of
// which 2 occur at their cited span: 73 false reports for one and a bit of
// signal. Backticks as the delimiter are worse again in both directions: 1636
// candidates, 34 at span, so it neither selects the marked cases nor stays
// quiet on the rest.
//
// The three the 10-character gap admits are all the same shape and none is a
// citation of its target: a scare-quoted concept or a line of UI copy sitting
// next to an anchor. They are named here WITHOUT line numbers on purpose —
// writing a counterexample in the marked spelling would make this rationale
// block acquire live anchors of its own, green by coincidence and free to rot
// like any other. They are: the two anchors into
// `src/renderer/src/composables/use-syncplay-client.ts` that carry the toast
// copy "Paused by me" (one in `docs/syncplay.md`, one in `src/main/syncplay.ts`)
// and the `docs/syncplay.md` anchor that scare-quotes the phrase "where intent
// is written". Loosening the rule re-imports that population.
const MARKED_OPEN = /^`? \("/

// A wrapped quote is the normal case, not an edge: the first anchor written in
// this form had its quote split across two comment lines, so a single-line
// extractor would have missed the very citation that motivated the mechanism.
// Continuation lines are joined with a single space after their leading comment
// marker is stripped, which is what makes the rule uniform across citing-file
// kinds — `//` and `*` in code, `#` in yaml/sh, nothing at all in markdown
// prose, where a paragraph is one long line and no continuation is needed.
const MARKED_CONTINUATION = 3

const stripContinuationMarker = (line) =>
  line.replace(/^\s*(?:\/\/+|\/\*|\*\/|\*|#)?\s*/, '').trim()

/**
 * Normalize both sides of a quote comparison: drop Markdown emphasis and
 * backticks, collapse whitespace. Neither of #366's two repair targets needs
 * this — their `**` sit outside the quoted span, so the raw substring already
 * matches — so the rule is justified by a constructed fixture rather than by a
 * live anchor: a quote with *internal* emphasis would fail a raw comparison,
 * and a quote wrapped across comment lines carries whitespace the target has
 * not got.
 */
export const normalizeQuote = (s) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Pull the quote out of a marked citation, or return null if the citation is
 * not marked. `rest` is the citing line from the end of the citation onward.
 *
 * @param {string[]} lines  the citing file
 * @param {number} i        zero-based index of the citing line
 * @param {string} rest
 * @returns {string | null}
 */
export function extractMarkedQuote(lines, i, rest) {
  const open = MARKED_OPEN.exec(rest)
  if (!open) return null
  let buf = rest.slice(open[0].length)
  for (let k = i; ; ) {
    const close = buf.indexOf('"')
    if (close >= 0) {
      const quote = buf.slice(0, close)
      return normalizeQuote(quote) === '' ? null : quote
    }
    k++
    if (k >= lines.length || k - i > MARKED_CONTINUATION) return null
    buf += ' ' + stripContinuationMarker(lines[k])
  }
}

// --- analysis -----------------------------------------------------------------

/**
 * Classify the line a citation lands on. A range is classified by its START
 * LINE ONLY: three of this PR's repair targets are ranges whose last or
 * interior line is a brace or a comment (src/main/syncplay.ts:902-908,
 * src/main/syncplay.ts:862-870 and
 * src/renderer/src/composables/use-syncplay-client.ts:1751-1753), so
 * classifying by any line inside the range would put the repaired tree straight
 * back into the warn class and the repair could never go green.
 *
 * Since #366 the BLANK-LINE predicate alone also runs on every line of a range
 * after its start, its end line included, via `interiorBlankLine()` below — the
 * other three stay on the start line. That split is measured, not aesthetic:
 * applying this function whole to every line of every range turns 13 of the 28
 * resolved ranges suspicious, all of them legitimate, because a cited block's
 * last line is a closing brace by construction — and three of the 13 are inside
 * this very docstring, so the text explaining why ranges are start-line-only
 * would itself red the gate. Blank-line-only past the start measures 0 hits, so
 * the pin stays at 0 and a range that slid onto a paragraph gap is still
 * caught.
 */
function suspiciousLanding(lines, targetPath, startLine) {
  const text = (lines[startLine - 1] ?? '').trim()
  // Blank is the one predicate that is decidable on prose, so `.md` is subject
  // to it rather than exempt (#344): no file deliberately cites the blank line
  // between two of its own paragraphs, and both stale docs anchors that
  // narrowing caught were landing on exactly that.
  if (text === '') return 'blank line'
  // The three predicates below cannot tell prose from prose the way the blank
  // test at scripts/check-line-citations.mjs:268 can, and they are not exempt
  // for the same reason — saying they are attributes one's evidence to the
  // others. The comment-line test at scripts/check-line-citations.mjs:292 is a
  // *measured* syntax collision with Markdown emphasis: of the 135 lines it
  // matches across the tracked `.md`, 102 are `**bold**` openers and 25 open
  // with a single `*` (17 emphasis, 8 bullets), leaving 8 comment-shaped — the
  // false positive is demonstrated on the very lines #344 repaired *to*:
  // docs/syncplay.md:246 ("Both directions of the ping exchange") and
  // docs/syncplay.md:332 ("Two sentences of the original argument for the cap
  // were wrong") are both `**` openers, so hoisting this return past it would
  // red the gate on the repair itself. The bare-brace test at
  // scripts/check-line-citations.mjs:291 and the `<!--` test at
  // scripts/check-line-citations.mjs:297 have no measured false positive in
  // either direction — all 16 brace matches across the tracked `.md` sit
  // inside fenced code blocks and nothing starts a line with `<!--` — so they
  // stay exempt on an *argument*: a fenced `}` carries code semantics, and
  // markup is not a line anyone cites deliberately. That `<!--` test is also
  // what makes this return's placement observable rather than equivalent to
  // deleting it, which the fixtures in test/check-line-citations.test.ts pin.
  // The yml/yaml/sh `#` branch below cannot fire for a `.md` target at all.
  if (extname(targetPath) === '.md') return null
  if (/^[}\])]+[;,]?$/.test(text)) return `bare \`${text}\``
  if (/^(\/\/|\/\*|\*)/.test(text)) return 'comment line'
  const ext = extname(targetPath)
  if ((ext === '.yml' || ext === '.yaml' || ext === '.sh') && text.startsWith('#')) {
    return 'comment line'
  }
  if (text.startsWith('<!--')) return 'comment line'
  return null
}

/**
 * The interior half of the rule above: the first blank line after a cited
 * range's start line, up to and including its end line, or null. The end line
 * is in scope deliberately — a range whose last line is a paragraph gap has
 * slid just as surely as one with a gap in the middle. Only the first, so one
 * citation contributes at most one suspicious entry however many gaps it spans
 * — the pin counts citations that look stale, not lines.
 */
function interiorBlankLine(lines, startLine, endLine) {
  if (endLine === null) return null
  for (let n = startLine + 1; n <= endLine; n++) {
    if ((lines[n - 1] ?? '').trim() === '') return n
  }
  return null
}

/**
 * Verify a marked citation's quote against its target. Returns null when the
 * quote occurs anywhere in the cited line or range, `{ elsewhere }` otherwise —
 * empty for *stale* (the quote is nowhere in the file) and populated for
 * *drift* (the quote moved, and these are the lines it moved to).
 *
 * MULTIPLICITY GOVERNS THE DRIFT REPORT ONLY. If the quote is at the cited
 * span, the citation is right and how many other lines also carry it is not a
 * question anyone asked — 15 of the tree's single-line anchors target a line
 * that is not unique in its file, and four of #366's own retrofits are
 * self-file citations where the quote is by construction on the citing line as
 * well as the target. "Refuse to guess, report them all" applies on the failing
 * branch, where the only open question *is* which line to name in the repair.
 *
 * The citing line itself is excluded from a self-file drift report: naming it
 * would be telling the author their citation should point at their own
 * sentence.
 *
 * @param {string[]} lines  the target file
 * @param {{ start: number, end: number | null, quote: string, self: boolean, citedAt: number }} opts
 * @returns {{ elsewhere: number[] } | null}
 */
function verifyQuote(lines, { start, end, quote, self, citedAt }) {
  const needle = normalizeQuote(quote)
  const last = end ?? start
  for (let n = start; n <= Math.min(last, lines.length); n++) {
    if (normalizeQuote(lines[n - 1] ?? '').includes(needle)) return null
  }
  const elsewhere = []
  for (let n = 1; n <= lines.length; n++) {
    if (n >= start && n <= last) continue
    if (self && n === citedAt) continue
    if (normalizeQuote(lines[n - 1] ?? '').includes(needle)) elsewhere.push(n)
  }
  return { elsewhere }
}

const underRoot = (p, roots) =>
  roots.some((r) => (r === '.' ? !p.includes('/') : p === r || p.startsWith(r + '/')))

/**
 * @param {object} opts
 * @param {string[]} opts.files        every tracked path, repo-relative
 * @param {(p: string) => string[]} opts.readLines
 * @param {string[]} [opts.scanRoots]
 * @param {string[]} [opts.excludedPaths]
 */
export function analyze({
  files,
  readLines,
  scanRoots = SCAN_ROOTS,
  excludedPaths = EXCLUDED_PATHS
}) {
  const tracked = new Set(files)
  const byBasename = new Map()
  for (const p of files) {
    const b = basename(p)
    if (!byBasename.has(b)) byBasename.set(b, [])
    byBasename.get(b).push(p)
  }

  const cache = new Map()
  const linesOf = (p) => {
    if (!cache.has(p)) {
      const lines = readLines(p)
      // Splitting a newline-terminated file on '\n' leaves a phantom empty
      // element past the last real line. Left in, the past-EOF rule is off by
      // one and the failure message reports a line count nobody else agrees
      // with — in a gate about citation accuracy.
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      cache.set(p, lines)
    }
    return cache.get(p)
  }

  const scanned = files.filter(
    (p) =>
      underRoot(p, scanRoots) &&
      !excludedPaths.some((x) => p === x || p.startsWith(x)) &&
      SCANNED_EXT.has(extname(p))
  )

  const failures = []
  const suspicious = []
  const ambiguous = []
  const pathless = []
  const resolved = []
  const marked = []
  const quoteFailures = []
  let unresolvableByExtension = 0
  let resolvedFullPath = 0
  let resolvedUniqueBasename = 0

  for (const from of scanned) {
    linesOf(from).forEach((line, i) => {
      const at = `${from}:${i + 1}`

      for (const m of line.matchAll(CITATION)) {
        const [, raw, startStr, endStr] = m
        const start = Number(startStr)
        const end = endStr ? Number(endStr) : null
        const cited = `${raw}:${endStr ? `${start}-${end}` : start}`

        if (!RESOLVABLE_EXT.has(extname(raw))) {
          unresolvableByExtension++
          continue
        }

        let target = null
        if (raw.includes('/') && tracked.has(raw)) {
          target = raw
          resolvedFullPath++
        } else {
          // Unique-basename resolution: resolve a bare basename if and only if
          // exactly one tracked file carries it. `use-syncplay-client.ts` is
          // unique and resolves; `syncplay.ts` is carried by both
          // src/main/syncplay.ts and src/renderer/src/stores/syncplay.ts, so it
          // is counted as uncheckable instead of resolved against a coin flip.
          const candidates = (byBasename.get(basename(raw)) || []).filter(
            (c) => c === raw || c.endsWith('/' + raw)
          )
          if (candidates.length === 1) {
            target = candidates[0]
            resolvedUniqueBasename++
          } else if (candidates.length > 1) {
            ambiguous.push({ at, cited, candidates })
            continue
          } else {
            failures.push({ at, cited, why: 'no such file in this repo' })
            continue
          }
        }

        if (end !== null && end < start) {
          failures.push({ at, cited, target, why: 'range starts after it ends' })
          continue
        }
        const len = linesOf(target).length
        if (start > len || (end !== null && end > len)) {
          failures.push({ at, cited, target, why: `${target} has ${len} lines` })
          continue
        }

        resolved.push({ at, cited, target, start, end })
        const why = suspiciousLanding(linesOf(target), target, start)
        if (why) {
          suspicious.push({ at, cited, target, start, why })
        } else {
          const gap = interiorBlankLine(linesOf(target), start, end)
          if (gap !== null) {
            suspicious.push({ at, cited, target, start: gap, why: 'blank line' })
          }
        }

        const quote = extractMarkedQuote(linesOf(from), i, line.slice(m.index + m[0].length))
        if (quote !== null) {
          marked.push({ at, cited, target, quote })
          const verdict = verifyQuote(linesOf(target), {
            start,
            end,
            quote,
            self: from === target,
            citedAt: i + 1
          })
          if (verdict) quoteFailures.push({ at, cited, target, quote, ...verdict })
        }
      }

      // Blank the full citations out first, so the line number inside a
      // path-carrying citation is not also counted as a pathless anchor.
      const stripped = line.replace(CITATION, (s) => ' '.repeat(s.length))
      for (const m of stripped.matchAll(PATHLESS)) {
        pathless.push({ at, anchor: `:${m[2]}${m[3] ? '-' + m[3] : ''}` })
      }
    })
  }

  return {
    scannedCount: scanned.length,
    resolved,
    resolvedFullPath,
    resolvedUniqueBasename,
    unresolvableByExtension,
    failures,
    suspicious,
    marked,
    quoteFailures,
    ambiguous,
    pathless,
    uncheckable: ambiguous.length + pathless.length
  }
}

/**
 * @returns {{ ok: boolean, out: string[], err: string[] }}
 */
export function report(r, pins = {}) {
  const landingPin = pins.suspiciousLanding ?? SUSPICIOUS_LANDING_PIN
  const uncheckablePin = pins.uncheckable ?? UNCHECKABLE_PIN
  const markedPin = pins.marked ?? MARKED_PIN
  const out = []
  const err = []

  out.push(`check:line-citations — scanned ${r.scannedCount} files`)
  out.push(
    `  resolved: ${r.resolved.length} (${r.resolvedFullPath} by full path, ` +
      `${r.resolvedUniqueBasename} by unique basename)`
  )
  out.push(`  unresolvable by construction: ${r.unresolvableByExtension} (foreign extension)`)
  out.push(
    `  uncheckable, names this repo: ${r.uncheckable} ` +
      `(${r.ambiguous.length} ambiguous basename, ${r.pathless.length} pathless) — pin ${uncheckablePin}`
  )
  out.push(`  suspicious landings: ${r.suspicious.length} — pin ${landingPin}`)
  out.push(
    `  marked quotes: ${r.marked.length} verified against their target ` +
      `(${r.quoteFailures.length} failing) — floor ${markedPin}`
  )

  let ok = true

  // A floor rather than an exact pin, because the two directions are not alike.
  // The class cannot grow silently — marking is opt-in, so the population is
  // exactly the anchors that volunteered, and a new one arriving is a retrofit
  // nobody should have to bump a number for. It can shrink silently, which is
  // the direction that costs coverage: `marked` was printed and asserted
  // nowhere, so an anchor could leave the verified population with the gate
  // green and exit 0. See `MARKED_PIN` for the four edits that do it.
  //
  // The escape hatch for a citation that genuinely points at "around here" is
  // still to not mark it — that degrades to the rest of this gate rather than
  // to a silenced failure — but it now costs a deliberate lowering of the
  // floor rather than nothing at all.
  if (r.marked.length < markedPin) {
    ok = false
    err.push(
      '',
      `Marked-citation count fell: ${r.marked.length}, floor at ${markedPin}.`,
      'An anchor left the verified population. Usually the `("…")` was dropped or',
      'reshaped while the surrounding sentence was rewritten: the spelling is fixed at',
      'one space, one open paren, one double quote, so `, which says ("…")`, a `("`',
      "wrapped onto the next line, `('…')` and a doubled space all de-mark it",
      'silently. Restore the marked form, or, if the anchor was genuinely de-marked on',
      'purpose, lower MARKED_PIN in scripts/check-line-citations.mjs and say why in the',
      'commit message.'
    )
  }

  if (r.quoteFailures.length > 0) {
    ok = false
    err.push('', `${r.quoteFailures.length} marked citation(s) no longer quote their target:`, '')
    for (const q of r.quoteFailures) {
      err.push(`  ${q.at}: \`${q.cited}\` quotes "${q.quote}"`)
      if (q.elsewhere.length === 0) {
        err.push(`    stale — that text is nowhere in ${q.target}`)
      } else if (q.elsewhere.length === 1) {
        err.push(`    drift — it is at ${q.target}:${q.elsewhere[0]}`)
      } else {
        err.push(
          `    drift — it is at ${q.elsewhere.map((n) => `${q.target}:${n}`).join(', ')};` +
            ' more than one match, so pick the one the prose means'
        )
      }
    }
    err.push(
      '',
      'A citation written as `path:NN ("quoted text")` claims the quote is at that',
      'line or inside that range. Repoint the anchor at the line named above, or, if',
      'the target really was rewritten, requote it. Dropping the `("…")` turns the',
      'anchor back into an unverified one rather than silencing a failure.'
    )
  }

  if (r.failures.length > 0) {
    ok = false
    err.push('', `${r.failures.length} citation(s) do not resolve:`, '')
    for (const f of r.failures) err.push(`  ${f.at}: cites \`${f.cited}\` — ${f.why}`)
    err.push(
      '',
      'Fix the path or the line number. A citation to a file outside this repo must',
      'use an extension this repo does not contain (e.g. upstream `.py`).'
    )
  }

  if (r.suspicious.length !== landingPin) {
    ok = false
    err.push(
      '',
      `Suspicious-landing count ${r.suspicious.length > landingPin ? 'rose' : 'fell'}: ` +
        `${r.suspicious.length}, pinned at ${landingPin}.`,
      ''
    )
    for (const s of r.suspicious) {
      err.push(`  ${s.at}: \`${s.cited}\` lands on a ${s.why} (${s.target}:${s.start})`)
    }
    err.push(
      '',
      'A citation landing on a blank line, a brace or a comment is usually stale:',
      'read the target and point the anchor at the code the prose describes. If the',
      'landing really is deliberate, raise SUSPICIOUS_LANDING_PIN in',
      'scripts/check-line-citations.mjs and say why in the commit message.'
    )
  }

  if (r.uncheckable !== uncheckablePin) {
    ok = false
    err.push(
      '',
      `Uncheckable-anchor count ${r.uncheckable > uncheckablePin ? 'rose' : 'fell'}: ` +
        `${r.uncheckable}, pinned at ${uncheckablePin}.`,
      'These name something in this repo but cannot be resolved, so the gate cannot',
      'vouch for them.'
    )
    if (r.uncheckable > uncheckablePin) {
      err.push(
        '',
        'If you added an anchor: give it a path the gate can resolve, so it is',
        'checked rather than counted — the full repo-relative path, or the shortest',
        'suffix of it only one tracked file matches (a leading directory or two is',
        'usually enough). A bare basename two files carry is what lands here. Raise',
        'the pin only if you cannot.'
      )
      if (r.ambiguous.length > 0) {
        err.push('', 'Ambiguous basenames:')
        for (const a of r.ambiguous) {
          err.push(`  ${a.at}: \`${a.cited}\` → ${a.candidates.join(', ')}`)
        }
      }
    } else {
      err.push('', 'If you spelled an anchor out or removed one: lower the pin to match.')
    }
  }

  if (ok) out.push('', 'OK')
  return { ok, out, err }
}

// --- CLI ----------------------------------------------------------------------

function main() {
  const files = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
    .split('\0')
    .filter(Boolean)

  const { ok, out, err } = report(
    analyze({ files, readLines: (p) => readFileSync(p, 'utf8').split('\n') })
  )
  console.log(out.join('\n'))
  if (err.length > 0) console.error(err.join('\n'))
  if (!ok) process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith('check-line-citations.mjs')) main()
