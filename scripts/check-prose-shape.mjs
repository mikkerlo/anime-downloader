#!/usr/bin/env node
// CI gate for Markdown prose shape under the prose roots (#370). PR 1 shipped
// this print-only, so that a script nobody could red renumbered nothing while
// #366 and #369 were still moving the file it measures. PR 2 adds clause (e)
// and the pin below, which is what turns it into a gate.
//
// Why a bespoke script rather than the formatter: `.prettierignore` carries
// `**/*.md`, so `format:check` never opens a Markdown file — but removing that
// line fixes nothing here. `.prettierrc` sets no `proseWrap`, and the default is
// `preserve`: Prettier does not reflow prose, so the line that motivated this
// (a line in docs/testing.md left at 41 columns inside a 79-column block) comes
// out byte-identical. A max-column check cannot see it either, by construction —
// the line is too SHORT, not too long. What is left is the shape of the ragged
// edge, which is what this measures.
//
// Run: npm run check:prose-shape
//
// THE PREDICATE IS COMMITTED, NOT TUNED. (a) through (d) were fixed in the
// issue before the count was looked at, and the issue's Risks section forbids
// adjusting them after seeing the number. A line is ragged when all five hold:
//
//   (a) it is inside a BLOCK — a maximal run of prose lines, broken by a blank
//       line, a fence, a heading, a table row, a blockquote, a `---` rule, and
//       a list-item start;
//   (b) it is not the block's last line;
//   (c) `blockMax - len >= 20` — an ABSOLUTE column deficit against the longest
//       line in its own block;
//   (d) it does not end in `.`, `:`, `;`, `!` or `?`;
//   (e) `len + 1 + len(first token of the next line) <= blockMax` — a greedy
//       wrapper COULD have appended the next thing in the paragraph, so the
//       break was chosen rather than forced. See `raggedLines()` for why this
//       one arrived after the count was known and why that is recorded here.
//
// SENSITIVITY, re-measured at this commit rather than carried down from PR 1 —
// every figure below moved, because clause (e) landed and because #379 added
// four ragged lines to docs/testing.md. Inside these scan roots the committed
// predicate reports 9. Dropping clause (e) alone takes it to 18. Dropping the
// list-item boundary alone takes it to 111, 45 of them in TODO.md, which is
// nothing but short bullets. Scanning fence contents takes it to 273, 82 from
// one data-flow diagram and 50 from an ASCII source tree. Those parameters, not
// the idea, decide whether this is a signal or noise.
//
// The honest exception, recorded rather than smoothed over: dropping the
// terminal rule (d) is now COUNT-NEUTRAL on this tree — still 9, where at PR 1
// it was 19 against 14. Clause (e) absorbed the difference; every line (d) was
// holding green is now also a line whose next token could not fit. (d) is still
// load-bearing as a rule — the test drives a corpus where it alone decides, and
// a tree with different prose brings its contribution back — but it is no longer
// evidenced by a live-tree count, and claiming otherwise would be quoting a
// number that stopped being true.
//
// (c) is absolute rather than a ratio deliberately. A ratio makes the bar
// depend on how long the longest line in the block happens to be, which is
// backwards: README.md's `<p>` opener scores as an extreme hit at 3 columns
// against 247 while a genuinely ragged 56-against-80 prose line barely scores.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

// --- pins ---------------------------------------------------------------------
//
// An exact-match assertion, per docs/testing.md ("Pin the count, never just loop
// over the set"). Moving it is a deliberate act with a reason in the commit
// message, not a side effect of an unrelated edit.

// Ragged lines this tree still carries. The convention is UNCHECKABLE_PIN in
// scripts/check-line-citations.mjs, NOT SUSPICIOUS_LANDING_PIN, and the two
// carry opposite instructions to whoever next reds this.
//
// A landing pin of 0 can say "what you just added is a defect, repair it",
// because its measured false-positive rate is zero and every member it ever had
// was repaired. This one cannot be 0: the lines it counts are real, unrepaired,
// and not repairable from here — rewrapping them reflows docs/testing.md and
// renumbers the very citation anchors the sibling gate pins, which is what the
// issue's Risks section says not to do. So it bounds a known blindness instead.
// A ragged line ARRIVING reds the build and the fix is to rewrap the line just
// written; a deliberate repair LOWERS the pin, with its reason.
//
// NEVER RE-PIN TO CLEAR A RED. A number moved to match whatever the tree
// happens to say measures nothing, and this one is the only thing between the
// predicate and a printed figure nobody diffs.
//
// 8 on this tree: 7 in docs/testing.md and 1 in src/shared/README.md. Measured
// at the commit that introduces it, after clause (e), and not carried from the
// 14 PR 1 quoted, the 18 this tree reports without clause (e), or the 6
// estimated in review before #379 landed.
//
// Lowered from 9 by #368, which is the "deliberate repair" case above rather
// than a re-pin to clear a red. The line that left was docs/testing.md:177,
// "`HAVE_NOTHING`, and an episode change),", in the adoption file's entry in
// the two-peer scenario list. #368 moved that file's door from "a seek that
// never lands" to "an element that is not ready" — a real claim change, not a
// rewrap — and the sentence was rewritten and refilled in the process. Nothing
// was rewrapped in order to move this number.
export const RAGGED_PIN = 8

// --- configuration ------------------------------------------------------------

// The column deficit at which a non-final line in a block reads as ragged.
export const DEFICIT = 20

// Prose roots. `'.'` is the repo root itself — files with no directory
// component, which a list of named directories cannot reach; the root holds the
// architecture index, the rules file and the README.
//
// THIS IS NOT `SCAN_ROOTS` in scripts/check-line-citations.mjs. That set
// governs OUTBOUND ANCHORS and covers `src`, `test`, `e2e`, `scripts` and
// `.github` because a citation can be written in any of them. This set covers
// prose a human wrapped by hand, which is a different population: agent
// instruction Markdown under `.claude/`, `.gemini/` and `.github/agents/` is
// out, excluded on THAT ground and not on a hit count.
//
// An earlier draft of this comment defended the boundary as "worth 3.4x on the
// raw count". #370 RETRACTED that and this line is the correction. The 3.4x
// prices the FRONT-MATTER exclusion, not the scope: re-measured at this commit
// with `.claude`, `.gemini` and `.github/agents` added to the roots, the
// committed predicate reports the same 9 over 42 files instead of 23 — scope
// moves the committed count by 1.00x, and 3.4x was never its price. 19 of the
// 44 tracked `.md` live under those roots and every front-matter hit comes from
// them, which is a fact about where the front matter sits, not an argument for
// the boundary. The issue is explicit that the count must not be used to defend
// the exclusion at all; docs/testing.md says the same thing beside this file.
export const SCAN_ROOTS = ['.', 'docs']

// The one prose class outside those roots. `src/**/README.md` is hand-wrapped
// prose sitting in a tree that is otherwise code; the rest of `src` has no
// Markdown at all, so naming the pattern is cheaper than naming a root and
// filtering it back down.
export const SCAN_FILE_PATTERN = /^src\/(?:.*\/)?README\.md$/

// No fixture exclusion here, and that is the design. The sibling gate needs
// `EXCLUDED_PATHS` (scripts/check-line-citations.mjs) because its fixture
// corpus is citation-shaped on purpose and scanning it would red the gate on
// its own test data. This gate's fixtures live INLINE in
// test/check-prose-shape.test.ts as corpus strings handed to `analyze()`, never
// as files on disk, so there is nothing on the tree to exclude and no
// path-shaped trap to re-create. The parameter stays for symmetry with the
// sibling's seam.
export const EXCLUDED_PATHS = []

// --- line classification ------------------------------------------------------

// The marker is CAPTURED, not just detected, and so is EVERYTHING AFTER IT. A
// single boolean toggled on any fence opener lets a `~~~` close a ``` fence and
// a ``` close a 4-backtick one; capturing only the character and the length
// still lets a ```js line close a ```markdown one, because CommonMark carries
// no info string on a CLOSING fence — a marker that has one is content. A docs
// page showing a fenced sample with a language tag is exactly the shape that
// introduces one, and this repo's docs are mostly fenced samples.
//
// CommonMark's closing rule has four parts. THREE are exact here: the closer is
// a run of the SAME character, AT LEAST AS LONG as the opener, and carrying NO
// INFO STRING. The fourth — indented at most 3 columns past the CONTAINER's
// content column — is APPROXIMATED against the OPENER, for the reason below,
// and it is the one part still open. Group 1 is what measures it: under an
// unbounded `^\s*` a 4-space-indented ``` closed the ```markdown fence it was
// sitting in.
//
// RELATIVE to the opener, not to the left margin, and that is the whole care in
// this line. CommonMark measures fence indentation from its CONTAINER's content
// column, so `    ```bash` under an ordered-list item indented to column 4 is a
// perfectly legal fence. This script tracks no containers, so an absolute
// `^ {0,3}` rejects those and their contents leak into the prose population:
// measured on this tree it turns 14 broad hits into 40, 26 raw `jj`/`gh` command
// lines and a JSON blob out of five `.gemini/skills/*/SKILL.md` samples. That is
// the same fail-open class this bound exists to close, arriving from the other
// side. Carrying the opener's own indent is what makes both cases come out
// right without a container stack.
//
// WHAT THE APPROXIMATION STILL LETS THROUGH, measured rather than reasoned: an
// opener indented 1-3 at top level accepts a closer at 4-6, which CommonMark
// calls content, because the opener's own indent is the only container evidence
// there is. With the opener at 3 and the closer at 6, `short code arg` leaks out
// at 17/77 and the real closer then re-opens a fence that swallows the genuine
// 28/74 below it — the info-string bug's two-directional shape, one level up.
// Latent: no tracked `.md` pairs an opener with a closer at a different indent,
// though CLAUDE.md and GEMINI.md both open at 3. `Math.max(fenceIndent, 3)`
// closes it and is count-neutral on both measurements, but then refuses a LEGAL
// closer at 4-5 under a 2-column list container and swallows the rest of the
// file, trading a fail-open for a silently-unmeasured one. Not taken.
//
// Indentation is counted in COLUMNS, so a tab is 4 — which is why a tab-indented
// marker cannot close a fence opened at the margin either.
//
// The asymmetry is deliberate: no bound on an OPENER. An opener decides what is
// EXCLUDED, so a permissive one under-reports; a closer decides what comes BACK
// IN, so a permissive one leaks code into the measurement. Only the second is a
// false positive, and only the second is bounded.
//
// Every part fails OPEN, and in both directions at once: the sample's lines leak
// into the prose population, and the sample's real closer then RE-OPENS a fence,
// so the genuine prose after the block classifies `fenced code` and is silently
// not measured. Group 3 is what the closer branch reads to refuse an info string.
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/

// A tab is 4 columns of indentation, per CommonMark. Anything else in the indent
// run is a space and counts 1.
const indentColumns = (s) => s.length + 3 * (s.split('\t').length - 1)

// The same marker AT THE LEFT MARGIN, for one job: bounding the front-matter
// closer search. A fence inside front matter can only be part of an indented
// YAML block scalar, so an indented marker must not end that search — the
// fenced sample that makes the bound necessary sits at column 0.
const FENCE_AT_MARGIN = /^(?:`{3,}|~{3,})/
const HEADING = /^\s*#{1,6}\s/
const TABLE_ROW = /^\s*\|/
const BLOCKQUOTE = /^\s*>/
const THEMATIC_BREAK = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const HTML_OPEN = /^\s*</

// Trailing punctuation that ends a thought. A short line that ends in one of
// these is a deliberate stop, not a wrap the author lost control of — clause
// (d). This is the rule that keeps the count at a readable size: it is what
// lets a hand-formatted run of short parenthetical lines end each of them and
// stay quiet.
const SENTENCE_TERMINAL = /[.:;!?]$/

/**
 * Classify every line of a Markdown file.
 *
 * `skip` lines are not scanned AND break the block around them; `break` lines
 * only break it; `item` starts a new block and is itself the first line of it,
 * because a bullet's own text is prose and its width is what the continuation
 * lines are ragged against; `text` continues the current block.
 *
 * FENCED CODE IS `skip`, NOT `break`. Read clause (a) literally — "broken by a
 * fence" — and the lines INSIDE a fence form blocks of their own and get
 * scanned, which measures 282 hits in 13 files on this tree against 14 with
 * them skipped: 85 from one data-flow diagram, 50 from an ASCII source tree, 34
 * from interface listings, 19 from wire transcripts. An indented listing is not
 * ragged prose and nobody can act on the report, so fenced contents are not
 * scanned at all. The two readings differ by 20x, which is the whole distance
 * between a signal and noise, so it is settled here rather than left to the
 * reader of the clause. Raised in review on #370 as a fourth load-bearing
 * exclusion; this is the "restate clause (a)" arm of that question.
 *
 * @param {string[]} lines
 * @returns {{ kind: 'skip' | 'break' | 'item' | 'text', why?: string }[]}
 */
export function classify(lines) {
  const out = []
  let inFence = false
  // The open fence's marker, so a closer is only honoured when it is a run of
  // the SAME character at least as long, carrying no info string and indented no
  // more than 3 columns past the opener — CommonMark's rule. Empty when no fence
  // is open, and `fenceIndent` is the opener's own indentation in columns, which
  // is what the fourth part is measured against.
  let fenceMarker = ''
  let fenceIndent = 0
  // YAML front matter: `---` on the very first line opens it, the next `---`
  // closes it. Every `name:`/`description:` key is a short line inside a block
  // whose longest line is a long `description:`, so front matter is a pure
  // false-positive generator — 14 of the 51 hits measured over every tracked
  // `.md` at this commit, all of them agent-instruction headers. Zero inside
  // these scan roots, because the roots already exclude those directories; the
  // content rule is what makes that independent of the root choice.
  // Only a CLOSING `---` makes the opener front matter. Without that, a file
  // opening with a thematic break — or one whose front matter is unterminated —
  // classifies `skip` to EOF and contributes nothing while still counting
  // towards `scannedCount`: silently unmeasured, indistinguishable from clean.
  let inFrontMatter = false
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    // ...and it has to arrive before the first fence AT THE LEFT MARGIN, so a
    // `---` inside a fenced YAML sample cannot stand in for it. The margin is
    // load-bearing, not tidiness: front matter legitimately holds a fence of its
    // own inside an indented `description: |` block scalar, and bounding on any
    // fence stopped the search there, refused real front matter and reported
    // `name:`/`description:` keys — the exact class this exclusion exists to
    // kill, back through a narrower door.
    for (let i = 1; i < lines.length; i++) {
      if (FENCE_AT_MARGIN.test(lines[i])) break
      if (lines[i].trim() === '---') {
        inFrontMatter = true
        break
      }
    }
  }
  // Raw HTML: BLOCK-SHAPED, per CommonMark's rule for an HTML block — it opens
  // on a line whose first non-space character is `<` and runs to the next blank
  // line. The alternative reading is line-shaped (`^\s*<` on each line on its
  // own); the two are pinned apart in the test, and on this tree they measure
  // the same number, because every line of README.md's badge table opens with a
  // tag. Block-shaped is the one written down because it is the one that stays
  // right when a `<td>` holds a run of plain text.
  let inHtml = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (inFrontMatter) {
      out.push({ kind: 'skip', why: 'front matter' })
      if (i > 0 && trimmed === '---') inFrontMatter = false
      continue
    }

    const fence = line.match(FENCE)
    // A closer is a run of the SAME character at least as long, NOTHING ELSE on
    // the line — CommonMark carries no info string on a closing fence, so a
    // marker that has one is content — and indented at most 3 columns past the
    // opener it is closing.
    if (
      fence &&
      (!inFence ||
        (fence[2][0] === fenceMarker[0] &&
          fence[2].length >= fenceMarker.length &&
          fence[3].trim() === '' &&
          indentColumns(fence[1]) <= fenceIndent + 3))
    ) {
      fenceMarker = inFence ? '' : fence[2]
      fenceIndent = inFence ? 0 : indentColumns(fence[1])
      inFence = !inFence
      inHtml = false
      out.push({ kind: 'skip', why: 'fence' })
      continue
    }
    // A fence marker that cannot close the open one falls through to here and
    // is classified as what it is: a line of fenced code.
    if (inFence) {
      out.push({ kind: 'skip', why: 'fenced code' })
      continue
    }

    if (trimmed === '') {
      inHtml = false
      out.push({ kind: 'break', why: 'blank line' })
      continue
    }
    if (inHtml) {
      out.push({ kind: 'skip', why: 'raw html' })
      continue
    }
    if (HTML_OPEN.test(line)) {
      inHtml = true
      out.push({ kind: 'skip', why: 'raw html' })
      continue
    }

    if (HEADING.test(line)) {
      out.push({ kind: 'break', why: 'heading' })
      continue
    }
    if (TABLE_ROW.test(line)) {
      out.push({ kind: 'break', why: 'table row' })
      continue
    }
    if (BLOCKQUOTE.test(line)) {
      out.push({ kind: 'break', why: 'blockquote' })
      continue
    }
    // Before the list-item test: `---` is a thematic break, and `- ` is a
    // bullet. Tested the other way round nothing changes today, but a `--- foo`
    // line would flip class silently.
    if (THEMATIC_BREAK.test(line)) {
      out.push({ kind: 'break', why: 'thematic break' })
      continue
    }
    if (LIST_ITEM.test(line)) {
      out.push({ kind: 'item' })
      continue
    }
    out.push({ kind: 'text' })
  }

  return out
}

/**
 * Split a classified file into blocks of scannable line indices.
 *
 * @param {{ kind: string }[]} kinds
 * @returns {number[][]}  zero-based line indices, one array per block
 */
export function blocksOf(kinds) {
  const blocks = []
  let current = []
  const flush = () => {
    if (current.length > 0) blocks.push(current)
    current = []
  }
  for (let i = 0; i < kinds.length; i++) {
    const { kind } = kinds[i]
    if (kind === 'skip' || kind === 'break') {
      flush()
    } else if (kind === 'item') {
      flush()
      current.push(i)
    } else {
      current.push(i)
    }
  }
  flush()
  return blocks
}

// Clause (e). The first whitespace-delimited token of a line — the next thing a
// greedy wrapper would have had to place. `trim()` first, so a continuation
// line's own indentation is not mistaken for an empty token.
const firstToken = (line) => line.trim().split(/\s+/)[0] ?? ''

/**
 * Ragged lines in one file.
 *
 * @param {string[]} lines
 * @param {number} deficit
 * @returns {{ line: number, len: number, blockMax: number, text: string }[]}
 */
export function raggedLines(lines, deficit = DEFICIT) {
  const kinds = classify(lines)
  const hits = []
  for (const block of blocksOf(kinds)) {
    if (block.length < 2) continue
    const blockMax = Math.max(...block.map((i) => lines[i].length))
    // Clause (b): every line but the last. A block's final line is short
    // because the paragraph ended there, which is the normal case and not a
    // defect — skipping it is what keeps every well-wrapped paragraph in the
    // tree silent.
    for (let b = 0; b < block.length - 1; b++) {
      const i = block[b]
      const len = lines[i].length
      if (blockMax - len < deficit) continue
      if (SENTENCE_TERMINAL.test(lines[i].trimEnd())) continue
      // Clause (e): could a greedy wrapper have appended the next token at all?
      // If `len + 1 + token > blockMax` the break was FORCED — every greedy
      // wrapper produces this shape — so the line is short for a mechanical
      // reason rather than a chosen one, and flagging it means flagging the
      // normal output of the tool everyone uses.
      //
      // CONTENT-FREE, and that is the whole of its defence. It knows nothing
      // about citations, URLs or backticks; it is wrapper arithmetic over two
      // lengths. The class it happens to catch on this tree is the unbreakable
      // backticked path, but the rule is not written against that class and
      // does not consult it. The rejected alternative — "the next line begins
      // with an opening parenthesis" — WAS written against these lines, and the
      // two come apart on docs/testing.md:50, which the parenthesis rule
      // pardons and this one leaves red at exactly blockMax-against-blockMax
      // because that break really was chosen.
      //
      // Added AFTER the population was measured, which the issue's Risks
      // section otherwise forbids. Recorded rather than waved through: the
      // prohibition is on moving a THRESHOLD until the number looks acceptable,
      // and this moves none — the deficit is still 20. It also cuts the count by
      // more than half, the direction that makes the gate look WORSE, which is
      // the opposite of the incentive the rule guards against.
      //
      // "The next line IN THE BLOCK" and "the next line in the file" are the
      // same line today, and provably so: every kind that is not `text` or
      // `item` flushes the block, and `item` starts a new one, so a block's
      // indices are contiguous. `block[b + 1]` is written because it is what the
      // clause means, not because it currently differs — measured, and a
      // fixture pinning the difference cannot be constructed. Clause (b) is
      // what stops this reading past the block's end.
      //
      // THE OTHER END OF THE SAME ARITHMETIC IS NOT FIXED BY THIS CLAUSE, and
      // saying so here is the point of this paragraph. `blockMax` is the
      // reference for (c) as well as for (e), and it is set by whatever the
      // longest line in the paragraph happens to be — including a line that is
      // long BECAUSE no wrapper could break it. So an unbreakable token is
      // pardoned at its own break point by (e) and then raises the bar for every
      // neighbour through (c): a six-line paragraph wrapped at 76-77 columns
      // around a 103-column link reports four hits, all four of them correctly
      // wrapped lines, and removing the link takes it to zero. A URL sitting
      // ALONE on its line reports three, not four — (e) then pardons the line
      // before it, and the fourth hit needs a short word ahead of the URL.
      // Latent rather than live: the widest block this loop examines is 88
      // columns on this tree and only two exceed 84. Blocks of one line run far
      // wider and are skipped by the guard above.
      //
      // LEFT ALONE DELIBERATELY. Teaching `blockMax` to ignore a line no wrapper
      // could have produced is a PREDICATE change, and the issue's Risks section
      // forbids moving the predicate once the count is known — the same rule
      // clause (e) is recorded against above. It is written down in
      // docs/testing.md under "What it over-reports" and the `rose` failure text
      // below names it, so an author who hits it is told not to rewrap. Changing
      // it belongs in its own issue with its own measurement.
      const next = block[b + 1]
      if (len + 1 + firstToken(lines[next]).length > blockMax) continue
      hits.push({ line: i + 1, len, blockMax, text: lines[i].trim() })
    }
  }
  return hits
}

// --- analysis -----------------------------------------------------------------

const underRoot = (p, roots) =>
  roots.some((r) => (r === '.' ? !p.includes('/') : p === r || p.startsWith(r + '/')))

const inScope = (p, roots) =>
  extname(p) === '.md' && basename(p) !== '' && (underRoot(p, roots) || SCAN_FILE_PATTERN.test(p))

/**
 * Same injectable-input seam as `analyze()` in scripts/check-line-citations.mjs:
 * the file list and the reader are arguments, so the test drives the predicate
 * over an in-memory corpus instead of the live tree. That is not a convenience.
 * The real tree's counts are this gate's own pin and move with every repair, so
 * an assertion written against a live line number is a test that #366 or #369
 * deletes — and docs/testing.md, the file that carries every interesting case,
 * is exactly the file both of them renumber.
 *
 * @param {object} opts
 * @param {string[]} opts.files        every tracked path, repo-relative
 * @param {(p: string) => string[]} opts.readLines
 * @param {string[]} [opts.scanRoots]
 * @param {string[]} [opts.excludedPaths]
 * @param {number} [opts.deficit]
 */
export function analyze({
  files,
  readLines,
  scanRoots = SCAN_ROOTS,
  excludedPaths = EXCLUDED_PATHS,
  deficit = DEFICIT
}) {
  const scanned = files.filter(
    (p) => inScope(p, scanRoots) && !excludedPaths.some((x) => p === x || p.startsWith(x))
  )

  const hits = []
  for (const p of scanned) {
    const lines = readLines(p)
    // Splitting a newline-terminated file on '\n' leaves a phantom empty
    // element past the last real line. Left in, it closes the final block one
    // line early and the last real line of the file stops being scannable.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    for (const h of raggedLines(lines, deficit)) hits.push({ path: p, ...h })
  }

  const byFile = new Map()
  for (const h of hits) byFile.set(h.path, (byFile.get(h.path) ?? 0) + 1)

  return { scannedCount: scanned.length, scanned, hits, byFile, deficit }
}

/**
 * @returns {{ ok: boolean, out: string[], err: string[] }}
 */
export function report(r, pins = {}) {
  const raggedPin = pins.ragged ?? RAGGED_PIN
  const out = []
  const err = []
  out.push(`check:prose-shape — scanned ${r.scannedCount} markdown files`)
  out.push(
    `  ragged lines: ${r.hits.length} in ${r.byFile.size} file(s) ` +
      `(deficit >= ${r.deficit ?? DEFICIT} columns) — pin ${raggedPin}`
  )
  for (const h of r.hits) {
    out.push(`  ${h.path}:${h.line}  ${h.len}/${h.blockMax}  ${h.text}`)
  }

  let ok = true

  if (r.hits.length !== raggedPin) {
    ok = false
    err.push(
      '',
      `Ragged-line count ${r.hits.length > raggedPin ? 'rose' : 'fell'}: ` +
        `${r.hits.length}, pinned at ${raggedPin}.`,
      ''
    )
    for (const h of r.hits) {
      err.push(`  ${h.path}:${h.line}  ${h.len}/${h.blockMax}  ${h.text}`)
    }
    if (r.hits.length > raggedPin) {
      err.push(
        '',
        'A line listed above is at least 20 columns shorter than the longest line',
        'in its own paragraph, does not end a sentence, and the next word in the',
        'paragraph would have fitted on it. Usually a wrapper did not produce that',
        'break, an edit did: rewrap the line you just wrote. The dump above is',
        'every hit and not just the new one, so narrow it with the per-file split',
        'in the RAGGED_PIN comment, or run this script on your base commit and',
        'diff the two lists.',
        '',
        'First check whether the longest line in that paragraph is one no wrapper',
        'could break — a bare URL or a long backticked path — because such a line',
        'raises the bar for every neighbour and the hits around it are not defects.',
        'See "What it over-reports" in docs/testing.md.',
        '',
        'Raise the pin only for a line that is genuinely meant to stop there, and',
        'say why in the commit message.'
      )
    } else {
      err.push(
        '',
        'If you rewrapped one of the pinned lines: lower the pin to match, which is',
        'the whole point of it being exact. Do NOT re-pin to whatever the tree now',
        'says without reading the list — the pin bounds a known blindness, and a',
        'number moved to clear a red measures nothing.'
      )
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

if (process.argv[1] && process.argv[1].endsWith('check-prose-shape.mjs')) main()
