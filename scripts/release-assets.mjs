#!/usr/bin/env node
// Upload + completeness gate for the release job (#365, #373).
//
// Two releases were lost the same way. `softprops/action-gh-release` fires every
// file at GitHub at once — 13 concurrent uploads on v4.6.93 — and when one large
// binary came back `Error saving asset` about ten seconds in, the four other
// large binaries still in flight were abandoned with no log line at all. Eight
// small files had already landed. The action creates every non-prerelease as a
// draft and flips `draft: false` only after every artifact uploads, so the
// failure left a draft release carrying the eight small files and none of the
// five ~100-140 MB binaries, and nothing published.
//
// The collision theory (a retried upload colliding with its own half-written
// asset) was tested and does not hold: the step already ran with
// `overwrite_files: true`, the v4.6.93 failure was attempt 1 against a release
// that had no assets yet, and on the v4.6.92 attempt 2 — where duplicates
// genuinely did exist — every duplicate small asset re-uploaded in under a
// second. A collision is handled by the action explicitly; it cannot surface as
// `Error saving asset`.
//
// So this script does two things the action did not:
//
//   upload  one `gh release upload` per file, each with its own bounded retry.
//           One file's 5xx neither aborts the others nor ends the step — every
//           file gets its attempts, and the failures are reported together.
//   verify  compare the asset set actually attached to the release against the
//           files that came out of `artifacts/`, and require the three
//           `electron-updater` feeds to be among them. Everything that arrived
//           has to be attached, and all three legs have to have arrived, so
//           this is what the publish step is gated on.
//
// Both halves are exported over injectable seams so the tests drive them over
// in-memory data instead of the network.
//
// Run: node scripts/release-assets.mjs upload <tag> <dir>
//      node scripts/release-assets.mjs verify <tag> <dir>

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Five attempts with the backoff below spans roughly two and a half minutes per
// file. The observed failure hit one file ten seconds into a 13-way fan-out;
// anything that outlives this is not the transient class and should red the job
// rather than be retried further.
export const DEFAULT_ATTEMPTS = 5

export const backoffMs = (attempt) => Math.min(60_000, 5_000 * 2 ** (attempt - 1))

// Bounded per call, not just per batch: the retry loop only covers uploads that
// come back. A hung PUT has no bound of its own, and since the uploads are now
// serialised, one of them holds up every file behind it. 15 min is well past the
// slowest upload seen here (~11 min for the 138 MB AppImage).
export const GH_CALL_TIMEOUT_MS = 15 * 60_000

// The attempt count bounds errors that return; this bounds the ones that don't.
// Five attempts at the per-call timeout is 75 min for a single file, and the
// `release` job is capped at 45 min (`timeout-minutes`), so without this a
// genuinely hung upload would be killed by the runner mid-retry and the script
// would never print which file it was stuck on. Under this budget a hang gives
// up and reports itself through `failed` instead.
//
// What the budget does not do is bound when the batch *ends*. `outOfTime(0)` is
// `elapsed() >= budgetMs`, so it decides only whether a call may *start*: one
// started at 19:59 still gets its full GH_CALL_TIMEOUT_MS, and the worst case
// before `uploadAll` can return and name the file is 20 + 15 = 35 min. Only for
// a single hung file does the report land near one timeout in; two of them, or
// one starting late, run to that sum. It is 35 min — not the budget on its own —
// plus checkout, setup-node and the ~700 MB `download-artifact` that the job's
// `timeout-minutes` has to contain, which is what sizes it at 45 rather than 30.
//
// What has to hold is that a healthy run never reaches it, and the figure that
// decides that is cumulative upload time, not retry cost. The whole set is
// ~722 MB across 13 files; the slowest throughput actually observed here is the
// real failing run's ~1 MB/s, which puts a complete healthy release at ~11 min.
// That is what the 20 min is sized against — the retries this script exists for
// are ~2.5 min per file on top and are not what would breach it. Nothing is
// refused before the budget is genuinely spent, either (see `outOfTime`), so a
// run slower still keeps uploading until 20 min have actually elapsed, by which
// point one more full-length call would put the job's own 45 min cap in reach,
// and giving up with a named file beats being killed without one.
export const DEFAULT_BUDGET_MS = 20 * 60_000

// The `electron-updater` feeds, one per platform. See `report()` for why their
// absence is a failure in its own right.
export const REQUIRED_FEEDS = ['latest-linux.yml', 'latest-mac.yml', 'latest.yml']

// --- upload -------------------------------------------------------------------

/**
 * Upload every file, one at a time, retrying each on its own.
 *
 * Deliberately never throws and never short-circuits. The whole defect being
 * fixed is that one asset's failure silently took four others with it, so a
 * file that exhausts its attempts — or the batch's time budget — is recorded and
 * the next file still runs. The caller decides what to do with `failed`.
 *
 * @param {object} opts
 * @param {string[]} opts.files                 paths to upload, in order
 * @param {(f: string, attempt: number) => Promise<void>} opts.uploadOne
 * @param {number} [opts.attempts]              tries per file, not per batch
 * @param {number} [opts.budgetMs]              wall-clock ceiling for the batch
 * @param {number} [opts.callMs]                what one attempt may cost
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{uploaded: string[], failed: {file: string, tries: number, error: string}[]}>}
 */
export async function uploadAll({
  files,
  uploadOne,
  attempts = DEFAULT_ATTEMPTS,
  budgetMs = DEFAULT_BUDGET_MS,
  callMs = GH_CALL_TIMEOUT_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {}
}) {
  const uploaded = []
  const failed = []
  const startedAt = now()
  const elapsed = () => now() - startedAt

  // The two cases are not symmetric, and one guard for both is what made this
  // wrong the first time round. Refusing to start a file guarantees that file
  // is missing from the release; starting it only risks the job's 45 min
  // backstop, which exists precisely to catch that. So a file's first attempt
  // is optimistic — it runs unless the budget is genuinely spent — and only a
  // retry asks the conservative question, because a file being retried has
  // already demonstrated it is misbehaving and has already burned a call.
  //
  // The conservative form applied to first attempts reduces to `elapsed > 5
  // min` at the defaults (20 min budget, 15 min call), so a healthy release
  // slower than ~2 MB/s had most of its files refused untried. The real
  // failing run moved 722 MB at about 1 MB/s.
  const outOfTime = (tries) => (tries === 0 ? elapsed() >= budgetMs : elapsed() + callMs > budgetMs)

  for (const file of files) {
    let lastError = 'unknown'
    let ok = false
    let tries = 0

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (outOfTime(tries)) {
        const budget = `no time left in the ${Math.round(budgetMs / 60_000)} min upload budget`
        // Keep the reason this file was already failing; the budget is why it
        // stopped being retried, not why it failed.
        lastError = tries === 0 ? budget : `${lastError} (${budget} to retry)`
        break
      }
      tries = attempt
      try {
        await uploadOne(file, attempt)
        log(`uploaded ${file}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
        ok = true
        break
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        if (attempt < attempts) {
          const wait = backoffMs(attempt)
          log(`attempt ${attempt} of ${attempts} failed for ${file} — ${lastError}`)
          log(`retrying in ${Math.round(wait / 1000)}s`)
          await sleep(wait)
        }
      }
    }

    if (ok) uploaded.push(file)
    else {
      log(`giving up on ${file} after ${tries} attempt(s) — ${lastError}`)
      failed.push({ file, tries, error: lastError })
    }
  }

  return { uploaded, failed }
}

// --- verify -------------------------------------------------------------------

/**
 * Compare what the release carries against what the build produced.
 *
 * @param {object} opts
 * @param {string[]} opts.expected   file names out of `artifacts/`
 * @param {string[]} opts.attached   asset names on the release
 */
export function analyze({ expected, attached }) {
  const expectedNames = [...new Set(expected)].sort()
  const attachedNames = [...new Set(attached)].sort()
  const attachedSet = new Set(attachedNames)
  const expectedSet = new Set(expectedNames)

  return {
    expected: expectedNames,
    attached: attachedNames,
    missing: expectedNames.filter((n) => !attachedSet.has(n)),
    extra: attachedNames.filter((n) => !expectedSet.has(n)),
    missingFeeds: REQUIRED_FEEDS.filter((n) => !expectedSet.has(n))
  }
}

/**
 * An extra asset is a failure, not a warning. The release job is the only thing
 * that should ever write into this draft, so a name on the release that is not
 * in `artifacts/` means something else did — a build job that published into it
 * (which is why `Package` now passes `--publish never`), or a leftover from an
 * attempt at a different version. A re-run of the same version cannot land here:
 * the names are identical and `--clobber` replaces them in place. Shipping a
 * release carrying a binary nobody can account for is worse than failing the
 * job, so this reds.
 *
 * An empty expected set reds too. Zero artifacts means the download produced
 * nothing, and an empty release that publishes is the worst outcome available:
 * it looks like a shipped version and offers `electron-updater` nothing.
 *
 * A missing `electron-updater` feed reds as well, and that one is not a
 * comparison — it is a floor under the comparison. `missing` and `extra` are
 * both computed against whatever `download-artifact` happened to put in
 * `artifacts/`, so they answer "is everything that arrived attached?", not "is
 * the release complete". `upload-artifact` runs with `if-no-files-found:
 * ignore`, so a matrix leg whose `dist/` globs stop matching uploads nothing,
 * the release job downloads nothing for that platform, and a release with no
 * Windows binaries in it compares clean. The three feeds are one per platform
 * and are produced unconditionally by a leg that ran, so requiring them in the
 * expected set is a check on the build matrix that does not depend on the
 * download. A release missing one silently 404s the update check for every user
 * on that platform. It is skipped when nothing arrived at all — that case has
 * its own message above, and listing all three feeds under it would bury the
 * sentence that explains why.
 *
 * @returns {{ ok: boolean, out: string[], err: string[] }}
 */
export function report(r) {
  const out = []
  const err = []
  let ok = true

  out.push(`release assets — ${r.expected.length} expected, ${r.attached.length} attached`)

  if (r.expected.length === 0) {
    ok = false
    err.push(
      '',
      'No artifacts were found to release.',
      'The build matrix produced nothing to attach, so there is nothing to publish.'
    )
  }

  if (r.expected.length > 0 && r.missingFeeds?.length > 0) {
    ok = false
    err.push('', `${r.missingFeeds.length} electron-updater feed(s) never reached the release:`, '')
    for (const n of r.missingFeeds) err.push(`  ${n}`)
    err.push(
      '',
      'Each feed is produced by one platform leg of the build matrix, so a feed',
      'that is not in artifacts/ means that leg produced no output at all — the',
      'other files from it are missing too, and nothing above can see that,',
      'because the comparison only covers what was downloaded.',
      'Publishing anyway would 404 the update check for every user on that',
      'platform. Check the build job for that platform and its dist/ globs.'
    )
  }

  if (r.missing.length > 0) {
    ok = false
    err.push('', `${r.missing.length} artifact(s) never attached to the release:`, '')
    for (const n of r.missing) err.push(`  ${n}`)
    err.push(
      '',
      'The release is still a draft and has NOT been published — a short release is',
      'worse than no release, because it looks complete to anyone who finds it.',
      'Re-run the job: the draft is reused and the upload step retries each file.'
    )
  }

  if (r.extra.length > 0) {
    ok = false
    err.push('', `${r.extra.length} asset(s) on the release did not come from this build:`, '')
    for (const n of r.extra) err.push(`  ${n}`)
    err.push(
      '',
      'Something other than this job wrote into the draft. Check that every',
      'electron-builder invocation passes `--publish never`, and delete the stray',
      'assets before publishing.'
    )
  }

  if (ok) out.push('OK — every artifact is attached, and all three updater feeds are here')
  return { ok, out, err }
}

// --- CLI ----------------------------------------------------------------------

const gh = (args) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GH_CALL_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  })

// A missing directory is the zero-artifact case, not a crash: `download-artifact`
// creates nothing when there is nothing to download, and `report()` has a much
// better message for an empty set than an ENOENT stack does.
export const artifactNames = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => statSync(join(dir, n)).isFile())
        .sort()
    : []

// Name *and* state: GitHub creates the asset record before the bytes land, so a
// half-written asset carries the right name. Anything not `uploaded` counts as
// missing, which is what `--clobber` will replace on the next attempt anyway.
export function attachedAssets(tag, run = gh) {
  const { assets } = JSON.parse(run(['release', 'view', tag, '--json', 'assets']))
  return assets.filter((a) => a.state === 'uploaded').map((a) => a.name)
}

async function runUpload(tag, dir) {
  const names = artifactNames(dir)
  console.log(`uploading ${names.length} artifact(s) to ${tag}, one at a time`)

  const { uploaded, failed } = await uploadAll({
    files: names,
    log: (line) => console.log(line),
    uploadOne: async (name) => {
      gh(['release', 'upload', tag, join(dir, name), '--clobber'])
    }
  })

  console.log(`${uploaded.length} uploaded, ${failed.length} failed`)
  // Deliberately exit 0 even with failures. `verify` is the gate, and letting it
  // run produces one authoritative list of what is missing rather than two
  // partly-overlapping ones. The job still reds, one step later.
  for (const f of failed) console.log(`::warning::${f.file} did not upload — ${f.error}`)
}

function runVerify(tag, dir) {
  const expected = artifactNames(dir)
  // Nothing to compare against, so don't ask GitHub. The run is already lost,
  // and a failed `gh release view` on top of it would replace the one message
  // that explains why with a `Command failed` stack.
  const attached = expected.length > 0 ? attachedAssets(tag) : []
  const { ok, out, err } = report(analyze({ expected, attached }))
  console.log(out.join('\n'))
  if (err.length > 0) console.error(err.join('\n'))
  if (!ok) process.exit(1)
}

async function main() {
  const [mode, tag, dir] = process.argv.slice(2)
  if (!tag || !dir || (mode !== 'upload' && mode !== 'verify')) {
    console.error('usage: release-assets.mjs <upload|verify> <tag> <dir>')
    process.exit(2)
  }
  if (mode === 'upload') await runUpload(tag, dir)
  else runVerify(tag, dir)
}

if (process.argv[1] && process.argv[1].endsWith('release-assets.mjs')) await main()
