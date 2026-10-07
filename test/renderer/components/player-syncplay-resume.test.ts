// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { transformSync } from 'esbuild'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useSyncplayClient } from '../../../src/renderer/src/composables/use-syncplay-client'
import { resolveMkvSpawnTarget } from '../../../src/renderer/src/utils'

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
    // longer connected to. The `roomOwnsOpen()` term is #497's, and its own
    // `ready` half is pinned by the counter-pins in the #497 block below.
    expect(resumeBody().replace(/\s+/g, ' ')).toContain(GUARD)
    expect(FLAT).toContain(
      "function roomOwnsPlayhead(): boolean { return ( (syncplayStatus.value.state === 'ready' && syncplay.hasRemoteStateApplied()) || roomOwnsOpen() ); }"
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
    // The seek is the `seekProgrammatically` helper call since #306 Phase B —
    // it registers the operation and performs the write together, so there is
    // one thing to order the guard against instead of two.
    const write = body.indexOf('seekProgrammatically(video, saved.position);')
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
    // The room position is substituted only for an open the room owns (#497).
    expect(body).toContain(
      'const target = resolveMkvSpawnTarget( saved, roomOwnsOpen() ? (roomPosition ?? 0) : roomPosition );'
    )
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
  // failure this scan carries. Per call site: the copy path and the transcode
  // path each wire their own, and only one of them being right is exactly the
  // "the two paths disagree" bug. The two expectations cannot share one literal
  // — the copy body destructures the reply as `streamResult`, the transcode
  // body as `r`.
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
// the one that actually writes `saved.position` to the element, through
// `seekProgrammatically`. Writing the out-of-file saved position straight to the
// element is the original symptom arriving through a second door.
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
      'if (saved.position > 5 && saved.position / d < 0.95) { seekProgrammatically(video, saved.position);'
    )
    // The other half of the argument above: the ratio is only against the
    // probe's duration if `d` prefers `video.duration`. Against `saved.duration`
    // alone, a stale record's ratio against its own inflated duration passes.
    expect(body).toContain('const d = video.duration || saved.duration;')
  })
})

// Which `.play()` calls in this file are programmatic, and with which kind
// (#306 Phase A). The *behavior* of each kind is covered for real at the
// composable seam in `use-syncplay-client.test.ts`; what a scan can settle —
// and nothing else can, since these are `<script setup>` internals of a ~2.9k
// line SFC — is the wiring: that every programmatic play is registered, that it
// carries the right kind, and that the user's own `togglePlay` is not.
//
// The census matters as much as the individual assertions. Six `.play()` calls,
// five programmatic and one the user's; a seventh added without a decision is
// either a room-visible move (unregistered) or a stuck pause (registered as a
// generic echo), so the count is pinned.
describe('PlayerView — programmatic plays carry an operation kind (#306)', () => {
  const FLAT_NO_COMMENTS = SOURCE.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')

  it('registers exactly the five programmatic plays and leaves togglePlay alone', () => {
    // Every `.play()` on the element, comments stripped so the prose above the
    // helper cannot pad the count.
    const plays = FLAT_NO_COMMENTS.match(/\bv(?:ideo)?\.play\(\)/g) ?? []
    // One inside `playProgrammatically`, one inside `togglePlay`. The other five
    // go through the helper.
    expect(plays).toHaveLength(2)
    const helpers = FLAT_NO_COMMENTS.match(/playProgrammatically\(v, '(restore|episode-start)'\)/g)
    expect(helpers).toHaveLength(5)
  })

  it('gives the three wasPlaying restores restore semantics', () => {
    // One per source swap that preserves the user's captured playing state:
    // `selectQuality`, and `selectTranslation`'s local-file and stream branches.
    const restores = FLAT_NO_COMMENTS.match(
      /if \(wasPlaying\) playProgrammatically\(v, 'restore'\);/g
    )
    expect(restores).toHaveLength(3)
  })

  it('gives both goToEpisode plays episode-start semantics', () => {
    const starts = FLAT_NO_COMMENTS.match(/playProgrammatically\(v, 'episode-start'\);/g)
    expect(starts).toHaveLength(2)
  })

  it('leaves the user’s own togglePlay unregistered', () => {
    const body = SOURCE.slice(
      SOURCE.indexOf('function togglePlay()'),
      SOURCE.indexOf('function playProgrammatically')
    )
    expect(body).toContain('video.play();')
    expect(body).not.toContain('beginProgrammaticPlayback')
    expect(body).not.toContain('playProgrammatically(')
  })

  it('retracts a rejected programmatic play through its own handle', () => {
    // Exactness is the point: retracting by shape rather than by identity is the
    // residual #306 removes. `op.retract()` can only ever remove the operation
    // this call registered.
    expect(FLAT_NO_COMMENTS).toContain(
      "const op = syncplay.beginProgrammaticPlayback('play', kind); " +
        'void Promise.resolve(v.play()).catch(() => op.retract());'
    )
  })

  it('retires the old source’s operations on the quality swap the watcher cannot see', () => {
    // `selectQuality` rebinds `activeStreamUrl` without touching the episode
    // index or the translation id, so `useSyncplayClient`'s watcher never fires
    // for it — this is the one source replacement that has to say so itself.
    const body = SOURCE.slice(
      SOURCE.indexOf('function selectQuality('),
      SOURCE.indexOf('const TRANSLATION_TYPE_LABELS')
    )
    const flat = body.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')
    expect(flat).toContain('syncplay.bumpPlaybackSourceGeneration();')
    expect(flat.indexOf('syncplay.bumpPlaybackSourceGeneration();')).toBeLessThan(
      flat.indexOf('nextTick(')
    )
  })

  it('disarms the re-armed autoplay of a paused quality swap, after the rebind (#498)', () => {
    // In the `nextTick`, so after Vue has patched `src`: the load algorithm
    // re-arms `autoplay` on the patch, so a disarm before it does nothing. And
    // bare — no operation registered — because on an already-paused element the
    // pause fires no event to consume. Skipped while the mount's first autostart
    // is still pending outside a session (#509 review). The behaviour is pinned
    // in `syncplay-two-peer-quality-switch.test.ts`.
    const body = SOURCE.slice(
      SOURCE.indexOf('function selectQuality('),
      SOURCE.indexOf('const TRANSLATION_TYPE_LABELS')
    )
    const flat = body.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')
    expect(flat).toContain(
      'nextTick(() => { const v = videoRef.value; if (!v) return; seekProgrammatically(v, savedTime); ' +
        'const autostartPending = awaitingFirstAutostart && !syncplaySessionLive(); ' +
        'if (!wasPlaying && v.paused && !autostartPending) { awaitingFirstAutostart = false; v.pause(); } ' +
        "if (wasPlaying) playProgrammatically(v, 'restore'); });"
    )
  })

  it('registers the teardown pause as an echo, before the pause itself', () => {
    const body = SOURCE.slice(
      SOURCE.indexOf('onBeforeUnmount('),
      SOURCE.indexOf("video.removeAttribute('src');")
    )
    expect(body).toContain("if (!video.paused) syncplay.beginProgrammaticPlayback('pause');")
    expect(body.indexOf('beginProgrammaticPlayback')).toBeLessThan(body.indexOf('video.pause();'))
  })
})

// The seek half of the same wiring question (#306 Phase B), and the exact twin
// of the census above. The *behaviour* — strict vs. any-value matching, the
// `readyState` fork, retirement, expiry — is covered at the composable seam in
// `use-syncplay-client.test.ts`; a scan can only settle that every `currentTime`
// this file writes on the user's behalf is registered, and that the user's own
// seek goes through the composable's `seekAsUser` instead (#488).
//
// The census is the load-bearing part, for the same reason it is for the plays.
// One raw `currentTime` write exists, inside `seekProgrammatically`; the user's
// own write moved into `seekAsUser` with #488, which announces it to the room
// at intent. A second raw write added without a decision is either a
// room-dragging unregistered write — `forcePositionUpdate` fans it out to every
// watcher — or a user seek that is announced only on its `seeked`, which a room
// frame arriving mid-flight can undo before it is ever announced (#488). Both
// directions are a defect returning at a new site, so the count is pinned.
describe('PlayerView — programmatic seeks go through the operation helper (#306)', () => {
  const FLAT_NO_COMMENTS = SOURCE.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')

  it('routes exactly the six programmatic writes through the helper', () => {
    // Every assignment to the element's playhead, comments stripped so the prose
    // above the helper cannot pad the count.
    const writes = FLAT_NO_COMMENTS.match(/\bv(?:ideo)?\.currentTime = /g) ?? []
    // The one inside `seekProgrammatically`. The user's seek writes through
    // `syncplay.seekAsUser` (#488), and everything else goes through the helper.
    expect(writes).toHaveLength(1)
    const helpers = FLAT_NO_COMMENTS.match(/seekProgrammatically\(v(?:ideo)?, /g) ?? []
    // `resumeFromSavedPosition`, `selectQuality`'s restore, `selectTranslation`'s
    // two restores, and `goToEpisode`'s two rewinds to 0 — the seven external
    // sites of #306 minus `use-mse-player`'s resume land, which lives in its own
    // file and is pinned in `use-mse-player.test.ts`.
    expect(helpers).toHaveLength(6)
  })

  it('gives both goToEpisode rewinds the same helper, at 0', () => {
    const starts = FLAT_NO_COMMENTS.match(/seekProgrammatically\(v, 0\);/g)
    expect(starts).toHaveLength(2)
  })

  it('hands the user’s own seek to seekAsUser, not to the programmatic helper', () => {
    // `seek()` is where the keyboard and skip OP/ED land. `seekAsUser`
    // registers a strict `value` operation and announces the seek at intent
    // (#488); the programmatic helper would register one that swallows its
    // `seeked` and announce nothing, so the room would never hear the seek.
    const body = SOURCE.slice(
      SOURCE.indexOf('function seek(time: number)'),
      SOURCE.indexOf('function seekRelative(')
    )
    expect(body).toContain('syncplay.seekAsUser(target);')
    expect(body).not.toContain('currentTime =')
    expect(body).not.toContain('beginProgrammaticSeek')
    expect(body).not.toContain('seekProgrammatically(')
  })

  it('routes the scrubber release through seek(), the one user-seek door', () => {
    // Before #488 `onSeekEnd` wrote the element itself through `commitSeek`, a
    // second user write path that announced nothing at intent. It now goes
    // through `seek()`, which also bounds the target with `resolveSeekTarget`.
    const body = FLAT_NO_COMMENTS.slice(
      FLAT_NO_COMMENTS.indexOf('function onSeekEnd()'),
      FLAT_NO_COMMENTS.indexOf('function onSeekMouseMove(')
    )
    expect(body).toContain('seek(currentTime.value);')
    expect(body).not.toContain('currentTime =')
    expect(SOURCE).not.toContain('commitSeek')
  })

  it('registers before the write and retracts its own operation if it throws', () => {
    // Ordering first: an operation registered *after* the assignment could lose
    // the race to the element's own `seeked`. Then exactness — `op.retract()`
    // can only remove the operation this call registered, which is what the
    // single `appliedSeekPosition` slot could not promise, and the rethrow keeps
    // the helper's callers seeing exactly what a bare assignment gave them.
    expect(FLAT_NO_COMMENTS).toContain(
      'const op = syncplay.beginProgrammaticSeek(target); ' +
        'try { v.currentTime = target; } catch (err) { op.retract(); throw err; }'
    )
  })
})

// ── #347: a stale `wasPlaying` restore must not un-pause the room ────────────
//
// `selectTranslation` latches `wasPlaying` synchronously at its top and replays
// it on *both* arms after the switch completes — the local-file/remux arm and
// the stream arm, each `if (wasPlaying) playProgrammatically(v, 'restore');`.
// Between the latch and either replay sits an await (a remux prepare, or the
// `playerGetStreamUrl` round trip — 622 ms in #343's capture), and a pause the
// user makes inside that window is silently undone by the replay *and announced
// to the room* through `pushSyncplaySnapshot`'s `intentOr(v)`.
//
// The repair is a live veto inside `playProgrammatically`: a `restore` is
// declined when the session is live and the ready gate's own predicate
// (`shouldElementPlay()`) says the element should not be playing. So the cases
// below are behavioural, not a scan — they run the *real* helper source against
// the *real* composable. The helper is a `<script setup>` internal of a ~3.6k
// line SFC with no mount harness in this repo, so it is lifted out of the source
// text and instantiated over a `syncplay` binding: that keeps the production
// text itself under test (an edit to the helper changes what runs here) without
// mounting the view.
//
// `driveGateEntry` (use-syncplay-client.test.ts) is deliberately absent from all
// of these: it arranges a 600 ms readiness drop that a fast source switch never
// takes, and under this design there is no gate entry in the path at all — the
// predicate is read at the replay, in the same call stack. Do not add it back as
// boilerplate.

type PlayHelper = (v: HTMLVideoElement, kind: string) => void

function loadPlayProgrammatically(syncplay: unknown): PlayHelper {
  const start = SOURCE.indexOf('function playProgrammatically(')
  const end = SOURCE.indexOf('function seekProgrammatically(')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const js = transformSync(SOURCE.slice(start, end), { loader: 'ts' }).code
  return new Function('syncplay', `${js}\nreturn playProgrammatically;`)(syncplay) as PlayHelper
}

function selectTranslationBody(): string {
  const start = SOURCE.indexOf('async function selectTranslation(')
  const end = SOURCE.indexOf('async function goToEpisode(\n')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

/** The two replay arms, split at the `playerGetStreamUrl` await that separates
 *  the local-file/remux branch from the stream fallback. */
function translationArms(): { remux: string; remote: string } {
  const body = selectTranslationBody()
  const split = body.indexOf('await window.api.playerGetStreamUrl(')
  expect(split).toBeGreaterThan(-1)
  return { remux: body.slice(0, split), remote: body.slice(split) }
}

function stubApi(extra: Record<string, unknown> = {}): void {
  ;(globalThis as Record<string, unknown>).window = {
    api: {
      syncplayGetStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
      syncplayGetRoomUsers: vi.fn().mockResolvedValue([]),
      syncplayConnect: vi.fn().mockResolvedValue(undefined),
      syncplayDisconnect: vi.fn().mockResolvedValue(undefined),
      syncplaySetFile: vi.fn(),
      syncplaySendLocalState: vi.fn(),
      syncplaySendLocalSnapshot: vi.fn(),
      syncplayPlayerClosed: vi.fn(),
      syncplaySetReady: vi.fn().mockResolvedValue(undefined),
      shikimoriGetUser: vi.fn().mockResolvedValue({ nickname: '' }),
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      onSyncplayConnectionStatus: () => () => {},
      onSyncplayRemoteState: () => () => {},
      onSyncplayRoomUsers: () => () => {},
      onSyncplayRoomEvent: () => () => {},
      onSyncplayTrace: () => () => {},
      onSyncplayRemoteEpisodeChange: () => () => {},
      ...extra
    }
  }
}

type Rig = {
  v: HTMLVideoElement & { paused: boolean }
  client: ReturnType<typeof useSyncplayClient>
  play: PlayHelper
  sendLocalState: ReturnType<typeof vi.fn>
  sendSnapshot: ReturnType<typeof vi.fn>
}

/** A player mid-session with a loaded element, wired the way PlayerView wires
 *  it: the element's own `play` event fans into `syncplay.onLocalPlay()`. */
async function makeRig(state: SyncplayStatus['state'] = 'ready'): Promise<Rig> {
  const sendLocalState = vi.fn()
  const sendSnapshot = vi.fn()
  stubApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
  const v = {
    currentTime: 30,
    duration: 1440,
    paused: true,
    readyState: 1,
    play: vi.fn(),
    pause: vi.fn()
  } as unknown as HTMLVideoElement & { paused: boolean }
  const client = useSyncplayClient({
    getVideoEl: () => v,
    getDuration: () => 1440,
    getAnimeId: () => 1,
    getMalId: () => null,
    getAnimeName: () => 'Test Anime',
    getCurrentEpisodeInt: () => '1',
    getActiveEpisodeLabel: () => '1',
    activeTranslationId: ref(1),
    activeEpisodeIndex: ref(0),
    formatTime: (s: number) => `${Math.floor(s / 60)}`,
    onRemoteEpisodeChange: () => {}
  })
  // The `<video @play>` binding, not a convenience: the veto's whole job is to
  // stop the element from ever firing this, so the event has to come from the
  // element rather than from the test body.
  ;(v as unknown as { play: ReturnType<typeof vi.fn> }).play = vi.fn(() => {
    v.paused = false
    client.onLocalPlay()
    return Promise.resolve()
  })
  // The composable's own status fetch resolves a microtask later and would
  // otherwise overwrite the state this rig is built for.
  await flushPromises()
  client.syncplayStatus.value = { state, username: 'me' }
  return { v, client, play: loadPlayProgrammatically(client), sendLocalState, sendSnapshot }
}

/** The pre-switch world the latch reads: the room is playing and so are we. */
function startPlaying(rig: Rig): void {
  rig.v.paused = false
  rig.client.onLocalPlay()
  rig.sendLocalState.mockClear()
  rig.sendSnapshot.mockClear()
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi()
})

describe.each([
  ['the local-file / remux arm', 'remux' as const],
  ['the stream arm behind playerGetStreamUrl', 'remote' as const]
])('PlayerView — a stale wasPlaying restore is declined on %s (#347)', (_label, arm) => {
  it('routes this arm’s replay through the guarded helper', () => {
    // The behavioural half below exercises the helper once; this is what makes
    // the case *this arm's*. A fix that repairs one arm and leaves the other
    // calling `v.play()` directly is worse than no fix — the survivor gets
    // harder to find.
    const flat = translationArms()
      [arm].replace(/\/\/[^\n]*/g, '')
      .replace(/\s+/g, ' ')
    expect(flat).toContain("if (wasPlaying) playProgrammatically(v, 'restore');")
    expect(flat).not.toContain('v.play()')
  })

  it('declines the replay, keeps the pause, and announces no un-pause', async () => {
    const rig = await makeRig('ready')
    startPlaying(rig)

    // `selectTranslation` latches at its top, while the element is playing.
    const wasPlaying = !rig.v.paused
    expect(wasPlaying).toBe(true)

    // The await — a remux prepare, or the `playerGetStreamUrl` round trip. The
    // user gives up waiting and presses pause inside it.
    await Promise.resolve()
    rig.v.paused = true
    rig.client.onLocalPause()
    rig.sendLocalState.mockClear()

    // The switch completes and the `nextTick` replays the latch.
    if (wasPlaying) rig.play(rig.v, 'restore')
    await Promise.resolve()

    // The element stays where the user put it…
    expect(rig.v.play).not.toHaveBeenCalled()
    expect(rig.v.paused).toBe(true)
    // …and so does the intent, which is what the room is told on the next
    // snapshot. This is the room-visible half of #343's capture: `intendedPaused`
    // clobbered `true` → `false` and `roomPaused` following it.
    rig.client.onVideoTimeUpdate()
    expect(rig.sendSnapshot).toHaveBeenCalledWith({ position: 30, paused: true })
    expect(rig.sendSnapshot).not.toHaveBeenCalledWith({ position: 30, paused: false })
    // Nothing goes out as a discrete command either.
    expect(rig.sendLocalState).not.toHaveBeenCalled()
  })

  it('declines it across a reconnect too, not only on a ready session', async () => {
    // The session term is `ready || reconnecting`, never `ready` alone. The refs
    // the predicate reads are session-scoped and deliberately survive a socket
    // blip — the composable clears them on `idle`/`disconnected` only — so a
    // `ready`-only veto is off in exactly the window where a pause made across
    // the blip is still live, and a translation switch would undo it.
    const rig = await makeRig('ready')
    startPlaying(rig)
    const wasPlaying = !rig.v.paused

    rig.v.paused = true
    rig.client.onLocalPause()
    // The socket blips mid-switch. Same room, same player, same user.
    rig.client.syncplayStatus.value = { state: 'reconnecting', username: 'me' }

    if (wasPlaying) rig.play(rig.v, 'restore')
    await Promise.resolve()

    expect(rig.v.play).not.toHaveBeenCalled()
    expect(rig.v.paused).toBe(true)
  })
})

describe('PlayerView — the restore veto is narrow (#347)', () => {
  // Guards, not regressions: both of these are green before the fix and after
  // it. They are what a careless veto breaks.
  it('still resumes when nothing contradicted the latch', async () => {
    const rig = await makeRig('ready')
    startPlaying(rig)
    const wasPlaying = !rig.v.paused

    // The source swap leaves the element paused and reloaded; nobody paused
    // anything, so the room is still playing and the predicate still reads true.
    rig.v.paused = true

    if (wasPlaying) rig.play(rig.v, 'restore')
    await Promise.resolve()

    expect(rig.v.play).toHaveBeenCalled()
    expect(rig.v.paused).toBe(false)
    rig.client.onVideoTimeUpdate()
    expect(rig.sendSnapshot).toHaveBeenCalledWith({ position: 30, paused: false })
  })

  it('still resumes for a player that never joined a room', async () => {
    // `syncplayLastRemotePlaying` initialises `false`, so an unguarded veto would
    // refuse every restore in the plain local player. `idle` and `disconnected`
    // are outside the session term for exactly this reason.
    const rig = await makeRig('idle')
    rig.v.paused = true

    rig.play(rig.v, 'restore')
    await Promise.resolve()

    expect(rig.v.play).toHaveBeenCalled()
    expect(rig.v.paused).toBe(false)
  })

  it('leaves episode-start unvetoed', async () => {
    // Keyed on kind. `episode-start`'s contract is to *establish* the new
    // episode's intent, not to replay a stale one, so the veto's premise does
    // not apply — and folding it in on symmetry grounds would break the binge
    // auto-resume the same way `use-syncplay-client.ts`'s divergence note
    // describes: across an episode switch taken during a divergence the
    // projection still says `outOfFile` and the ready gate declines the resume.
    const rig = await makeRig('ready')
    rig.v.paused = true
    rig.client.onLocalPause()

    rig.play(rig.v, 'episode-start')

    expect(rig.v.play).toHaveBeenCalled()
  })
})

// ── #497: an in-room episode change belongs to the room from the commit ──────
//
// The room's position for the new episode (0) reaches a follower about 300 ms
// after its new element's `loadedmetadata`, and `remoteStateApplied` was cleared
// by the index change, so the #240 predicate read false in that gap and all
// three resume paths went to the saved position: the direct-file seek and its
// "Resumed at …" toast, the MSE land, and the MKV spawn target. These cases run
// the real `goToEpisode` commit block, the real predicate, the real
// `resumeFromSavedPosition` and the real spawn-target read, lifted out of the
// SFC the way the #347 cases lift `playProgrammatically`, against the real
// composable. Each open is made with no `remote-state` delivered, which is the
// gap itself.

const SAVED = { position: 591, duration: 1440, watched: false }

/** A top-level function of the SFC, by name; '' when the source has none. */
function liftFn(name: string): string {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(SOURCE)
  if (!m) return ''
  const end = SOURCE.indexOf('\n}\n', m.index)
  expect(end).toBeGreaterThan(m.index)
  return SOURCE.slice(m.index, end + 3)
}

function sliceFrom(start: string, end: string, after = 0): string {
  const s = SOURCE.indexOf(start, after)
  expect(s).toBeGreaterThan(-1)
  const e = SOURCE.indexOf(end, s)
  expect(e).toBeGreaterThan(s)
  return SOURCE.slice(s, e)
}

/** `goToEpisode`'s commit: the index write and the per-open state around it. */
function commitBlock(): string {
  const fn = SOURCE.indexOf('async function goToEpisode(\n')
  return sliceFrom('committed = true;', '// Try local file first if downloaded', fn)
}

/** `prepareMkvForPlayback`'s spawn-target read, up to the spawn. */
function spawnBlock(): string {
  const fn = SOURCE.indexOf('async function prepareMkvForPlayback(')
  return sliceFrom('let initialSeek = 0;', '// Nothing has been spawned yet', fn)
}

/** Every write `selectTranslation` makes to the open-scoped flag. */
function translationFlagWrites(): string {
  return [...selectTranslationBody().matchAll(/^\s*openedIntoRoom = [^;]+;$/gm)]
    .map((m) => m[0])
    .join('\n')
}

type OpenRig = {
  v: HTMLVideoElement
  writes: number[]
  client: ReturnType<typeof useSyncplayClient>
  roomPosition: ReturnType<typeof vi.fn>
  commit(index: number, origin: 'local' | 'follow'): void
  /** `onTargetMetadata` / the mount listener: what `loadedmetadata` runs. */
  resume(): Promise<void>
  /** The `hasRemoteStateApplied` dep the MSE composable's initial land reads. */
  mseLandCancelled(): boolean
  spawnTarget(): Promise<{ initialSeek: number; resumeTarget: number; fromRoom: boolean }>
  switchTranslation(): void
  toast(): string
}

async function makeOpenRig(opts: {
  state: SyncplayStatus['state']
  peers: boolean
  stream?: boolean
}): Promise<OpenRig> {
  const roomPosition = vi.fn().mockResolvedValue(null)
  stubApi({
    watchProgressGet: vi.fn().mockResolvedValue({ ...SAVED }),
    syncplayGetRoomPosition: roomPosition
  })
  const writes: number[] = []
  let ct = 0
  const v = {
    get currentTime() {
      return ct
    },
    set currentTime(t: number) {
      ct = t
      writes.push(t)
    },
    duration: 1440,
    paused: true,
    readyState: 1,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn()
  } as unknown as HTMLVideoElement
  const activeEpisodeIndex = ref(0)
  const activeTranslationId = ref(1)
  const client = useSyncplayClient({
    getVideoEl: () => v,
    getDuration: () => 1440,
    getAnimeId: () => 1,
    getMalId: () => null,
    getAnimeName: () => 'Test Anime',
    getCurrentEpisodeInt: () => String(activeEpisodeIndex.value + 1),
    getActiveEpisodeLabel: () => String(activeEpisodeIndex.value + 1),
    activeTranslationId,
    activeEpisodeIndex,
    formatTime: (s: number) => `${s}`,
    onRemoteEpisodeChange: () => {}
  })
  await flushPromises()
  client.syncplayStatus.value = { state: opts.state, username: 'me' }
  // Our own entry is always on the roster (main pushes it), so a solo room is
  // a roster of one, never an empty one.
  client.syncplayRoomUsers.value = [
    { username: 'me', file: null },
    ...(opts.peers ? [{ username: 'peer', file: null }] : [])
  ]

  const decls = sliceFrom('let cumulativePlayTime = 0;', 'let resumeToastTimer')
  const fns = [
    'resetEpisodeTracking',
    'syncplayHasPeer',
    'roomOwnsOpen',
    'roomOwnsPlayhead',
    'mkvSessionSeededFromRoom',
    'resumeFromSavedPosition',
    'seekProgrammatically',
    'formatTime'
  ]
    .map(liftFn)
    .join('\n')
  const ts = `
    ${decls}
    let resumeToastTimer = null;
    let pendingFollow = null;
    function cancelFollowGrace() {}
    ${fns}
    function commit(targetIndex, origin) {
      const direction = targetIndex > activeEpisodeIndex.value ? 'next' : 'prev';
      const continuesWalk = false;
      const targetEp = { episodeInt: String(targetIndex + 1), downloadedTrIds: [] };
      const targetTranslations = [];
      const resolvedTr = { id: activeTranslationId.value };
      const prevEpisodeInt = String(activeEpisodeIndex.value + 1);
      const myNav = 1;
      let committed = false;
      ${commitBlock()}
    }
    async function spawnTarget() {
      ${spawnBlock()}
      return { initialSeek, resumeTarget, fromRoom: mkvSpawnFromRoom };
    }
    function switchTranslation() {
      ${translationFlagWrites()}
    }
    return {
      commit,
      spawnTarget,
      switchTranslation,
      resume: resumeFromSavedPosition,
      mseLandCancelled: () => roomOwnsPlayhead(),
      toast: () => resumeToast.value
    };
  `
  const js = transformSync(ts, { loader: 'ts' }).code
  const lifted = new Function(
    'ref',
    'syncplay',
    'syncplayStatus',
    'syncplayRoomUsers',
    'videoRef',
    'props',
    'currentEpisodeInt',
    'streamSessionId',
    'mseInitialSeek',
    'currentTime',
    'activeEpisodeIndex',
    'activeEpisodeLabel',
    'activeTranslations',
    'activeDownloadedTrIds',
    'activeTranslationId',
    'resolveMkvSpawnTarget',
    js
  )(
    ref,
    client,
    client.syncplayStatus,
    client.syncplayRoomUsers,
    ref(v),
    { animeId: 1 },
    {
      get value() {
        return String(activeEpisodeIndex.value + 1)
      }
    },
    ref(opts.stream ? 'session-1' : ''),
    ref(0),
    ref(0),
    activeEpisodeIndex,
    ref('1'),
    ref([]),
    ref([]),
    activeTranslationId,
    resolveMkvSpawnTarget
  )
  return { v, writes, client, roomPosition, ...lifted }
}

/** An in-room Next/Prev up to the new element's `loadedmetadata`, with the
 *  room's 0 still in flight: the gap #497 is about. */
async function openNext(rig: OpenRig, origin: 'local' | 'follow', index = 1): Promise<void> {
  rig.commit(index, origin)
  // The composable's index watcher (pre-flush) resets the remote tracking.
  await flushPromises()
  expect(rig.client.hasRemoteStateApplied()).toBe(false)
}

describe('PlayerView — an in-room episode change belongs to the room (#497)', () => {
  it.each([['follow' as const], ['local' as const]])(
    '(a) %s: no seek to the saved position and no "Resumed at" toast on a direct file',
    async (origin) => {
      const rig = await makeOpenRig({ state: 'ready', peers: true })
      await openNext(rig, origin)
      await rig.resume()
      expect(rig.writes.filter((t) => t > 5)).toEqual([])
      expect(rig.v.currentTime).toBe(0)
      expect(rig.toast()).toBe('')
    }
  )

  it('(b) cancels the MSE initial land: its dep reads the room as owning the playhead', async () => {
    const rig = await makeOpenRig({ state: 'ready', peers: true, stream: true })
    await openNext(rig, 'follow')
    expect(rig.mseLandCancelled()).toBe(true)
  })

  it('(c) spawns the MKV session at the room’s 0 while main has no room position yet', async () => {
    const rig = await makeOpenRig({ state: 'ready', peers: true })
    await openNext(rig, 'follow')
    expect(await rig.spawnTarget()).toEqual({ initialSeek: 0, resumeTarget: 0, fromRoom: true })
    expect(rig.roomPosition).toHaveBeenCalledTimes(1)
  })

  it('(c) keeps a real room position, and #275’s end bound on it', async () => {
    const rig = await makeOpenRig({ state: 'ready', peers: true })
    await openNext(rig, 'follow')
    rig.roomPosition.mockResolvedValueOnce(120)
    expect(await rig.spawnTarget()).toEqual({ initialSeek: 119, resumeTarget: 120, fromRoom: true })
    // Past the end of our file: the bound refuses it and the saved record wins.
    rig.roomPosition.mockResolvedValueOnce(5000)
    expect(await rig.spawnTarget()).toEqual({
      initialSeek: 590,
      resumeTarget: 591,
      fromRoom: false
    })
  })

  describe.each([
    ['with no session', { state: 'idle' as const, peers: false }],
    ['alone in a ready room (own roster entry only)', { state: 'ready' as const, peers: false }],
    ['across a reconnect', { state: 'reconnecting' as const, peers: true }]
  ])('counter-pin: %s', (_label, opts) => {
    it('still resumes the direct file to the saved position, with the toast', async () => {
      const rig = await makeOpenRig(opts)
      await openNext(rig, 'local')
      await rig.resume()
      expect(rig.writes).toEqual([591])
      expect(rig.toast()).toBe('Resumed at 9:51')
    })

    it('still spawns the MKV session from the saved position', async () => {
      const rig = await makeOpenRig(opts)
      await openNext(rig, 'local')
      expect(await rig.spawnTarget()).toEqual({
        initialSeek: 590,
        resumeTarget: 591,
        fromRoom: false
      })
    })
  })

  it('reads the peer gate live: a room emptied before the first frame keeps the saved position', async () => {
    const rig = await makeOpenRig({ state: 'ready', peers: true })
    await openNext(rig, 'follow')
    rig.client.syncplayRoomUsers.value = [{ username: 'me', file: null }]
    await rig.resume()
    expect(rig.writes).toEqual([591])
    expect(rig.toast()).toBe('Resumed at 9:51')
  })

  it('a session that drops mid-open falls back to the saved resume', async () => {
    const rig = await makeOpenRig({ state: 'ready', peers: true })
    await openNext(rig, 'follow')
    // The roster is left as it was: only the session state says we are out.
    rig.client.syncplayStatus.value = { state: 'reconnecting', username: 'me' }
    await rig.resume()
    expect(rig.writes).toEqual([591])
    expect(rig.toast()).toBe('Resumed at 9:51')
  })

  it('a reconnect mid-open that rejoins alone keeps the saved position', async () => {
    const rig = await makeOpenRig({ state: 'ready', peers: true })
    await openNext(rig, 'follow')
    rig.client.syncplayStatus.value = { state: 'reconnecting', username: 'me' }
    rig.client.syncplayRoomUsers.value = [{ username: 'me', file: null }]
    rig.client.syncplayStatus.value = { state: 'ready', username: 'me' }
    await rig.resume()
    expect(rig.writes).toEqual([591])
  })

  it('is scoped to one open: the next episode change re-decides it', async () => {
    const rig = await makeOpenRig({ state: 'ready', peers: true })
    await openNext(rig, 'follow')
    rig.client.syncplayStatus.value = { state: 'idle', username: 'me' }
    rig.client.syncplayRoomUsers.value = []
    await openNext(rig, 'local', 2)
    rig.client.syncplayStatus.value = { state: 'ready', username: 'me' }
    rig.client.syncplayRoomUsers.value = [
      { username: 'me', file: null },
      { username: 'peer', file: null }
    ]
    await rig.resume()
    expect(rig.writes).toEqual([591])
  })

  describe('a multi-step follow walk', () => {
    it('a superseded step’s listener reads the winning step’s open (owned)', async () => {
      const rig = await makeOpenRig({ state: 'reconnecting', peers: true })
      // Step 1 commits outside `ready` and registers its `{ once: true }`
      // `loadedmetadata` listener, i.e. `resume`.
      await openNext(rig, 'follow', 1)
      const step1Listener = rig.resume
      rig.client.syncplayStatus.value = { state: 'ready', username: 'me' }
      await openNext(rig, 'follow', 2)
      // Step 1's listener fires on step 2's source.
      await step1Listener()
      expect(rig.writes.filter((t) => t > 5)).toEqual([])
      expect(rig.toast()).toBe('')
    })

    it('a superseded step’s listener reads the winning step’s open (not owned)', async () => {
      const rig = await makeOpenRig({ state: 'ready', peers: true })
      await openNext(rig, 'follow', 1)
      const step1Listener = rig.resume
      rig.client.syncplayStatus.value = { state: 'reconnecting', username: 'me' }
      await openNext(rig, 'follow', 2)
      rig.client.syncplayStatus.value = { state: 'ready', username: 'me' }
      await step1Listener()
      expect(rig.writes).toEqual([591])
    })
  })

  it('a translation switch after an owned open seeds its MKV spawn from the saved position', async () => {
    const rig = await makeOpenRig({ state: 'ready', peers: true })
    await openNext(rig, 'follow')
    rig.switchTranslation()
    expect(await rig.spawnTarget()).toEqual({
      initialSeek: 590,
      resumeTarget: 591,
      fromRoom: false
    })
  })

  it('clears the flag in selectTranslation before its MKV re-open', () => {
    const body = selectTranslationBody()
    const clear = body.indexOf('openedIntoRoom = false;')
    expect(clear).toBeGreaterThan(-1)
    expect(clear).toBeLessThan(body.indexOf('await prepareMkvForPlayback(localResult.filePath)'))
  })
})
