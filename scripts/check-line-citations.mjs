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
// docs/testing.md:396 ("it is never the assertion that catches set rot")
// warns about: nobody diffs it.
//
// The one case where meaning *is* decidable is #366's marked form: a citation
// that carries its own target verbatim, `<path>:<n> ("quoted text")`. Comparing
// that quote against the cited line is a substring test, not a judgement about
// prose, so it hard-fails rather than warns. See `extractMarkedQuote()`.
//
// #407 adds the second decidable case, and it is the one every heuristic above
// is blind to by construction: an anchor that still resolves, still lands on a
// live code line, and names the WRONG line because the target grew above it.
// Nothing in the head tree alone tells that apart from a correct anchor — a
// wrong line holding code looks exactly like a right one — so the check is a
// comparison against the PR's base. Same token, different content at the line it
// names, and that content still present in the file at least as often as before:
// then the line moved and the anchor did not follow. See `verifyNoDrift()`. It
// hard-fails and carries no pin, because unlike a suspicious landing there is no
// legitimate steady-state population of anchors pointing at the wrong line.
//
// Run: npm run check:line-citations

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { baseRevision } from './check-version-not-lower.mjs'

// --- pins ---------------------------------------------------------------------
//
// Exact-match assertions, per docs/testing.md:386 ("Pin the count, never just
// loop over the set"). Moving one is a deliberate act with a reason in the
// commit message, not a side effect of an unrelated edit.

// Citations landing on a blank line, a bare brace or a comment line — and
// since #344 that enumeration is not uniform: blank applies to every tracked
// extension, the other three to code only, because `.md` is exempt from those
// three and subject to blank. Zero was not an aspiration: every such landing on
// this tree was stale, and the repair half of #336 fixed all thirteen while
// #344 repaired the two markdown anchors its narrowing exposed, so the
// heuristic's measured false-positive rate here is zero. The first genuinely
// deliberate comment landing raises it by what it adds, with its reason.
//
// #390 is that first case and it brings three at once, all of them anchors in
// the `blankCommentsAndStrings` docstring in the two-peer loop test. That
// guard's subject *is* which `goToEpisode(` matches are comments rather than
// call sites, so its worked examples can only be comment lines: two are the
// prose matches it must not count, in the episode-change sibling, and the third
// is the quote-awareness clause it re-implements rather than lifts, in the
// player-lifecycle-scope docstring. Pointing any of the three at neighbouring
// code would name a line the prose does not mean, which is the failure this
// heuristic exists to catch. Deliberately written without anchors of their own:
// citing the three targets here would land on the same comment lines again and
// double the count this pin is trying to state. They were the only comment
// landings on this tree when #390 landed; #384 below added the fourth.
//
// What this pin does not cover, and what `resolved` does not attest: an anchor
// landing on a live code line is checked for existence only. The four
// same-file anchors in the `suspiciousLanding()` comment below all target
// `if (…)` lines, so while they are right nothing here has anything to say
// about them — they are attested as "the target line exists", not as
// drift-checked.
//
// WHAT THAT DOES NOT MEAN, and #395 is the correction: it does not mean they go
// stale invisibly. This paragraph predicted that "a single line inserted above
// the ladder re-points each at its neighbour's test, green and wrong", and #393
// inserted exactly that line: the build went RED and wrong. The predicates
// classify the anchor's NEW landing, not the `if (…)` line it used to name, and
// the ladder is interleaved with comment lines and closes its `#` branch on a
// bare `}` — so an insertion above it re-points one or two of the four onto
// lines the comment-line and bare-brace tests do catch, depending both on where
// the line goes and on what it is. All measured on this tree: a live-code line
// above the blank predicate's comment block catches two, `suspicious` 4 -> 6;
// directly above `if (text === '')` it catches one, the bare-brace anchor, at
// 4 -> 5, because the first anchor then lands on the inserted line itself; make
// that inserted line a comment and it is two again. #393 measured three of four
// on its own tree. Either way `suspicious` rises, the count is compared with
// `!==`, and the gate fails. Since #407 `verifyNoDrift()` names them
// individually as well.
//
// The failure it produces is the thing worth knowing, and it is narrower than
// either "green and wrong" or "caught": it names whichever siblings happened to
// land on a comment or a brace and says NOTHING about the ones that landed on
// live code, which are stale too and ride in underneath a failure about their
// neighbours. A reviewer who repairs what the gate named has repaired half the
// drift and has been told nothing about the rest. #345 kept these anchors for
// the inbound-anchor coverage on the record that `resolved` counts anchors that
// resolve, not anchors that are checked.
//
// #384 is the second case and it brings one. The premise correction in the
// conformance-harness header cites the fixture's own `Deliberately **not**
// modelled: the ignoringOnTheFly ignore window` entry in
// `test/helpers/syncplay-min-election-server.ts`, because the claim it carries
// is an *absence*. What makes a counter-less frame loud rather than inert is
// that the model never grew an ignore window to discard it with, and an absence
// has no code line to point at: the nearest code would name the receipt-time
// stamp or the playstate guard below it, neither of which is the thing the
// prose means. The sibling docstring in `conformance/helpers/wire-peer.ts`
// argues the same correction and anchors the other half of it — that stamp — at
// a live code line instead, so one comment landing covers the pair rather than
// two. Deliberately written without an anchor of its own, for the reason the
// #390 paragraph gives: citing the target here would land on the same comment
// line again and double the count this pin is trying to state. A fifth reds.
//
// #486 removed two of #390's three: the episode-change sibling's prose matches
// went with the believed-wrong cases that fix inverted, and the loop test's
// docstring stopped citing them. What remains is #390's player-lifecycle-scope
// anchor and #384's one, so the pin drops to two. A third reds.
export const SUSPICIOUS_LANDING_PIN = 2

// Anchors that name something in this repo and still cannot be checked:
// basenames carried by more than one tracked file, plus pathless `:NNN`
// anchors that inherit their path from a neighbouring line. Bounding the
// blindness is the point — a gate that silently resolves nothing and a gate
// that resolves everything and passes are otherwise indistinguishable. Adding
// an anchor the gate cannot see reds this, and the fix is almost always to
// spell the path out rather than to raise the number.
//
// 10 ambiguous basenames + 105 pathless anchors on this tree.
//
// #392 is the first move in the reducing direction: four anchors that had been
// leaning on a neighbouring line for their path — one `server.py:877` and three
// `protocols.py:780-781` — were spelled out onto the pinned reference sources,
// which are foreign extensions. Spelled out they are unresolvable by
// construction rather than uncheckable, so they left this class outright and
// the pin falls with them rather than absorbing them.
export const UNCHECKABLE_PIN = 115

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
// 75 marked citations on this tree, raised from 64 in the change that retrofitted
// every plain anchor into `test/helpers/syncplay-min-election-server.ts` — nine in
// other files, two self-anchors in its own header — under #395's standing
// instruction to move this floor with every retrofit. It had just reached 64
// against 64 — slack 0, the state that makes it bind — so leaving it there would
// have handed the eleven back as slack and made the floor decoration again.
export const MARKED_PIN = 75

// A CEILING, compared with `>`, and the only pin here that is. Upstream
// Syncplay anchors are the one population where GROWTH is the dangerous
// direction, so it is `MARKED_PIN`'s mirror image and wants the mirrored
// comparison. Neither half of that floor's rationale survives the reflection:
// writing an upstream anchor is not opt-in, because a foreign extension is the
// only way to cite upstream at all, and none of these is checked by anything —
// `RESOLVABLE_EXT` counts a `.py` target as unresolvable by construction, so no
// landing predicate below ever runs on it and no line number is ever compared
// against anything.
//
// Counted as UNMARKED rather than folded into `marked` above. Zero of the 262
// carry a quote today, so widening that population would make its own printed
// sentence — "verified against their target" — false by 262 in a single step.
// Hence a separate counter and a separate printed line, and deliberately no
// `.py`-marked floor constant beside it: the ceiling states the same property
// from the other side, and a second number would only be one more thing to keep
// in step.
//
// What the ceiling buys that a floor could not: `analyze()` has no notion of
// "added in this PR" — it compares one aggregate against one constant — so a
// floor says only "the count must not fall" and a new unmarked upstream anchor
// arrives green. One past this ceiling reds in the PR that writes it. The
// anchors already here are grandfathered rather than retrofitted under duress,
// and a retrofit lowers the count, so the number ratchets toward zero instead of
// waiting for someone to remember to raise it. A fall is silent, as `MARKED_PIN`
// spent 52 anchors demonstrating: lowering this to match is what converts a
// retrofit into coverage, and skipping it costs nothing today and everything
// later.
//
// 262 unmarked upstream-Python anchors on this tree, and re-measuring it has a
// trap worth stating rather than rediscovering. A direct scan of tracked files
// returns 292 — 286 unmarked and 6 marked — not the 262 pinned here. The 30 extra
// are fixture strings in `test/check-line-citations.test.ts`, and that number
// moves with every fixture added: pin against what the gate counts.
export const UNMARKED_PY_PIN = 262

// --- configuration ------------------------------------------------------------

// `'.'` is the repo root itself — files with no directory component, which a
// list of named directories cannot reach. The root holds the two most
// anchor-prone prose files in the repo (the architecture index and the rules
// file), and an anchor there is worse than unchecked: it does not enter the
// uncheckable pin either, so the gate prints OK, no pin moves, and nobody
// learns it exists. Naming the root files individually would rot the first time
// a root doc is added, so the root is a root instead. Nine root files join the
// scan under this arm and none carries an anchor today.
export const SCAN_ROOTS = ['.', 'src', 'test', 'docs', 'e2e', 'scripts', '.github', 'conformance']

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
 * interior line is a brace or a comment (src/main/syncplay.ts:995-1001,
 * src/main/syncplay.ts:954-962 and
 * src/renderer/src/composables/use-syncplay-client.ts:1879-1881), so
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
  // test at scripts/check-line-citations.mjs:383 can, and they are not exempt
  // for the same reason — saying they are attributes one's evidence to the
  // others. The comment-line test at scripts/check-line-citations.mjs:407 is a
  // *measured* syntax collision with Markdown emphasis: of the 135 lines it
  // matches across the tracked `.md`, 102 are `**bold**` openers and 25 open
  // with a single `*` (17 emphasis, 8 bullets), leaving 8 comment-shaped — the
  // false positive is demonstrated on the very lines #344 repaired *to*:
  // docs/syncplay.md:248 ("Both directions of the ping exchange") and
  // docs/syncplay.md:334 ("Two sentences of the original argument for the cap
  // were wrong") are both `**` openers, so hoisting this return past it would
  // red the gate on the repair itself. The bare-brace test at
  // scripts/check-line-citations.mjs:406 and the `<!--` test at
  // scripts/check-line-citations.mjs:424 have no measured false positive in
  // either direction — all 16 brace matches across the tracked `.md` sit
  // inside fenced code blocks and nothing starts a line with `<!--` — so they
  // stay exempt on an *argument*: a fenced `}` carries code semantics, and
  // markup is not a line anyone cites deliberately. That `<!--` test is also
  // what makes this return's placement observable rather than equivalent to
  // deleting it, which the fixtures in test/check-line-citations.test.ts pin.
  // The hash-comment branch below cannot fire for a `.md` target at all.
  if (extname(targetPath) === '.md') return null
  if (/^[}\])]+[;,]?$/.test(text)) return `bare \`${text}\``
  if (/^(\/\/|\/\*|\*)/.test(text)) return 'comment line'
  // `.py` joined the hash-comment languages in #395, and it is the one entry
  // here that fires on NO anchor in this tree — `RESOLVABLE_EXT` cannot resolve
  // a `.py` target, so this function is never reached for one. It is written now
  // because the moment a pinned upstream copy is on disk, the ~260 upstream
  // anchors resolve all at once and an anchor sitting on a Python comment would
  // pass silently through the only predicate that had anything to say about it.
  // A predicate and a fixture now, or a fresh hole of exactly this gate's own
  // kind later. Covered by a fixture rather than by the tree: the test file
  // injects a `resolvableExt` that contains `.py`.
  const ext = extname(targetPath)
  if (
    (ext === '.yml' || ext === '.yaml' || ext === '.sh' || ext === '.py') &&
    text.startsWith('#')
  ) {
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

// --- drift (#407) -------------------------------------------------------------

// How much of a base line a drift failure echoes. `docs/syncplay.md`'s bullets
// are multi-thousand-character single lines, so an untruncated echo turns one
// failure into a screenful and scrolls every other failure out of the terminal —
// in a gate whose whole output is a list of numbers to copy.
const DRIFT_ECHO = 96

const truncate = (s) => (s.length <= DRIFT_ECHO ? s : s.slice(0, DRIFT_ECHO - 1) + '…')

/**
 * Lines of `lines` whose content equals `needle` after `normalizeQuote()`.
 *
 * WHOLE-LINE EQUALITY, NEVER `.includes` — the rule decided in #407's round 3,
 * and the one thing in this check a later hand is most likely to "simplify" into
 * the substring match `verifyQuote()` uses three functions up. The two answer
 * differently and only one of them is usable here. `clearPendingUserPause()`
 * occurs at ten lines of
 * `src/renderer/src/composables/use-syncplay-client.ts`; a normalized substring
 * match takes all ten — the declaration, a one-line `if` and three backticked
 * comment-prose mentions included — where whole-line equality takes the five that
 * are the bare call and nothing else. That is a tidiness argument. The structural
 * one is fatal: a short line like `}` or `return` would match half its file under
 * substring matching, and an empty base line would match all of it, so both the
 * elsewhere-search and the occurrence count below would report on every anchor
 * whose target line is short. `test/check-line-citations.test.ts` carries a
 * fixture whose only purpose is to red if the comparison is swapped back.
 */
const matchingLines = (lines, needle) => {
  const hits = []
  for (let n = 1; n <= lines.length; n++) {
    if (normalizeQuote(lines[n - 1] ?? '') === needle) hits.push(n)
  }
  return hits
}

/**
 * Decide whether the anchor naming line `line` of the target has drifted off the
 * content the base tree had there. Returns null for "no drift to report" —
 * which, deliberately, covers three quite different situations — and
 * `{ elsewhere, baseText }` when the content moved and these are the lines it
 * moved to.
 *
 * The three passes, in the order they are tested:
 *
 * 1. **The content is unchanged.** Compared after `normalizeQuote()`, so a
 *    whitespace-only reflow or a reindent of the anchored line is not a change
 *    at all. That makes "a reflow passes" true here rather than a consequence of
 *    the two narrowings below happening to miss it.
 * 2. **The old content is nowhere else in head** — an in-place edit. The line was
 *    reworded where it stands, the anchor still points at the thing it always
 *    pointed at, and there is no other line to retarget it to. Failing this
 *    would block the most ordinary edit there is with nothing the author could do
 *    to satisfy the gate.
 * 3. **The old content occurs LESS often in head than in base.** The narrowing
 *    above is not enough on content that repeats: reword one of three identical
 *    lines in place and the elsewhere-search still finds the other two, so the
 *    gate would report "pick one of two" on an anchor that never moved. A genuine
 *    relocation keeps the count at *k* — the line moved, it did not vanish —
 *    while an in-place edit or a deletion of the anchored copy drops it to *k−1*.
 *
 * Its two residuals, from #407 and named rather than left to be discovered: a
 * commit that both relocates the anchored copy and deletes another copy of the
 * same content misses the drift (a non-regression, since nothing catches it
 * today), and a commit that both edits the anchored copy in place and adds a new
 * copy of its old content elsewhere blocks falsely. The second is the one that
 * costs something, because drift is a hard failure and the author cannot make it
 * pass; hitting it is the stated trigger to switch to mapping base lines through
 * `git diff -U0` hunks, which is exact and has neither residual.
 *
 * Base content that normalizes to `''` is skipped outright: a blank landing is
 * `suspiciousLanding()`'s job, and an empty needle would otherwise match every
 * blank line in the file.
 *
 * @param {string[]} baseLines  the target file as the base tree has it
 * @param {string[]} headLines  the target file as this tree has it
 * @param {{ line: number, self: boolean, citedAt: number }} opts
 * @returns {{ elsewhere: number[], baseText: string } | null}
 */
function verifyNoDrift(baseLines, headLines, { line, self, citedAt }) {
  const baseText = baseLines[line - 1]
  if (baseText === undefined) return null
  const needle = normalizeQuote(baseText)
  if (needle === '') return null

  const headHits = matchingLines(headLines, needle)
  if (headHits.includes(line)) return null

  // The citing line is excluded from the REPORT for the same reason
  // `verifyQuote()` excludes it: naming it would be telling the author their
  // anchor should point at their own sentence. It stays in both COUNTS, where
  // excluding it on one side only would bias the comparison by one.
  const elsewhere = headHits.filter((n) => !(self && n === citedAt))
  if (elsewhere.length === 0) return null
  if (headHits.length < matchingLines(baseLines, needle).length) return null

  return { elsewhere, baseText }
}

const underRoot = (p, roots) =>
  roots.some((r) => (r === '.' ? !p.includes('/') : p === r || p.startsWith(r + '/')))

/**
 * @param {object} opts
 * @param {string[]} opts.files        every tracked path, repo-relative
 * @param {(p: string) => string[]} opts.readLines
 * @param {((p: string) => string[] | null) | null} [opts.readBaseLines]
 *   the same file as the PR's base tree has it, or null for a path the base does
 *   not carry. Omit it and the drift check does not run — which is how every
 *   fixture that predates #407 keeps working, and how a tree with no base to
 *   compare against degrades. `git` stays outside this function: the tests build
 *   both trees in memory and never touch a repository.
 * @param {string | null} [opts.baseLabel] the revision `readBaseLines` reads, for
 *   the report line only. Nothing branches on it.
 * @param {string[]} [opts.scanRoots]
 * @param {string[]} [opts.excludedPaths]
 * @param {Set<string>} [opts.resolvableExt]
 *   injectable for one reason only: `.py` is not in `RESOLVABLE_EXT` and cannot
 *   be, so every predicate that runs on an upstream target is unreachable from a
 *   fixture without this seam — including the hash-comment branch #395 added for
 *   exactly that population. A fixture that widens it is testing the predicate
 *   ladder against the tree a pinned upstream copy would produce. The default is
 *   `RESOLVABLE_EXT`, so the real gate's behaviour is untouched.
 */
export function analyze({
  files,
  readLines,
  readBaseLines = null,
  baseLabel = null,
  scanRoots = SCAN_ROOTS,
  excludedPaths = EXCLUDED_PATHS,
  resolvableExt = RESOLVABLE_EXT
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

  // Batched per file rather than per anchor: 292 resolved anchors on `main` at
  // 04cb4a4 concentrate into far fewer files, and on the CLI path each miss is a
  // `git show`.
  const baseCache = new Map()
  const baseLinesOf = (p) => {
    if (!baseCache.has(p)) {
      const lines = readBaseLines(p)
      if (lines !== null && lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      baseCache.set(p, lines)
    }
    return baseCache.get(p)
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
  const drift = []
  // Advisory only, and deliberately not a pin — see the `out.push` in `report()`
  // that prints it for why no value would work.
  const driftExemptNewFile = []
  let driftChecked = 0
  let unresolvableByExtension = 0
  let unmarkedPy = 0
  // The other half of the same population, kept beside it rather than derived
  // later: a marked `.py` anchor leaves the ceiling without entering `marked`,
  // so nothing downstream of the extension gate below can reconstruct it.
  let markedPy = 0
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

        // Extracted here rather than beside `marked.push` below, because the
        // `.py` ceiling has to see anchors that never reach the resolver: an
        // upstream anchor's whole problem is that it is unresolvable by
        // construction, so a count taken after the `continue` below would be
        // zero for the one population it exists to bound.
        const quote = extractMarkedQuote(linesOf(from), i, line.slice(m.index + m[0].length))

        // Keyed on the EXTENSION, not on whether the anchor resolved: the
        // ceiling is a statement about upstream anchors, and one stays counted
        // whether or not a tracked copy of its target happens to exist. That is
        // also what keeps the fixtures honest — widening `resolvableExt` to reach
        // the predicates must not change this number.
        //
        // Both halves are counted from this one place, keyed on the extension
        // alone, so the split between them is the only thing the quote decides.
        // Counting `markedPy` beside `marked.push` below instead would put it
        // past the `continue` that every `.py` anchor takes, and it would read 0
        // forever.
        if (extname(raw) === '.py') {
          if (quote === null) unmarkedPy++
          else markedPy++
        }

        if (!resolvableExt.has(extname(raw))) {
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

        if (readBaseLines !== null) {
          const baseCiting = baseLinesOf(from)
          const baseTarget = baseLinesOf(target)
          // "The anchor token is unchanged" means the base version of the citing
          // file PARSES a token equal to this one ANYWHERE in the file — not one
          // at the same line. Position-based matching breaks the moment the
          // citing file itself gains a line above the citation, which is the very
          // failure this check exists to catch. Equality is on the token the base
          // line PARSES, not on a substring of that line: `a.ts:N` is a substring
          // of `a.ts:NM`, of the range `a.ts:N-M`, and of `data.ts:N` — spelled
          // with letters here because a literal example would be an anchor to a
          // file that does not exist. A substring precondition therefore held a
          // branch's brand-new anchor to a base claim it never made, and the base
          // token stays in the base whatever the author does: the failure named a
          // line the anchor already pointed at and the only way out was rewording
          // the prose, which is the hard-fail-with-no-way-out class #407 spent
          // three rounds removing. A citing or target file the base does not carry
          // has nothing to compare and is exempt, as is an anchor whose number
          // this commit changed: a hand retarget is exempt by construction, which
          // is #407's stated limit and not an oversight.
          if (
            baseCiting !== null &&
            baseTarget !== null &&
            baseCiting.some((l) =>
              [...l.matchAll(CITATION)].some(
                ([, r, s, e]) => `${r}:${e ? `${Number(s)}-${Number(e)}` : Number(s)}` === cited
              )
            )
          ) {
            driftChecked++
            // `path:N-M` claims both ends, so both are checked. That is NOT the
            // rule `suspiciousLanding()` follows, and deliberately so: its
            // docstring gives a reason peculiar to itself — a cited block's last
            // line is a closing brace by construction, so a landing heuristic
            // judging the interior would red the legitimate ranges. Content
            // equality against the base has no such collision.
            for (const n of end === null || end === start ? [start] : [start, end]) {
              const verdict = verifyNoDrift(baseTarget, linesOf(target), {
                line: n,
                self: from === target,
                citedAt: i + 1
              })
              if (verdict) {
                drift.push({
                  at,
                  cited,
                  target,
                  line: n,
                  end: end !== null && n === end,
                  ...verdict
                })
              }
            }
          } else if (baseCiting === null && baseTarget !== null && quote === null) {
            // #420: the exemption above is not one class but two, and only one of
            // them is benign. A citing file the base does not carry — one this
            // branch ADDS, or one it renamed into place — was measured against the
            // branch's own earlier state, which a base-vs-head comparison cannot
            // see: the anchor may already have been stale when the merge that
            // brought the base in landed. #417 shipped exactly that and a manual
            // sweep caught it, because the landing was a `try {` and no heuristic
            // here had anything to say about it. Collected so the report can NAME
            // those anchors; it stays exempt, because without history there is no
            // telling a stale anchor from a correct brand-new one.
            //
            // `baseTarget === null` stays uncollected on purpose. A target the
            // branch adds or renames has no base content either, so there is
            // nothing an author could be told to compare against, and a rename
            // that broke the anchor is already the resolver's business.
            //
            // A MARKED anchor stays uncollected too, hence `quote === null`. The
            // advisory's whole content is "mark it", and quote verification ran
            // above, outside the base guard: a marked anchor has already been
            // checked against its target, so listing it would be telling the
            // author to do the thing they did.
            driftExemptNewFile.push({ at, cited, target })
          }
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
    unmarkedPy,
    markedPy,
    failures,
    suspicious,
    marked,
    quoteFailures,
    drift,
    driftChecked,
    driftExemptNewFile,
    driftBase: readBaseLines === null ? null : baseLabel,
    driftEnabled: readBaseLines !== null,
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
  const unmarkedPyPin = pins.unmarkedPy ?? UNMARKED_PY_PIN
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
  // Its own line, never folded into the one above: this population is defined by
  // what is NOT verified, so adding it to a count printed as "verified against
  // their target" would falsify that sentence by the whole upstream corpus at
  // once. "Ceiling" rather than "pin" in the text because the comparison is
  // one-sided and a reader copying numbers out of this output has to be able to
  // tell which way it binds.
  out.push(
    `  unmarked upstream .py anchors: ${r.unmarkedPy} — ceiling ${unmarkedPyPin}` +
      ' (unverified by construction)'
  )
  // #395's hatch, and the reason it needs a line of its own rather than a share
  // of either neighbour. The marked quote is extracted ABOVE the extension gate
  // in `analyze()`, so a MARKED `.py` anchor leaves the ceiling line above —
  // which is defined as the unmarked population — and then takes the gate's
  // `continue` before `marked.push` and `verifyQuote()`, so it cannot join the
  // `marked quotes` line either: that text promises "verified against their
  // target" and this class is verified by nothing. Folded into either one it
  // would make that line's own sentence false, which is the same objection
  // `UNMARKED_PY_PIN` makes to folding the ceiling into `marked`.
  //
  // Printed even at zero, which is the count today, and deliberately carrying NO
  // pin: the ceiling already bounds the upstream corpus from the other side, and
  // a constant here would bind the direction nobody wants bound — marking an
  // upstream anchor is the remedy the ceiling's own failure text recommends, so
  // a floor would penalise the retrofit and a ceiling would penalise the cure.
  // Visibility is the whole ask: the class is empty now, and a figure that reads
  // 0 is how it stops growing unobserved.
  out.push(
    `  marked .py anchors: ${r.markedPy} — outside the ceiling,` + ' compared with nothing (no pin)'
  )
  // Printed even at zero, and printed differently when the check did not run at
  // all. "0 drifted" and "not compared" are the two outcomes a reader has to be
  // able to tell apart: one is the gate working, the other is the gate absent,
  // and a single line reading `drift: 0` would render them identical — which is
  // the shape docs/testing.md warns about in *Structural tests*.
  out.push(
    r.driftEnabled
      ? `  drift: ${r.driftChecked} anchor(s) compared against ` +
          `${r.driftBase ?? 'the base tree'} (${r.drift.length} drifted)`
      : '  drift: not compared (no base revision)'
  )
  // #420's bucket, on its own line and never folded into the drift line above:
  // `driftChecked` keeps the meaning the scanned-against-compared cross-checks in
  // PR descriptions rely on, and a third number in that arithmetic has to be
  // introduced explicitly rather than absorbed. Advisory in both directions — it
  // goes to `out` rather than `err`, because `err` is non-empty only when
  // something failed and CI log readers skim stderr as "what broke", and it never
  // touches `ok`.
  //
  // THERE IS NO PIN AND THERE CANNOT BE ONE. Every other count here is a property
  // of the head tree, so a value measured on `main` stays valid on every branch.
  // This one is base-relative: on `main` the base tree and the head tree are the
  // same object, so it measures zero by construction rather than by luck, and is
  // non-zero on precisely the PRs it exists to notice. An exact pin at zero
  // therefore reds every PR that adds a cited test file with "edit the pin" as the
  // only repair, which is the hard-fail-with-no-way-out class #407 spent three
  // rounds removing; a `MARKED_PIN`-shaped floor does not rescue it either,
  // because a floor at zero is unfalsifiable and a ceiling at zero is the exact
  // pin again.
  //
  // The anchors are listed rather than counted because a bare number gives the
  // author nothing to act on, and the marked form is named as the remedy because
  // quote verification runs outside the base guard above and so survives the
  // exemption: it reports the correction, naming the line the content moved to.
  // Taking the remedy also takes the anchor off this list — collection skips a
  // marked one — so the advisory only ever names anchors nothing has checked,
  // and acting on it shortens it.
  if (r.driftExemptNewFile.length > 0) {
    out.push(
      `  drift-exempt, citing file not in the base: ${r.driftExemptNewFile.length}` +
        ' (advisory, no pin)'
    )
    for (const e of r.driftExemptNewFile) out.push(`    ${e.at}: cites \`${e.cited}\``)
    out.push(
      '    A file the base does not carry — added on this branch, or renamed into',
      '    place — has no base anchor token, so the comparison above skipped these',
      '    rather than clearing them. To have one checked, mark it: a citation',
      '    written `path:NN ("quoted text")` is verified against the cited line with',
      '    no base revision at all.'
    )
  }

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

  // The mirror of the block above, and the comparison is the only difference that
  // matters: `>` rather than `<`, because here growth is the hazard and a fall is
  // the retrofit. See `UNMARKED_PY_PIN` for why this population cannot be folded
  // into `marked` and why it gets no floor of its own.
  if (r.unmarkedPy > unmarkedPyPin) {
    ok = false
    err.push(
      '',
      `Unmarked upstream .py anchor count rose: ${r.unmarkedPy}, ceiling at ${unmarkedPyPin}.`,
      'Nothing in this repo resolves a `.py` target, so an upstream anchor is checked by',
      'nothing at all: it is counted as unresolvable by construction, no landing',
      'predicate ever sees its target, and its line number is never compared with',
      'anything. The marked form is what makes one checkable —',
      '`server.py:NN ("the quoted line")` carries its own evidence, so a reader can',
      'verify it without the upstream tree, and since #395 step 2 the nightly upstream',
      'check verifies it mechanically against the pinned tree. Mark the anchor you just',
      'added; if it cannot carry a quote, raise UNMARKED_PY_PIN in',
      'scripts/check-line-citations.mjs and say why in the commit message.'
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

  // A HARD FAILURE WITH NO PIN, unlike suspicious landings, which carry one.
  // A pin states a legitimate steady-state population, and there is none here:
  // an anchor that names the wrong line is wrong, and the repair is a number
  // this block has already worked out and printed.
  if (r.drift.length > 0) {
    ok = false
    err.push('', `${r.drift.length} anchor(s) name a line whose content moved in this branch:`, '')
    for (const d of r.drift) {
      err.push(
        `  ${d.at}: \`${d.cited}\` names ${d.target}:${d.line}${d.end ? ' (range end)' : ''}`,
        `    the base had "${truncate(d.baseText.trim())}" there`
      )
      if (d.elsewhere.length === 1) {
        err.push(`    drift — it is at ${d.target}:${d.elsewhere[0]}`)
      } else {
        err.push(
          `    drift — it is at ${d.elsewhere.map((n) => `${d.target}:${n}`).join(', ')};` +
            ' more than one match, so pick the one the prose means'
        )
      }
    }
    err.push(
      '',
      'The cited line still exists, so nothing above this could see it: the target',
      'grew and the anchor stayed put. Copy the line number out of the message —',
      'DO NOT COUNT IT BY HAND. Editing the number is what makes an anchor exempt',
      'from this check, so a retarget that lands one line short goes through green,',
      'and hand-counting is how that happens.',
      '',
      'If the line was reworded where it stands rather than moved, this does not',
      'fire: it reports only when the old content is still in the file at least as',
      'often as the base had it.'
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

/**
 * Which of the three base-resolution paths this tree is on. Pure, so the one
 * decision in the drift check that CI can silently get wrong is testable without
 * a repository: a gate that skips is indistinguishable from a gate that passes,
 * and CI is where it has to run.
 *
 * - `tip` — take the base ref as it stands. This is the CI path, and `ci` is
 *   tested FIRST because that is the only thing that decides it: `actions/checkout`
 *   leaves HEAD on `refs/pull/N/merge`, the head already merged into the base
 *   tip, so comparing against that tip shows only the PR's own changes.
 *
 *   TESTED BEFORE `haveTracking`, AND THAT ORDER IS THE WHOLE CORRECTNESS OF THIS
 *   FUNCTION IN CI. The obvious reading — "CI has no tracking ref, so routing on
 *   `haveTracking` routes CI here anyway" — is false, and measurably so. By the
 *   time this runs, `check:version-not-lower` has already run in the same
 *   `quality` job and taken `baseRevision()`'s fetching branch, and
 *   `git fetch --depth=1 origin <base>` DOES write `refs/remotes/origin/<base>`:
 *   `actions/checkout` builds its clone with `git remote add`, which leaves
 *   `remote.origin.fetch` at `+refs/heads/*:refs/remotes/origin/*`, and that
 *   refspec makes the fetch update the tracking ref opportunistically. So in CI
 *   the tracking ref is reliably PRESENT, and routing on it would send CI down
 *   `merge-base` — where `git merge-base` then exits 1 and finds nothing, because
 *   at depth 1 HEAD's parents are outside the shallow boundary. That is a hard
 *   red on every PR, not a silent skip.
 * - `merge-base` — a local clone with the remote-tracking ref. Take the BRANCH
 *   POINT, not the tip: locally `origin/main` is usually ahead of the fork, so the
 *   tip would read every shift that landed on `main` since as this branch's drift.
 *   Getting this and `tip` the wrong way round yields a gate that reds
 *   unconditionally in CI and one that blames the branch for all of `main`
 *   locally.
 * - `skip` — no tracking ref and no remote at all, outside CI. There is genuinely
 *   no base to compare against, so the check cannot run; it says so loudly rather
 *   than printing a zero.
 * - `fail` — the same, in CI, where a missing base is a failure and not a skip. A
 *   skip there would turn this gate off in the one place it must run.
 *
 * @param {{ haveTracking: boolean, haveOrigin: boolean, ci: boolean }} env
 * @returns {{ path: 'merge-base' | 'tip' | 'skip' | 'fail', why?: string }}
 */
export function driftBasePlan({ haveTracking, haveOrigin, ci }) {
  if (ci) {
    if (haveTracking || haveOrigin) return { path: 'tip' }
    return {
      path: 'fail',
      why: 'no remote-tracking base ref and no `origin` remote to fetch one from'
    }
  }
  if (haveTracking) return { path: 'merge-base' }
  if (haveOrigin) return { path: 'tip' }
  return { path: 'skip', why: 'this clone has no `origin` remote' }
}

const gitOk = (args) => {
  try {
    execFileSync('git', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * The revision whose trees the drift check reads, or null when there is no base
 * and we are not in CI. Exits on the paths `driftBasePlan()` calls failures —
 * including `baseRevision()`'s own exit when its shallow fetch fails.
 *
 * @param {string} baseRef
 * @returns {string | null}
 */
function driftBaseRevision(baseRef) {
  const tracking = `refs/remotes/origin/${baseRef}`
  const plan = driftBasePlan({
    haveTracking: gitOk(['rev-parse', '--verify', '--quiet', tracking]),
    haveOrigin: gitOk(['remote', 'get-url', 'origin']),
    ci: !!process.env.CI
  })

  if (plan.path === 'fail') {
    console.error(`\nCannot check citation drift against '${baseRef}': ${plan.why}.`)
    process.exit(1)
  }
  if (plan.path === 'skip') {
    console.error(
      `\nNOT CHECKING CITATION DRIFT: ${plan.why}, so there is no '${baseRef}' to\n` +
        'compare against. Every other check below still ran. In CI this is a failure.'
    )
    return null
  }

  // `baseRevision()` prefers the tracking ref and otherwise fetches one shallow
  // ref to FETCH_HEAD, failing closed if that fetch fails. Reused rather than
  // reimplemented so the two gates cannot disagree about where the base is.
  const rev = baseRevision(baseRef)
  // THE PLAN DECIDES, not the shape of what `baseRevision()` handed back. Keying
  // this off `rev === 'FETCH_HEAD'` would put CI on the merge-base path, since
  // there the tracking ref exists by then and `baseRevision()` returns it — see
  // `driftBasePlan()`.
  if (plan.path === 'tip') return rev
  try {
    return execFileSync('git', ['merge-base', 'HEAD', rev], { encoding: 'utf8' }).trim()
  } catch {
    console.error(`\nCould not find the merge base of HEAD and ${rev}.`)
    process.exit(1)
  }
}

/**
 * @param {string} rev
 * @returns {(p: string) => string[] | null}
 */
function baseReaderAt(rev) {
  return (p) => {
    try {
      return execFileSync('git', ['show', `${rev}:${p}`], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      }).split('\n')
    } catch {
      // Absent from the base tree: a file this branch adds, or one it renamed
      // into place. Nothing to compare, and the resolver above already owns a
      // rename that broke the anchor.
      return null
    }
  }
}

function main() {
  const files = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
    .split('\0')
    .filter(Boolean)

  const baseRev = driftBaseRevision(process.env.GITHUB_BASE_REF || 'main')

  const { ok, out, err } = report(
    analyze({
      files,
      readLines: (p) => readFileSync(p, 'utf8').split('\n'),
      readBaseLines: baseRev === null ? null : baseReaderAt(baseRev),
      baseLabel: baseRev
    })
  )
  console.log(out.join('\n'))
  if (err.length > 0) console.error(err.join('\n'))
  if (!ok) process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith('check-line-citations.mjs')) main()
