#!/usr/bin/env node
// Nightly gate for the upstream-Syncplay `.py` anchors (#395 step 2).
//
// `check:line-citations` bounds this population and cannot check it. A `.py`
// target is unresolvable by construction there — that rule is what lets ~260
// upstream anchors through with no filename allowlist to maintain — so
// `UNMARKED_PY_PIN` counts them, no landing predicate ever runs on one, and no
// line number is ever compared with anything. The ceiling states the blindness;
// it does not remove it. This removes it, against the one tree the anchors were
// written about.
//
// WHY NIGHTLY AND NOT `quality`. The check needs the upstream tree, and there
// are only two ways for `quality` to have it: vendor a copy into the repo, or
// fetch one during the gate. A vendored copy is four and a half thousand lines
// of someone else's source in the repo and a second thing to keep in step with
// the pin; a fetch puts the network on the PR gate's critical path, so a GitHub
// outage would red every pull request over a number inside a comment. The
// conformance workflow already provisions exactly this tree at exactly this
// commit, on a schedule where a four-minute install and a network dependency are
// already the deal — so the check runs there, beside the suite whose claims
// these anchors annotate. Its subject is an upstream project rather than this
// PR's diff, which is the argument `syncplay-conformance.yml` already makes for
// itself in its own header.
//
// WHY IT READS SITE-PACKAGES RATHER THAN FETCHING. By the time this runs the
// workflow has installed the pinned tree into the runner's venv, and that
// install is the artefact the conformance suite is actually believed against.
// Fetching a second copy would check the anchors against a tree the suite never
// ran on — two network round trips to compare two things that are supposed to be
// one object — and would pass quietly if the install and the fetch ever
// disagreed. Reading the install makes that divergence impossible rather than
// unlikely.
//
// WHY THE PIN COMES OUT OF THE WORKFLOW. The commit is written in four places —
// this workflow, `conformance/README.md`, `conformance/helpers/real-server.ts`
// and `docs/syncplay.md` — and `test/conformance-workflow.test.ts` asserts the
// four agree. One of them has to be the authority here, and it is the workflow:
// that is the line that decides what pip actually installed, so reading any of
// the other three would let this script attest an anchor against a commit the
// runner never had on disk. `direct_url.json` is then the installed tree's own
// account of where it came from, and `assertPinnedTree()` compares the two
// before a single anchor is looked at.
//
// NO CITATION-SHAPED LITERAL IN THIS FILE, which is why the allow-list below is
// spelled in parts and why the worked examples in the docstrings carry no line
// numbers. `scripts/` is in `check-line-citations.mjs`'s own `SCAN_ROOTS`, so a
// `server.py:NN` written here is counted by the very ceiling this check exists
// to retire, and an in-repo anchor written here is one more thing for that gate
// to drift-check. The same argument the `UNMARKED_PY_PIN` comment block makes
// for not repeating its own examples.
//
// Run: npm run check:upstream-citations
//   (locally: provision the venv per `conformance/README.md`, export
//   SYNCPLAY_SERVER_BIN, then run this)

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import { analyze, RESOLVABLE_EXT } from './check-line-citations.mjs'

// The path prefix every upstream file is registered under. It is a fiction —
// nothing is written into the repo — but it has to be a path `analyze()` can
// resolve a bare `server.py` anchor against by unique basename, and it has to
// sit outside `SCAN_ROOTS` so the upstream sources are resolution targets and
// are never themselves scanned for citations.
export const UPSTREAM_PREFIX = 'syncplay/'

// The workflow the pin is read from. See the header for why this one of the four
// places the commit is written.
export const WORKFLOW = '.github/workflows/syncplay-conformance.yml'

/**
 * A Python `def`/`class` boundary. Any indentation, hence the `.trim()` at the
 * call site: upstream's methods are indented one level inside their class, and a
 * predicate anchored at column 0 would see only module-level definitions — which
 * is almost none of what these anchors cite.
 */
export const DEF_OR_CLASS = /^(?:async\s+)?def\b|^class\b/

/**
 * The first `def`/`class` line strictly inside a cited range, or null. This is
 * the predicate #395 asks for: a range that crosses a definition boundary is
 * describing two things and naming one, which is what a range that slid down the
 * file looks like when every line it lands on is still live code — the class
 * every other predicate in these gates is blind to by construction.
 *
 * THE START LINE IS EXEMPT, and that is the whole difference between a usable
 * predicate and a useless one. Measured over the 165 ranged upstream anchors at
 * the pin: with the start line in scope it flags **97** of them — every anchor
 * that cites a function from its own signature, which is the normal and correct
 * way to cite a function. With the start line exempt it flags **0**, so it ships
 * against a clean tree and the first flag is news rather than noise. The
 * exemption mirrors `interiorBlankLine()`'s `start + 1` in
 * `scripts/check-line-citations.mjs`, for the same reason: a cited block's first
 * line is chosen deliberately, its interior is not.
 *
 * THE END LINE IS IN SCOPE, mirroring `interiorBlankLine()` again — a range
 * whose last line is the next function's `def` has run past its subject just as
 * surely as one with a `def` in the middle.
 *
 * FIRST HIT ONLY, so one citation contributes at most one finding however many
 * definitions it spans. The report counts anchors that look wrong, not lines.
 *
 * THE NAMED RESIDUAL, recorded as a decision rather than left to be
 * rediscovered: a range that ends on a DECORATOR line sitting immediately above
 * a `def` is deliberately NOT flagged. `protocols.py` has one such anchor — a
 * range that closes on the `@requireLogged` one line above `handleChat` — and
 * adding a `/^@/` arm costs **0** extra flags over the 165, so this is a free
 * choice rather than a tolerated cost. It stays out because it is not the
 * boundary the issue asks about, and because `@` opens a line continuation in
 * Python as well as a decorator, so the arm would be a second rule with its own
 * false-positive surface bought for nothing. If a decorated-boundary miss ever
 * costs something, that measurement is where to start.
 *
 * @param {string[]} lines     the upstream file
 * @param {number} startLine
 * @param {number | null} endLine  null for a single-line anchor, which cannot
 *   cross anything and returns null immediately
 * @returns {number | null}
 */
export function defClassBoundary(lines, startLine, endLine) {
  if (endLine === null) return null
  for (let n = startLine + 1; n <= endLine; n++) {
    if (DEF_OR_CLASS.test((lines[n - 1] ?? '').trim())) return n
  }
  return null
}

/**
 * Compose one allow-list entry from its parts.
 *
 * The parts are the point. Written as the `path:NN` literals they stand for,
 * this list would put an in-repo anchor and an upstream `.py` anchor into a
 * scanned file — see the header — so the strings are joined here and the entries
 * below carry numbers as numbers. The runtime shape is exactly the
 * `{ at, cited }` pair `findings()` compares against `analyze()`'s output.
 */
const landing = (atFile, atLine, citedFile, start, end) => ({
  at: `${atFile}:${atLine}`,
  cited: `${citedFile}:${start}-${end}`
})

/**
 * The upstream landings that are legitimate, named one by one.
 *
 * A NAMED ALLOW-LIST, NOT A COUNT, and that difference is the only thing this
 * constant buys. The one entry is `docs/syncplay.md` citing
 * `_allowTLSconnections()` whole: the citation means the function, and the blank
 * line the heuristic objects to is the intra-function gap between the three
 * `open()` calls and the `getmtime()` that follows them. Nothing about the
 * anchor is stale. It is the only upstream landing at the pin. Pinned as a count
 * — "one landing is expected" — a DIFFERENT anchor sliding onto a different
 * blank line would hold the count at one and pass; keyed on the citer AND the
 * anchor it reds, because the pair no longer matches. Both halves are needed:
 * the same citer repointed is a different claim, and the same anchor quoted
 * somewhere else is a different reader.
 *
 * THIS DOES NOT DUPLICATE `SUSPICIOUS_LANDING_PIN`, whose value is four, and the
 * two populations are disjoint by construction rather than by coincidence. That
 * pin counts landings on targets inside this repo, measured in the `quality`
 * run, where a `.py` target cannot resolve at all and so can never contribute to
 * it. This list is upstream landings only, measured in a run that has the
 * upstream tree on disk. Neither number can move the other, and folding them
 * would make one figure mean two things measured in two places.
 */
export const UPSTREAM_LANDING_ALLOW = [landing('docs/syncplay.md', 444, 'server.py', 251, 257)]

/**
 * The commit the conformance workflow actually installs.
 *
 * Throws rather than returning a default. A default here would be the one
 * failure this script cannot afford: it would attest every anchor against a
 * commit nobody installed, print a clean report and exit 0 — the "a gate that
 * skips is indistinguishable from a gate that passes" shape `driftBasePlan()`
 * exists to rule out on the other side of the same problem.
 *
 * @param {string} yaml
 * @returns {string}
 */
export function pinnedCommitFromWorkflow(yaml) {
  const m = /syncplay@([0-9a-f]{40})/.exec(yaml)
  if (!m) {
    throw new Error(
      `No pinned Syncplay commit in ${WORKFLOW}: expected a ` +
        '`git+https://github.com/Syncplay/syncplay@<40 hex>` install line. Without it ' +
        'there is no tree to measure the anchors against.'
    )
  }
  return m[1]
}

/**
 * Assert the installed tree is the pinned one.
 *
 * BOTH SHAS GO IN THE MESSAGE. The two ways this fires are "the workflow moved
 * its pin and the cache served the old install" and "the install is right and
 * the workflow edit is wrong", and from the outside they are the same failure: a
 * message naming only the expected sha tells the reader which number to trust
 * and not which number to change.
 *
 * A missing `commitId` throws too. `direct_url.json` carries no `vcs_info` for a
 * wheel or an sdist install, so a null here means the tree on disk is not a VCS
 * checkout at all and nothing can be said about which commit it is — which is a
 * failure, not a reason to proceed with the pin assumed.
 *
 * @param {{ commitId: string | null | undefined, expected: string }} opts
 */
export function assertPinnedTree({ commitId, expected }) {
  if (!commitId) {
    throw new Error(
      'The installed syncplay distribution records no source commit (no ' +
        '`vcs_info.commit_id` in its `direct_url.json`), so it cannot be compared with ' +
        `the pin ${expected} from ${WORKFLOW}. Install it from ` +
        '`git+https://github.com/Syncplay/syncplay@<sha>` the way `conformance/README.md` does.'
    )
  }
  if (commitId !== expected) {
    throw new Error(
      'Installed syncplay tree is not the pinned one:\n' +
        `  installed: ${commitId}\n` +
        `  pinned:    ${expected} (from ${WORKFLOW})\n` +
        'Every line number in this report is measured against the pinned tree, so a ' +
        'mismatch makes the whole report meaningless. Fix whichever of the two is wrong.'
    )
  }
}

const citedPath = (cited) => cited.replace(/:\d+(?:-\d+)?$/, '')

const isUpstream = (p) => typeof p === 'string' && p.startsWith(UPSTREAM_PREFIX)

/**
 * Classify an `analyze()` result into the four nightly classes, scoped to
 * upstream targets.
 *
 * PURE, and takes the `analyze()` result rather than running it, for the reason
 * every other decidable part of these gates is written this way: the whole
 * classification is then testable over a synthetic corpus, with no venv, no
 * network and no upstream tree. `readLines` is the same reader `analyze()` was
 * given.
 *
 * SCOPED TO `syncplay/` deliberately, even though the same result carries every
 * in-repo anchor as well. Those are the PR gate's subject and are checked there
 * on every pull request; re-reporting them here would file a nightly issue about
 * something a PR already redded, and the two runs' counts disagreeing would read
 * as news rather than as double counting.
 *
 * @param {object} opts
 * @param {ReturnType<typeof analyze>} opts.result
 * @param {(p: string) => string[]} opts.readLines
 * @param {{ at: string, cited: string }[]} [opts.allow]
 */
export function findings({ result, readLines, allow = UPSTREAM_LANDING_ALLOW }) {
  const cache = new Map()
  const linesOf = (p) => {
    if (!cache.has(p)) {
      const lines = readLines(p)
      // The same phantom-element pop `analyze()` does: splitting a
      // newline-terminated file on '\n' leaves an empty element past the last
      // real line, and a line count reported one too high in a report about line
      // numbers is its own small joke.
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      cache.set(p, lines)
    }
    return cache.get(p)
  }

  // An upstream anchor that does not resolve: a path no file in the installed
  // tree carries, or a line past EOF. Scoped on the CITED extension rather than
  // on a resolved target, because an unresolved anchor has no target to scope on.
  const unresolved = result.failures.filter((f) => extname(citedPath(f.cited)) === '.py')

  const anchors = result.resolved.filter((a) => isUpstream(a.target))

  const crossings = []
  for (const a of anchors) {
    const boundary = defClassBoundary(linesOf(a.target), a.start, a.end)
    if (boundary === null) continue
    crossings.push({
      at: a.at,
      cited: a.cited,
      target: a.target,
      boundary,
      text: (linesOf(a.target)[boundary - 1] ?? '').trim()
    })
  }

  const allowed = (s) => allow.some((e) => e.at === s.at && e.cited === s.cited)
  const allLandings = result.suspicious.filter((s) => isUpstream(s.target))
  const landings = allLandings.filter((s) => !allowed(s))
  const exempt = allLandings.filter(allowed)

  // The marked form's CONTENT check, which `quality` can only run on the form.
  // Off the tree `analyze()` takes its foreign-extension `continue` before
  // `verifyQuote()` ever sees a `.py` anchor, so a marked upstream anchor reads
  // as checkable and is compared with nothing; here the target is on disk and the
  // comparison actually happens. The population is empty at the pin, which is
  // exactly why `check-line-citations.mjs` prints that counter at zero rather
  // than omitting it: this is the check that makes marking one worth anything.
  const quoteRot = result.quoteFailures.filter((q) => isUpstream(q.target))

  return {
    unresolved,
    crossings,
    landings,
    exempt,
    quoteRot,
    counts: {
      anchors: anchors.length,
      ranged: anchors.filter((a) => a.end !== null).length,
      unresolved: unresolved.length,
      crossings: crossings.length,
      landings: landings.length,
      exempt: exempt.length,
      quoteRot: quoteRot.length
    }
  }
}

/**
 * The issue body, as Markdown.
 *
 * EVERY FINDING CARRIES FOUR THINGS, and the shape is deliberate rather than
 * tidy: the citer, as `path:line`, so the reader can open the comment that is
 * wrong; the anchor, so they can see what it claims; the PREDICATE BY NAME, so
 * they can read the rule rather than infer it from one example; and the PIN it
 * was measured against, so a figure copied out of a six-week-old nightly cannot
 * be mistaken for a figure about today's upstream. A nightly issue is read by
 * someone with none of this context loaded and possibly without a checkout, and
 * dropping any one of the four turns the issue into a reason to go and re-derive
 * the whole thing by hand.
 *
 * The target line counts are there for the same reason: "names line 884 of a
 * file with 919 lines" is checkable from the issue alone, and most of the ways
 * this report could be wrong show up first as a line count that disagrees with
 * the reader's memory of the pin.
 *
 * @param {ReturnType<typeof findings>} f
 * @param {{ commitId: string, runUrl?: string | null, lineCounts?: Record<string, number> }} opts
 * @returns {string}
 */
export function issueBody(f, { commitId, runUrl = null, lineCounts = {} }) {
  const total = f.counts.unresolved + f.counts.crossings + f.counts.landings + f.counts.quoteRot
  const pin = `measured against \`${commitId}\``
  const out = []

  out.push(
    total > 0
      ? 'The nightly upstream-citation check found anchors that do not match the pinned'
      : 'The nightly upstream-citation check found nothing: every anchor below matches the',
    total > 0 ? 'Syncplay tree.' : 'pinned Syncplay tree.',
    '',
    `- Pinned commit: \`${commitId}\` (from \`${WORKFLOW}\`, confirmed against the`,
    "  installed distribution's `direct_url.json`)",
    `- Upstream anchors examined: ${f.counts.anchors}, of which ${f.counts.ranged} are ranged`,
    `- Findings: ${total} (${f.counts.unresolved} unresolved, ${f.counts.crossings} boundary` +
      ` crossings, ${f.counts.landings} suspicious landings, ${f.counts.quoteRot} quote rot)`
  )
  if (runUrl) out.push(`- Run: ${runUrl}`)
  out.push('')

  const section = (title, rows) => {
    if (rows.length === 0) return
    out.push(`## ${title} (${rows.length})`, '')
    for (const r of rows) out.push(`- ${r}`)
    out.push('')
  }

  section(
    'Anchors that do not resolve against the pinned tree',
    f.unresolved.map(
      (u) =>
        `\`${u.at}\` cites \`${u.cited}\` — ${u.why} — predicate \`analyze()\` resolver — ${pin}`
    )
  )
  section(
    'Ranges that cross a `def`/`class` boundary',
    f.crossings.map(
      (c) =>
        `\`${c.at}\` cites \`${c.cited}\` — crosses \`${c.text}\` at line ${c.boundary} of ` +
        `\`${c.target}\` — predicate \`defClassBoundary()\` — ${pin}`
    )
  )
  section(
    'Suspicious landings on an upstream line',
    f.landings.map(
      (s) =>
        `\`${s.at}\` cites \`${s.cited}\` — lands on a ${s.why} at line ${s.start} of ` +
        `\`${s.target}\` — predicate \`suspiciousLanding()\` / \`interiorBlankLine()\` — ${pin}`
    )
  )
  section(
    'Marked anchors whose quote is no longer at the cited line',
    f.quoteRot.map(
      (q) =>
        `\`${q.at}\` cites \`${q.cited}\` quoting "${q.quote}" — ` +
        (q.elsewhere.length === 0
          ? `that text is nowhere in \`${q.target}\``
          : `it is at line(s) ${q.elsewhere.join(', ')} of \`${q.target}\``) +
        ` — predicate \`verifyQuote()\` — ${pin}`
    )
  )
  section(
    'Allow-listed, not a finding',
    f.exempt.map(
      (s) =>
        `\`${s.at}\` cites \`${s.cited}\` — lands on a ${s.why} at line ${s.start} of ` +
        `\`${s.target}\`, named in \`UPSTREAM_LANDING_ALLOW\` — ${pin}`
    )
  )

  const counted = Object.keys(lineCounts).sort()
  if (counted.length > 0) {
    out.push('## Target line counts at the pin', '')
    for (const p of counted) out.push(`- \`${p}\` — ${lineCounts[p]} lines`)
    out.push('')
  }

  out.push(
    '## Reproduce locally',
    '',
    'Provision the pinned venv exactly as `conformance/README.md` says, export',
    '`SYNCPLAY_SERVER_BIN` at its `bin/syncplay-server`, then run',
    '`npm run check:upstream-citations`. Every figure above is ' + pin + ', so a run',
    'against any other tree is a different report.',
    ''
  )

  return out.join('\n')
}

// --- CLI ----------------------------------------------------------------------

/**
 * The Python interpreter that can import the pinned distribution.
 *
 * Derived from `SYNCPLAY_SERVER_BIN`'s directory rather than from a variable of
 * its own: the workflow and `conformance/README.md` already agree on that one
 * name, and a second would be one more thing to keep in step with the
 * provisioning line. The venv's `bin/syncplay-server` sits beside its
 * `bin/python`.
 *
 * @returns {{ python: string, why: string }}
 */
function venvPython() {
  const bin = process.env.SYNCPLAY_SERVER_BIN
  if (bin) return { python: join(dirname(bin), 'python'), why: `the venv beside ${bin}` }
  return { python: 'python3', why: 'SYNCPLAY_SERVER_BIN unset, so `python3` on PATH' }
}

/**
 * Where the installed `syncplay` package lives, and which commit it came from.
 *
 * FAILS LOUDLY AND NEVER SKIPS. Everything here is a claim about one specific
 * tree, so a run that cannot find that tree has nothing to say and must not say
 * "OK" — the failure mode `conformance/README.md` already records for
 * `SYNCPLAY_SERVER_BIN` itself ("it **throws**. It does not skip. A conformance
 * suite that quietly passes because it never ran is the failure mode this
 * directory exists to rule out"). Same rule, same reason, one layer up: with no
 * venv and no `SYNCPLAY_SERVER_BIN`, this throws with the provisioning line
 * rather than printing an empty report.
 */
function locateUpstream() {
  const { python, why } = venvPython()
  const probe =
    'import importlib.metadata as m, os, syncplay\n' +
    'print(os.path.dirname(syncplay.__file__))\n' +
    "print(m.distribution('syncplay').read_text('direct_url.json') or '')\n"
  let raw
  try {
    raw = execFileSync(python, ['-c', probe], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (e) {
    const detail = String(e.stderr || e.message || '').trim()
    throw new Error(
      `Cannot read the installed Syncplay tree with \`${python}\` (${why}).\n` +
        `${detail}\n\n` +
        'This check is a claim about one pinned upstream tree, so it has nothing to say\n' +
        'without that tree on disk — it fails rather than skipping, because a skip here\n' +
        'is indistinguishable from a pass. Provision the venv as `conformance/README.md`\n' +
        'describes and export SYNCPLAY_SERVER_BIN at its `bin/syncplay-server`.'
    )
  }
  const [dir, ...rest] = raw.split('\n')
  let commitId = null
  try {
    commitId = JSON.parse(rest.join('\n').trim())?.vcs_info?.commit_id ?? null
  } catch {
    commitId = null
  }
  return { dir, commitId }
}

/** Every `.py` file under the installed package, registered as `syncplay/<relpath>`. */
function upstreamFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (extname(e.name) === '.py') {
        out.push(UPSTREAM_PREFIX + relative(dir, p).split(sep).join('/'))
      }
    }
  }
  walk(dir)
  return out
}

function main() {
  const { dir, commitId } = locateUpstream()
  assertPinnedTree({
    commitId,
    expected: pinnedCommitFromWorkflow(readFileSync(WORKFLOW, 'utf8'))
  })

  const repoFiles = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
    .split('\0')
    .filter(Boolean)

  const readLines = (p) =>
    isUpstream(p)
      ? readFileSync(join(dir, p.slice(UPSTREAM_PREFIX.length)), 'utf8').split('\n')
      : readFileSync(p, 'utf8').split('\n')

  // `readBaseLines` omitted on purpose: drift against a pull request's base is
  // the `quality` gate's job and there is no base here — a nightly run compares
  // one tree against one upstream commit, not two revisions of this repo.
  const result = analyze({
    files: [...repoFiles, ...upstreamFiles(dir)],
    readLines,
    resolvableExt: new Set([...RESOLVABLE_EXT, '.py'])
  })

  const f = findings({ result, readLines })

  const lineCounts = {}
  for (const a of result.resolved) {
    if (!isUpstream(a.target) || lineCounts[a.target] !== undefined) continue
    const lines = readLines(a.target)
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    lineCounts[a.target] = lines.length
  }

  console.log(issueBody(f, { commitId, runUrl: process.env.RUN_URL || null, lineCounts }))

  const total = f.counts.unresolved + f.counts.crossings + f.counts.landings + f.counts.quoteRot
  if (total > 0) process.exit(1)
}

if (process.argv[1]?.endsWith('check-upstream-citations.mjs')) main()
