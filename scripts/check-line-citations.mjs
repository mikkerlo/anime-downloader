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
// Whether that line *means* what the prose says is not, so the gate is split
// into three unambiguous failures plus a heuristic that only warns — and two
// pinned counts, which are what give the warn teeth and what stop the gate
// from passing by seeing nothing. A printed-only number is the aggregate
// assertion docs/testing.md:97-101 warns about: nobody diffs it.
//
// Run: npm run check:line-citations

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

// --- pins ---------------------------------------------------------------------
//
// Exact-match assertions, per docs/testing.md:91 ("Pin the count, never just
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
// 11 ambiguous basenames + 70 pathless anchors on this tree.
export const UNCHECKABLE_PIN = 81

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

// --- analysis -----------------------------------------------------------------

/**
 * Classify the line a citation lands on. A range is classified by its START
 * LINE ONLY: three of this PR's repair targets are ranges whose last or
 * interior line is a brace or a comment (src/main/syncplay.ts:902-908,
 * src/main/syncplay.ts:862-870 and
 * src/renderer/src/composables/use-syncplay-client.ts:1491-1493), so
 * classifying by any line inside the range would put the repaired tree straight
 * back into the warn class and the repair could never go green.
 */
function suspiciousLanding(lines, targetPath, startLine) {
  const text = (lines[startLine - 1] ?? '').trim()
  // Blank is the one predicate that is decidable on prose, so `.md` is subject
  // to it rather than exempt (#344): no file deliberately cites the blank line
  // between two of its own paragraphs, and both stale docs anchors that
  // narrowing caught were landing on exactly that.
  if (text === '') return 'blank line'
  // The three predicates below cannot tell prose from prose the way the blank
  // test at scripts/check-line-citations.mjs:153 can, and they are not exempt
  // for the same reason — saying they are attributes one's evidence to the
  // others. The comment-line test at scripts/check-line-citations.mjs:175 is a
  // *measured* syntax collision with Markdown emphasis: of the 135 lines it
  // matches across the tracked `.md`, 102 are `**bold**` openers and 25 open
  // with a single `*` (17 emphasis, 8 bullets), leaving 8 comment-shaped — the
  // false positive is demonstrated on the very lines #344 repaired *to*
  // (docs/syncplay.md:238 and docs/syncplay.md:322 are both `**` openers), so
  // hoisting this return past it would red the gate on the repair itself. The
  // bare-brace test at scripts/check-line-citations.mjs:174 and the `<!--` test
  // at scripts/check-line-citations.mjs:180 have no measured false positive in
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
        if (why) suspicious.push({ at, cited, target, start, why })
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

  let ok = true

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
