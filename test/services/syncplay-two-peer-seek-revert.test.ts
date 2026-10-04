// @vitest-environment happy-dom
//
// A user seek still in flight when the next room frame lands (#488).
//
// Before #488 a user seek reached the room only on `seeked`: the scrubber, the
// ±5 s keys and skip OP/ED were bare `currentTime` writes, and `onVideoSeeked`
// was the only caller of `sendSyncplayLocalState('seek')`. While the write was
// in flight the 1 Hz snapshot carried the target with `doSeek: false`, the
// server's `min()` election kept the room at the other peer's old position, and
// the next foreign frame reached `applyRemoteStateToElement` with
// `diff = |target - old| > 3.0`. The apply wrote the old position back, which
// aborted the user's seek; the only `seeked` that then fired was the apply's,
// it matched the apply's registered operation, and the user's target was never
// announced at all. The toast said the *other* peer seeked.
//
// The exposed role is the peer that is **not** the room's `setBy`: it is handed
// a foreign frame about once a second, so its seek was undone whenever it had
// not landed before the next one — P(undone) ≈ landing time / 1000 ms. The
// `setBy` peer's own frames are dropped at main's foreign-`setBy` guard, which
// is why `syncplay-seek-crossfire.test.ts` (host role only) never saw it below
// 3 s. Measured on the pre-fix code by this sweep: 0/10 at 100 ms up to 10/10 at
// 1500 ms, linear in between.
//
// The fix announces the seek at intent (`seekAsUser` in the composable:
// register a `value` operation, write, then announce), so main's ignore counter
// covers the flight and the peer moves without waiting for our buffering; and
// the apply holds a heartbeat-shaped correction while that operation is live.
//
// `SEEK_TO` is chosen far from anything main can have recorded as
// `lastAppliedRemotePosition`, so the echo guard in `sendLocalState`
// (`ECHO_SEEK_EPSILON_S`) cannot be what drops — or fails to drop — a
// frame here. Every position this room is ever placed at before the drag is
// within a few seconds of `ROOM_START`.

import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest'
import { defineComponent, ref, watch } from 'vue'
import { mount } from '@vue/test-utils'
import { useSkipMarkers } from '../../src/renderer/src/composables/use-skip-markers'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const SEEK_TO = 600
const DELAY_MS = 50
/** Landing time of the seeker's write. Every value is a whole number of the
 *  harness's 50 ms slices, so it is the landing the fixture actually runs. */
const LANDINGS_MS = [100, 250, 400, 650, 900, 1500, 3000]
/** Where in the 1 Hz frame cycle the drag starts. Ten phases, one per 100 ms. */
const PHASES_MS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]
const RUN_AFTER_S = 8
/** When the crossing cell's stale re-election reaches the seeker — see
 *  CROSSING in the sweep. */
const REELECTED_FRAME_AT_MS = 1150

interface Outcome {
  phaseMs: number
  /** Every `currentTime` write on the seeker from the drag on, raw. */
  writes: number[]
  /** `doSeek: true` frames the seeker put on the wire from the drag on. */
  doSeekOut: number
  seekerEnd: number
  otherEnd: number
  toasts: string[]
  /** The other peer sent a heartbeat carrying the old position *after* our
   *  `doSeek` left and before the server's forwarded copy reached it, so the
   *  two crossed on the wire. See `CROSSING` below. */
  crossed: boolean
}

describe('SyncplayClient — a seek in flight is not undone by the next room frame (#488)', () => {
  let room: TwoPeerRoom | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    room = null
    vi.useRealTimers()
  })

  const seatBoth = async (seekerLandMs: number): Promise<[Peer, Peer]> => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: seekerLandMs
    })
    return [host, joiner]
  }

  const runOne = async (landMs: number, phaseMs: number): Promise<Outcome> => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const [host, joiner] = await seatBoth(landMs)
    await room!.advance(4 + phaseMs / 1000)
    // The role under test: the seeker is handed frames the *other* peer set.
    // If the election ever seats it as `setBy` instead, this sweep is measuring
    // the crossfire file's role, and says so rather than passing vacuously.
    expect(joiner.frames.at(-1)?.state.setBy).toBe('hostuser')
    const writesBefore = joiner.el.seekWrites.length
    const wireBefore = room!.server.wireOf('joinuser').length
    const toasts: string[] = []
    const stop = watch(joiner.ui.syncplayToast, (t) => t && toasts.push(t), { flush: 'sync' })
    const seekAt = Date.now()
    joiner.userSeek(SEEK_TO)
    await room!.advance(RUN_AFTER_S)
    stop()
    const out: Outcome = {
      phaseMs,
      writes: joiner.el.seekWrites.slice(writesBefore),
      doSeekOut: room!.server
        .wireOf('joinuser')
        .slice(wireBefore)
        .filter((f) => f.doSeek === true).length,
      seekerEnd: joiner.el.currentTime,
      otherEnd: host.el.currentTime,
      toasts,
      crossed: room!.server
        .wireOf('hostuser')
        .some(
          (f) =>
            !f.doSeek &&
            Math.abs(f.position - SEEK_TO) > 20 &&
            f.at > seekAt &&
            f.at <= seekAt + 2 * DELAY_MS
        )
    }
    room!.dispose()
    room = null
    return out
  }

  for (const landMs of LANDINGS_MS) {
    it(`keeps a ${landMs} ms seek on the non-setBy peer at every tick phase`, async () => {
      const outcomes: Outcome[] = []
      for (const phaseMs of PHASES_MS) outcomes.push(await runOne(landMs, phaseMs))

      // CROSSING — the one cell per landing this fix does not, and should not,
      // decide. At phase 900 the other peer's own 1 Hz heartbeat leaves 100 ms
      // after our `doSeek`, exactly as the server's forwarded copy reaches it,
      // so it still carries the old position and the server re-elects that
      // position one link delay later. The re-elected frame reaches the seeker
      // at +1150 ms (the next periodic, plus the link). The reference server
      // discards that heartbeat: it arrives inside the server's own
      // `ignoringOnTheFly` window for the forced update it just sent, which
      // `test/helpers/syncplay-min-election-server.ts` deliberately does not
      // model. So it is pinned here rather than hidden, in both halves:
      //  - a seek still in flight at +1150 ms is held by the apply's belt and
      //    survives (the 1500 / 3000 ms rows — the belt's own regression);
      //  - a seek that has already landed was announced, once, and the room
      //    took it; the model's stale re-election then moves it afterwards,
      //    which is not #488's shape (never announced, aborted in flight).
      const crossed = outcomes.filter((o) => o.crossed).map((o) => o.phaseMs)
      expect(crossed, 'the crossing cell moved — re-derive CROSSING').toEqual([900])
      const landedBeforeReelection = landMs < REELECTED_FRAME_AT_MS

      // Undone: any write after the drag, i.e. the apply putting the old
      // position back. Collected across the sweep first so a red names every
      // phase it reds at, not just the first.
      const undone = outcomes.filter((o) => o.writes.length !== 1).map((o) => o.phaseMs)
      expect(undone, `phases at which the ${landMs} ms seek was undone`).toEqual(
        landedBeforeReelection ? crossed : []
      )
      for (const o of outcomes) {
        if (o.crossed && landedBeforeReelection) {
          expect(o.writes).toHaveLength(2)
          expect(o.writes[0]).toBe(SEEK_TO)
          expect(o.doSeekOut).toBe(1)
          continue
        }
        // Exactly the drag itself, and at the target.
        expect(o.writes).toEqual([SEEK_TO])
        // Exactly one `doSeek` out — announced, and announced once: the
        // eventual `seeked` is consumed by the operation registered at intent
        // rather than sent a second time.
        expect(o.doSeekOut, `phase ${o.phaseMs}`).toBe(1)
        // The seek stuck, and the other peer followed it.
        expect(o.seekerEnd).toBeGreaterThan(SEEK_TO)
        expect(o.otherEnd).toBeGreaterThan(SEEK_TO)
        expect(Math.abs(o.seekerEnd - o.otherEnd)).toBeLessThan(3)
        // And nobody is named for a seek they did not make.
        expect(o.toasts.filter((t) => t.includes('seeked to'))).toEqual([])
      }
    }, 60_000)
  }

  // The second symptom of the same race, on skip OP/ED. `useSkipMarkers` waits
  // for the first `seeked` after a skip click and reads the element there
  // (`onVideoSeeked` in `use-skip-markers.ts`). Before #488 the only `seeked`
  // that fired was the *reverting* apply's, at the old position — below the
  // band end — so the skip took its short branch: `onSkipLandedShort` raised
  // the "waiting for download" clamp toast on a file that was not clamped at
  // all, and the range stayed unmarked.
  it('lands a skip OP/ED on the band end instead of reporting a short landing', async () => {
    const [, joiner] = await seatBoth(650)
    await room!.advance(4)
    expect(joiner.frames.at(-1)?.state.setBy).toBe('hostuser')

    const time = ref(joiner.el.currentTime)
    const landedShort = vi.fn()
    let markers: ReturnType<typeof useSkipMarkers> | null = null
    // Mounted rather than called bare, so its lifecycle hooks have an owner —
    // the same reason the harness mounts the syncplay composable.
    const wrapper = mount(
      defineComponent({
        setup() {
          markers = useSkipMarkers({
            getAnimeId: () => 1,
            getCurrentEpisodeInt: () => '7',
            getCurrentTime: () => time.value,
            getPlayheadTime: () => joiner.el.currentTime,
            isStreaming: ref(false),
            activeStreamUrl: ref(''),
            onSeek: (t) => joiner.userSeek(t),
            onSkipLandedShort: landedShort
          })
          return () => null
        }
      })
    )
    onTestFinished(() => wrapper.unmount())
    const skip = markers!
    joiner.onSeeked(skip.onVideoSeeked)
    const OP_END = 195
    skip.showSkipDetections.value = {
      animeId: 1,
      perEpisode: {
        '7': {
          episodeInt: '7',
          episodeLabel: '7',
          filePath: '/fake/7.mkv',
          durationSec: 1440,
          hashesPerSec: 1,
          op: { startSec: 95, endSec: OP_END, pairCount: 3 },
          ed: null
        }
      },
      analyzedAt: 0,
      episodeCount: 1,
      algorithm: {
        source: 'local',
        sampleRate: 1,
        matchBitThreshold: 1,
        minRunSec: 1,
        windowSec: 1,
        refineBitThreshold: 1,
        refineSustainHashes: 1
      }
    }
    expect(skip.activeSkipRange.value).toBe('op')

    const writesBefore = joiner.el.seekWrites.length
    skip.onSkipClick()
    await room!.advance(RUN_AFTER_S)

    expect(landedShort).toHaveBeenCalledTimes(0)
    expect(joiner.el.seekWrites.slice(writesBefore)).toEqual([OP_END])
    expect(joiner.el.currentTime).toBeGreaterThan(OP_END)
  })
})
