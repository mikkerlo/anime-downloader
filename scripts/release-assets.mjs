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
//           files that came out of `artifacts/`. A short release must never be
//           published, so this is what the publish step is gated on.
//
// Both halves are exported over injectable seams so the tests drive them over
// in-memory data instead of the network.
//
// Run: node scripts/release-assets.mjs upload <tag> <dir>
//      node scripts/release-assets.mjs verify <tag> <dir>

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Five attempts with the backoff below spans roughly two and a half minutes per
// file. The observed failure hit one file ten seconds into a 13-way fan-out;
// anything that outlives this is not the transient class and should red the job
// rather than be retried further.
export const DEFAULT_ATTEMPTS = 5

export const backoffMs = (attempt) => Math.min(60_000, 5_000 * 2 ** (attempt - 1))

// --- upload -------------------------------------------------------------------

/**
 * Upload every file, one at a time, retrying each on its own.
 *
 * Deliberately never throws and never short-circuits. The whole defect being
 * fixed is that one asset's failure silently took four others with it, so a
 * file that exhausts its attempts is recorded and the next file still runs. The
 * caller decides what to do with `failed`.
 *
 * @param {object} opts
 * @param {string[]} opts.files                 paths to upload, in order
 * @param {(f: string, attempt: number) => Promise<void>} opts.uploadOne
 * @param {number} [opts.attempts]              tries per file, not per batch
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{uploaded: string[], failed: {file: string, tries: number, error: string}[]}>}
 */
export async function uploadAll({
  files,
  uploadOne,
  attempts = DEFAULT_ATTEMPTS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {}
}) {
  const uploaded = []
  const failed = []

  for (const file of files) {
    let lastError = 'unknown'
    let ok = false

    for (let attempt = 1; attempt <= attempts; attempt++) {
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
      log(`giving up on ${file} after ${attempts} attempts — ${lastError}`)
      failed.push({ file, tries: attempts, error: lastError })
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
    extra: attachedNames.filter((n) => !expectedSet.has(n))
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

  if (ok) out.push('OK — every artifact is attached')
  return { ok, out, err }
}

// --- CLI ----------------------------------------------------------------------

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const artifactNames = (dir) =>
  readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isFile())
    .sort()

function attachedAssets(tag) {
  return JSON.parse(gh(['release', 'view', tag, '--json', 'assets'])).assets.map((a) => a.name)
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
  const { ok, out, err } = report(
    analyze({ expected: artifactNames(dir), attached: attachedAssets(tag) })
  )
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
