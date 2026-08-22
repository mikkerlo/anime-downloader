import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// The resume-vs-room precedence rule (#240). `resumeFromSavedPosition` is an
// unexported `<script setup>` internal of a ~2.9k-line SFC wired to dozens of
// `window.api` channels and to WebGPU/MSE/JASSUB init, so there is no mount
// harness for it here — this scans the source, the same approach
// `player-toast-slot.test.ts` takes for the toast-slot gate and
// `test/ipc-channels.test.ts` takes for the channel table. The *behavior* the
// guard reads is covered for real at the composable seam, in
// `use-syncplay-client.test.ts` (`hasRemoteStateApplied` + the deferral block).
//
// What makes the scan non-vacuous: each assertion below is keyed to one edit
// that would reintroduce the bug — dropping the guard, moving it after the
// write, letting the toast survive it, or losing the `loadedmetadata` fan-out
// that applies the parked state in the first place.
const SOURCE = readFileSync(
  resolve(__dirname, '../../../src/renderer/src/components/views/PlayerView.vue'),
  'utf8'
)

const FLAT = SOURCE.replace(/\s+/g, ' ')

function resumeBody(): string {
  const start = SOURCE.indexOf('async function resumeFromSavedPosition')
  const end = SOURCE.indexOf('function maybeMarkPendingPrevWatched')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

// #262 widened this guard: the ffmpeg session may have been spawned at the
// room's position even though the session has since dropped, in which case the
// live predicate reads false while the playhead still lands where the room was.
const GUARD = 'if (roomOwnsPlayhead() || mkvSessionSeededFromRoom()) return;'

describe('PlayerView — remote state outranks the saved position (#240)', () => {
  it('guards the resume on a ready session with a remote state applied or pending', () => {
    // Both halves matter: `state === 'ready'` alone would eat the saved position
    // of a user alone in a room (main emits no `remote-state` for a self/absent
    // `setBy`), and `hasRemoteStateApplied()` alone would honor a room we are no
    // longer connected to.
    expect(resumeBody().replace(/\s+/g, ' ')).toContain(GUARD)
    expect(FLAT).toContain(
      "function roomOwnsPlayhead(): boolean { return syncplayStatus.value.state === 'ready' && syncplay.hasRemoteStateApplied(); }"
    )
  })

  it('cancels the MSE resume land through the same predicate', () => {
    // The MSE branch of `resumeFromSavedPosition` is toast-only — it deliberately
    // writes no `currentTime` (#198), so the guard above suppresses a toast and
    // nothing else on that path. The playhead is moved by `use-mse-player`'s
    // initial land instead, and without this dep it overwrites the room's
    // position on every local `.mkv` open with saved progress.
    expect(FLAT).toContain('hasRemoteStateApplied: () => roomOwnsPlayhead()')
  })

  it('places the guard after watchedReported and before the seek and both toasts', () => {
    const body = resumeBody().replace(/\s+/g, ' ')
    const guard = body.indexOf(GUARD)
    const watched = body.indexOf('watchedReported = !!saved.watched;')
    const write = body.indexOf('video.currentTime = saved.position;')
    const toasts = [...body.matchAll(/resumeToast\.value = `Resumed at/g)].map((m) => m.index!)

    expect(watched).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(-1)
    // Both branches set the toast — the MSE-MKV early return (#198) and the
    // direct-file/CDN write. The room's position wins on both, so neither may
    // announce a resume that did not happen.
    expect(toasts).toHaveLength(2)

    // The saved record still populates `watchedReported`; only the seek and its
    // toast are skipped.
    expect(guard).toBeGreaterThan(watched)
    expect(guard).toBeLessThan(write)
    toasts.forEach((t) => expect(guard).toBeLessThan(t))
  })

  it('fans loadedmetadata into the composable from the template', () => {
    // Without this the parked state is never applied at all: the composable owns
    // no element listeners, it is driven by PlayerView's bindings.
    expect(FLAT).toContain('@loadedmetadata="syncplay.onVideoLoadedMetadata"')
  })
})

// #262: the room outranks the saved position one layer earlier too — at the
// ffmpeg *spawn*, which happens before either guard above can run. The decision
// itself lives in `resolveMkvSpawnTarget` and is tested for real in
// `test/renderer/utils.test.ts`; these assertions pin the wiring that feeds it,
// each keyed to one edit that would silently restore the old behavior.
describe('PlayerView — the MKV spawn is seeded from the room (#262)', () => {
  function prepareBody(): string {
    const start = SOURCE.indexOf('async function prepareMkvForPlayback')
    const end = SOURCE.indexOf('async function prepareHevcTranscode')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return SOURCE.slice(start, end).replace(/\s+/g, ' ')
  }

  function transcodeBody(): string {
    const start = SOURCE.indexOf('async function prepareHevcTranscode')
    const end = SOURCE.indexOf('async function cancelHevcTranscode')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return SOURCE.slice(start, end).replace(/\s+/g, ' ')
  }

  it('reads the room position before spawning the session', () => {
    const body = prepareBody()
    const read = body.indexOf('window.api.syncplayGetRoomPosition(')
    const spawn = body.indexOf('window.api.playerRemuxMkvStream(filePath, initialSeek)')
    expect(read).toBeGreaterThan(-1)
    expect(spawn).toBeGreaterThan(-1)
    // Dropping the read, or letting it land after the spawn, is exactly the bug:
    // the position ffmpeg starts at is chosen at the spawn call.
    expect(read).toBeLessThan(spawn)
  })

  it('issues the room read concurrently with the saved-progress read', () => {
    // Sequential awaits put a second round trip in front of the spawn for no
    // freshness gain — main projects the position at reply time.
    const body = prepareBody()
    expect(body).toContain('const [saved, roomPosition] = await Promise.all([')
    expect(body).toContain('window.api.watchProgressGet(props.animeId, epInt)')
  })

  it('feeds both the spawn target and the resume target through the helper', () => {
    // `resumeTarget` is the MSE land target and the value handed to
    // `prepareHevcTranscode`; seeding only `initialSeek` from the room would
    // leave the land pulling the playhead back to the saved position.
    const body = prepareBody()
    expect(body).toContain('const target = resolveMkvSpawnTarget(saved, roomPosition);')
    expect(body).toContain('initialSeek = target.initialSeek;')
    expect(body).toContain('resumeTarget = target.resumeTarget;')
    expect(body).toContain('mkvSpawnFromRoom = target.fromRoom;')
  })

  it('does not let a failed room read cost the saved position', () => {
    // A shared catch around both reads would drop the saved record whenever the
    // syncplay channel rejects, silently resuming every MKV open at 0.
    expect(prepareBody()).toContain(
      'window.api.syncplayGetRoomPosition(syncplay.buildCanonicalName()).catch(() => null)'
    )
  })

  // #272 review: the read is scoped to the file being opened, not merely ordered
  // after the push that announced it. Without the argument the "belongs to the
  // current file" property rests on `useSyncplayClient`'s onMounted landing ahead
  // of PlayerView's — true today only by the two `getSetting` awaits in front of
  // this read, and a removed await inverts it silently. The name must come from
  // the composable's own builder, since a second spelling of it in PlayerView
  // would fail main's comparison on a difference nothing else tests.
  it('scopes the room read to the file it is opening', () => {
    expect(prepareBody()).toContain(
      'window.api.syncplayGetRoomPosition(syncplay.buildCanonicalName())'
    )
  })

  // #275/#295: the composable drops the resume land on main's refusal, but only
  // if it is handed main's answer. `StartMseSessionOpts.refusedSeek` is
  // required, so *not wiring it at all* is a compile error now — what survives
  // the build is wiring it to the wrong thing, a hardcoded `refusedSeek: false`
  // most obviously, which typechecks and silently restores the bug. That is the
  // failure this scan carries. Per call site: the copy path and the transcode path each wire
  // their own, and only one of them being right is exactly the "the two paths
  // disagree" bug. The two expectations cannot share one literal — the copy
  // body destructures the reply as `streamResult`, the transcode body as `r`.
  it('hands the composable main’s refusal decision, at both call sites', () => {
    expect(prepareBody()).toContain('refusedSeek: streamResult.refusedSeek')
    expect(transcodeBody()).toContain('refusedSeek: r.refusedSeek')
  })

  it('pairs the room-seeded flag with the live stream session', () => {
    // Otherwise a flag left true by an MKV open would suppress the resume of a
    // later direct-file or CDN open, which never consults the room.
    expect(FLAT).toContain(
      "function mkvSessionSeededFromRoom(): boolean { return mkvSpawnFromRoom && streamSessionId.value !== ''; }"
    )
  })
})

// #275 review: bounding the spawn also zeroes `mseInitialSeek`, so on a refused
// open `resumeFromSavedPosition` no longer takes its toast-only MSE branch
// (gated `mseInitialSeek.value > 0`) and falls through to the branch below it —
// the one that actually writes `video.currentTime = saved.position`. Writing the
// out-of-file saved position straight to the element is the original symptom
// arriving through a second door.
//
// It is inert today, but only via a two-step argument spanning two files, and
// neither step is local to this function.
//
// Step 2 — the room path — is already pinned above: `mkvSessionSeededFromRoom()`
// returns before either branch, and #240's "guard before both toasts" assertion
// subsumes "guard before the MSE branch", so every edit that breaks the ordering
// breaks that test first. Only step 1 is unguarded, and it is what this adds.
describe('PlayerView — a refused open does not resume through the generic branch (#275)', () => {
  it('keeps the write behind the fraction guard that a refused open fails', () => {
    // Step 1, the non-room path. A refused open means main bounded the spawn,
    // i.e. `saved.position - 1 >= duration` — so `saved.position / d` is above
    // 1 and this guard is false. Drop it, or widen it to a bare
    // `saved.position > 5`, and the refused position is written to the element.
    const body = resumeBody().replace(/\s+/g, ' ')

    // Containment rather than ordering: a write moved below the block's closing
    // brace is unconditional again and still satisfies `write > guard`.
    expect(body).toContain(
      'if (saved.position > 5 && saved.position / d < 0.95) { syncplay.markProgrammaticSeek(saved.position); video.currentTime = saved.position;'
    )
    // The other half of the argument above: the ratio is only against the
    // probe's duration if `d` prefers `video.duration`. Against `saved.duration`
    // alone, a stale record's ratio against its own inflated duration passes.
    expect(body).toContain('const d = video.duration || saved.duration;')
  })
})
