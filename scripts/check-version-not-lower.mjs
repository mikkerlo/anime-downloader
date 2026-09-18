#!/usr/bin/env node
// CI gate: a PR may not carry a `package.json` version lower than its base
// branch's (#376).
//
// Nothing else stops it, and the consequence is worse than a gap in the release
// history. `release.yml`'s `check-version` job asks only whether the tag already
// exists on origin — a version *below* main has never been tagged, so it answers
// "release it". The publish step then runs `gh release edit "$TAG" --draft=false
// --latest`, and `--latest` is the API's `make_latest: true` rather than its
// `legacy` date-and-semver heuristic, so the lower version is marked Latest
// unconditionally. `electron-updater` reads the latest release, so main at
// 4.6.96 plus a merged PR carrying 4.6.94 offers 4.6.94 to everyone on an older
// build — who then stall there — and offers nothing at all to anyone already on
// 4.6.96. No error, no log line, nothing in CI.
//
// The invariant is one-sided on purpose. Only *strictly lower* fails:
//
//   - **Equal passes.** Docs-only and CI-only PRs legitimately do not bump, and
//     a gate that demanded a bump would be a gate that taught people to bump
//     without meaning it.
//   - **Gaps pass.** A queue of PRs holding reserved consecutive numbers against
//     an older main (#372/#374/#375 did exactly this) skips numbers whenever one
//     of them is dropped. That is fine; monotonic is the whole requirement.
//
// The comparison is numeric per component, not lexical. `4.6.9` vs `4.6.10` is
// the case a string compare gets backwards, and it is the case this repo hits
// every ten patches.
//
// Run: npm run check:version-not-lower
//   or: node scripts/check-version-not-lower.mjs <base-version> <head-version>
//
// With no arguments it reads the working tree's `package.json` as the head and
// fetches the base branch's from origin. With two, it compares them directly and
// touches neither git nor the network — which is how the four interesting cases
// get checked by hand without pushing a throwaway branch.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Deliberately strict: a plain `major.minor.patch` and nothing else. Every
// version this repo has ever shipped is one, `release.yml` cuts `v$VERSION` from
// the same field, and the one way a suffixed value could reach this gate is the
// `Set PR build version` step's `${VERSION}-pr${N}-<timestamp>` rewrite leaking
// out of the `build` job — where it belongs — into `quality`, where it would
// compare a prerelease string against a release one. Refusing to guess is the
// point: a first deliberate prerelease should extend this function with real
// semver prerelease ordering, not slip past it.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * @param {unknown} raw
 * @returns {[number, number, number] | null} the three components, or null if
 *   `raw` is not a bare `major.minor.patch`.
 */
export function parseVersion(raw) {
  const m = VERSION_RE.exec(typeof raw === 'string' ? raw.trim() : '')
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * Numeric ordering, component by component. Throws rather than returning a
 * sentinel on an unparseable input: every sentinel a caller could test with `<`
 * or `>` reads as "fine" when it isn't, which is the failure mode this whole
 * gate exists to prevent.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1} sign of (a - b)
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa) throw new TypeError(`Not a major.minor.patch version: ${JSON.stringify(a)}`)
  if (!pb) throw new TypeError(`Not a major.minor.patch version: ${JSON.stringify(b)}`)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

/**
 * The next patch after `version` — what a PR should take when it is the only one
 * in the queue. Named in the failure so the fix is a number to copy rather than
 * a rule to re-derive.
 *
 * @param {string} version
 * @returns {string}
 */
export function nextPatch(version) {
  const p = parseVersion(version)
  if (!p) throw new TypeError(`Not a major.minor.patch version: ${JSON.stringify(version)}`)
  return `${p[0]}.${p[1]}.${p[2] + 1}`
}

/**
 * @param {object} opts
 * @param {string} opts.base base branch's `package.json` version
 * @param {string} opts.head this PR's `package.json` version
 * @param {string} [opts.baseRef] base branch name, for the message
 * @returns {{ ok: boolean, out: string[], err: string[] }}
 */
export function check({ base, head, baseRef = 'main' }) {
  const out = []
  const err = []

  out.push(`Base (${baseRef}): ${base}`, `Head (this PR):  ${head}`)

  const unparseable = []
  if (!parseVersion(base)) unparseable.push(`${baseRef}: ${JSON.stringify(base)}`)
  if (!parseVersion(head)) unparseable.push(`this PR: ${JSON.stringify(head)}`)
  if (unparseable.length > 0) {
    err.push(
      '',
      'Version is not a bare major.minor.patch:',
      ...unparseable.map((u) => `  ${u}`),
      '',
      'This gate reads the version before any PR-build rewrite, so a suffixed',
      'value here means something rewrote package.json earlier in the job — or',
      'the project has started shipping prereleases, in which case teach',
      'compareVersions() real semver prerelease ordering rather than relaxing',
      'the pattern.'
    )
    return { ok: false, out, err }
  }

  const order = compareVersions(head, base)

  if (order < 0) {
    err.push(
      '',
      `Version ${head} is LOWER than ${baseRef}'s ${base}.`,
      '',
      `Merging this would publish v${head} as the latest release after v${base}`,
      'and walk the update feed backwards. release.yml releases any version whose',
      'tag does not exist yet — a lower one never had a tag — and publishes it',
      'with `gh release edit --latest`, which marks it Latest unconditionally.',
      `electron-updater then offers v${head} to everyone on an older build, who`,
      `stall there until the next bump, and offers nothing to anyone on v${base}.`,
      '',
      `Fix: bump package.json to at least ${nextPatch(base)}. If other PRs are`,
      'queued on reserved numbers, take the next one past theirs — see',
      'docs/build.md, "Version numbers and merge order".'
    )
    return { ok: false, out, err }
  }

  out.push(
    '',
    order === 0 ? `No bump in this PR; equal to ${baseRef}. OK` : `Ahead of ${baseRef}. OK`
  )
  return { ok: true, out, err }
}

// --- CLI ----------------------------------------------------------------------

/**
 * Names a git revision holding the base branch's tree, fetching it only if it
 * is not already here.
 *
 * In CI it never is: `actions/checkout` clones at depth 1 and fetches only the
 * PR ref, so `refs/remotes/origin/$GITHUB_BASE_REF` does not exist and
 * `origin/main` will not resolve. One shallow ref covers it — the comparison
 * needs the base's `package.json` blob, not its history — and `FETCH_HEAD`
 * names what a single-branch fetch just wrote without depending on a
 * remote-tracking ref appearing.
 *
 * The check is not there to save the fetch. `git fetch --depth=1` against a
 * *complete* clone truncates it — git writes `.git/shallow` and the repository
 * is shallow from then on — so a developer running this gate by hand in a
 * normal working clone would pay for it with their history. Preferring the
 * remote-tracking ref means the shallow fetch only ever runs where the clone is
 * already shallow and disposable. A local run therefore reads whatever the last
 * `jj git fetch` left in `origin/<base>`, which is the right trade: stale by a
 * few commits locally, exact in CI, and destructive nowhere.
 *
 * @param {string} baseRef
 * @returns {string} a revision `git show <rev>:package.json` accepts
 */
export function baseRevision(baseRef) {
  const tracking = `refs/remotes/origin/${baseRef}`
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', tracking], { stdio: 'ignore' })
    return tracking
  } catch {
    try {
      execFileSync('git', ['fetch', '--depth=1', 'origin', baseRef], { stdio: 'inherit' })
    } catch {
      console.error(
        `\nCould not read the base branch: ${tracking} is absent and fetching '${baseRef}' from origin failed.`
      )
      process.exit(1)
    }
    return 'FETCH_HEAD'
  }
}

/**
 * The base branch's declared version.
 *
 * `git show` is the other half of `baseRevision`'s failure: the revision can
 * resolve and still not carry a `package.json` — a base branch from before the
 * file existed, or a `FETCH_HEAD` pointing at something that is not this
 * project. Bare, that exits on an unhandled throw, and the node stack trace
 * through this function reads like the gate crashed rather than like the base
 * could not be read. Both halves fail closed; only one of them used to say why.
 *
 * @param {string} baseRef
 * @returns {string}
 */
export function baseVersionFromOrigin(baseRef) {
  const rev = baseRevision(baseRef)
  let json
  try {
    json = execFileSync('git', ['show', `${rev}:package.json`], { encoding: 'utf8' })
  } catch {
    console.error(`\nCould not read package.json from the base branch at ${rev}.`)
    process.exit(1)
  }
  return JSON.parse(json).version
}

function main() {
  const [argBase, argHead] = process.argv.slice(2)
  const baseRef = process.env.GITHUB_BASE_REF || 'main'

  const head = argHead ?? JSON.parse(readFileSync('package.json', 'utf8')).version
  const base = argBase ?? baseVersionFromOrigin(baseRef)

  const { ok, out, err } = check({ base, head, baseRef })
  console.log(out.join('\n'))
  if (err.length > 0) console.error(err.join('\n'))
  if (!ok) process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith('check-version-not-lower.mjs')) main()
