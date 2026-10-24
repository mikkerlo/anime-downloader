// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { transformSync } from 'esbuild'
import { defineComponent, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import {
  AUTO_ADVANCE_PAUSE_EPS_S,
  useSyncplayClient
} from '../../../src/renderer/src/composables/use-syncplay-client'

// #528: the room's pause at the end position can land ~1 ms before the element
// reaches `duration`, so that peer never fires `ended` and never shows the
// auto-advance countdown; the other peer's Cancel then strands the room. The
// countdown is a `<script setup>` internal of PlayerView with no mount harness
// in this repo, so — as `player-syncplay-resume.test.ts` does for
// `playProgrammatically` — the production text is lifted out of the SFC and
// run over fakes: the auto-advance block (`cancelAutoAdvance` through
// `onAutoAdvanceSeeked`), `resetEpisodeTracking` (the episode-change latch
// clear), and `goToEpisode` up to `navigating.value = true;` (the walk's
// `cancelAutoAdvance()` that a pull to N+1 takes before anything else).
const SOURCE = readFileSync(
  resolve(__dirname, '../../../src/renderer/src/components/views/PlayerView.vue'),
  'utf8'
)

function slice(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle)
  const end = SOURCE.indexOf(endNeedle, start + startNeedle.length)
  expect(start, `missing slice start: ${startNeedle}`).toBeGreaterThan(-1)
  expect(end, `missing slice end: ${endNeedle}`).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

interface FakeVideo {
  ended: boolean
  duration: number
  currentTime: number
}

interface Rig {
  v: FakeVideo
  status: Ref<{ state: string }>
  navigating: Ref<boolean>
  countdown: Ref<number>
  goToEpisode: ReturnType<typeof vi.fn>
  cancelAutoAdvance: () => void
  onVideoEnded: () => void
  onPause: () => void
  onSeeked: () => void
  resetEpisodeTracking: () => void
  walkStep: (direction: 'prev' | 'next', origin: string) => Promise<string>
}

const DURATION = 1420

/** The room half, for #533: the composable's `roomPausedAtEnd`. The #528 cases below stub it
 *  `false`; the #533 block passes the real composable. */
type RoomEndPause = { roomPausedAtEnd: (duration: number) => boolean }

function makeRig(
  state: string | Ref<{ state: string }> = 'ready',
  v: FakeVideo = { ended: false, duration: DURATION, currentTime: 0 },
  syncplay: RoomEndPause = { roomPausedAtEnd: () => false }
): Rig {
  const block = slice('function cancelAutoAdvance(', "\n// The user's Next")
  const reset = slice('function resetEpisodeTracking(', '\nconst ')
  const walk =
    slice('async function goToEpisode(', 'navigating.value = true;').replace(
      'async function goToEpisode(',
      'async function walkStep('
    ) + "navigating.value = true;\n  return 'committed';\n}\n"
  const js = transformSync(`${block}\n${reset}\n${walk}`, { loader: 'ts' }).code
  const status = typeof state === 'string' ? ref({ state }) : state
  const navigating = ref(false)
  const countdown = ref(0)
  const goToEpisode = vi.fn()
  const ctx = {
    videoRef: ref(v),
    syncplayStatus: status,
    syncplay,
    AUTO_ADVANCE_PAUSE_EPS_S,
    navigating,
    autoAdvanceCountdown: countdown,
    canNext: ref(true),
    goToEpisode,
    activeEpisodeIndex: ref(3),
    currentEpisodeInt: ref('4'),
    props: { allEpisodes: Array.from({ length: 10 }, (_, i) => ({ episodeInt: String(i + 1) })) },
    saveProgress: async () => {}
  }
  const fns = new Function(
    'ctx',
    `const { videoRef, syncplayStatus, syncplay, AUTO_ADVANCE_PAUSE_EPS_S, navigating,
            autoAdvanceCountdown, canNext, goToEpisode, activeEpisodeIndex, currentEpisodeInt,
            props, saveProgress } = ctx;
     let autoAdvanceTimer = null;
     let autoAdvancePauseArmed = false;
     let unmounted = false;
     let cumulativePlayTime = 0, lastTimeUpdateAt = 0, lastSaveAt = 0, watchedReported = false;
     let mkvSpawnFromRoom = false, openedIntoRoom = false, episodeOpenedAt = 0;
     ${js}
     return { cancelAutoAdvance, onVideoEnded, maybeArmAutoAdvanceOnPause, onAutoAdvanceSeeked,
              resetEpisodeTracking, walkStep };`
  )(ctx)
  return {
    v,
    status,
    navigating,
    countdown,
    goToEpisode,
    cancelAutoAdvance: fns.cancelAutoAdvance,
    onVideoEnded: fns.onVideoEnded,
    onPause: fns.maybeArmAutoAdvanceOnPause,
    onSeeked: fns.onAutoAdvanceSeeked,
    resetEpisodeTracking: fns.resetEpisodeTracking,
    walkStep: fns.walkStep
  }
}

/** The room's pause, landing `gap` seconds short of the end with no `ended`. */
function roomPauseAt(rig: Rig, gap: number): void {
  rig.v.currentTime = DURATION - gap
  rig.v.ended = false
  rig.onPause()
}

/** Runs any countdown to completion and well past it. */
function runOut(): void {
  vi.advanceTimersByTime(12_000)
}

const advances = (rig: Rig): number =>
  rig.goToEpisode.mock.calls.filter((c) => c[0] === 'next' && c[1] === 'auto-advance').length

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PlayerView — a room pause within a frame of the end arms the countdown (#528)', () => {
  it('wires the check to the element pause and the latch clear to its seeked', () => {
    const flat = (s: string): string => s.replace(/\s+/g, ' ')
    expect(SOURCE).toContain('@pause="onPause"')
    expect(flat(slice('function onPause(', '\nfunction onTimeUpdate('))).toContain(
      'syncplay.onLocalPause(); maybeArmAutoAdvanceOnPause(); }'
    )
    expect(SOURCE).toContain('@seeked="onVideoSeekedAll"')
    expect(flat(slice('function onVideoSeekedAll(', '\nfunction '))).toContain(
      'onAutoAdvanceSeeked();'
    )
  })

  it('arms exactly once on a pause at duration - 0.001 with ended false', () => {
    const rig = makeRig()
    roomPauseAt(rig, 0.001)
    expect(rig.countdown.value).toBe(5)
    // A second room pause on the same episode is the once-per-episode latch.
    roomPauseAt(rig, 0.001)
    runOut()
    expect(advances(rig)).toBe(1)
  })

  it('does not arm on a pause at duration - 5', () => {
    const rig = makeRig()
    roomPauseAt(rig, 5)
    expect(rig.countdown.value).toBe(0)
    runOut()
    expect(rig.goToEpisode).not.toHaveBeenCalled()
  })

  it('keeps the window to about one frame', () => {
    // 0.2 s is far inside any "seconds" window and must not arm.
    const rig = makeRig()
    roomPauseAt(rig, 0.2)
    runOut()
    expect(rig.goToEpisode).not.toHaveBeenCalled()
  })

  it('gives one countdown when a late ended follows a pause-armed one', () => {
    const rig = makeRig()
    roomPauseAt(rig, 0.001)
    vi.advanceTimersByTime(1500)
    rig.v.currentTime = DURATION
    rig.v.ended = true
    rig.onVideoEnded()
    runOut()
    expect(advances(rig)).toBe(1)
  })

  it.each(['idle', 'hello-sent', 'reconnecting', 'disconnected'])(
    'does not arm outside a ready session (%s)',
    (state) => {
      const rig = makeRig(state)
      roomPauseAt(rig, 0.001)
      runOut()
      expect(rig.goToEpisode).not.toHaveBeenCalled()
    }
  )

  it('does not treat the ended pause itself as a near-end pause', () => {
    // The element fires `pause` just before `ended`, with `ended` already true.
    const rig = makeRig()
    rig.v.currentTime = DURATION
    rig.v.ended = true
    rig.onPause()
    expect(rig.countdown.value).toBe(0)
  })

  it('after Cancel, a seek back and a play to the end gives a second countdown', () => {
    const rig = makeRig()
    roomPauseAt(rig, 0.001)
    rig.cancelAutoAdvance()
    // Seek back, then play through to a real `ended`: the latch is not on that path.
    rig.v.currentTime = 600
    rig.onSeeked()
    rig.v.currentTime = DURATION
    rig.v.ended = true
    rig.onVideoEnded()
    runOut()
    expect(advances(rig)).toBe(1)
  })

  it('after Cancel, a seek back re-opens the pause path for the next near-end pause', () => {
    const rig = makeRig()
    roomPauseAt(rig, 0.001)
    rig.cancelAutoAdvance()
    roomPauseAt(rig, 0.001)
    expect(rig.countdown.value).toBe(0)
    rig.v.currentTime = 600
    rig.onSeeked()
    roomPauseAt(rig, 0.001)
    expect(rig.countdown.value).toBe(5)
    runOut()
    expect(advances(rig)).toBe(1)
  })

  it('an episode change clears the latch', () => {
    const rig = makeRig()
    roomPauseAt(rig, 0.001)
    rig.cancelAutoAdvance()
    rig.resetEpisodeTracking()
    roomPauseAt(rig, 0.001)
    expect(rig.countdown.value).toBe(5)
  })

  it('a walk that pulls us to N+1 first clears the pause-armed countdown', async () => {
    const rig = makeRig()
    roomPauseAt(rig, 0.001)
    vi.advanceTimersByTime(2000)
    expect(rig.countdown.value).toBe(3)
    // The other peer's countdown advanced the room; our follow step starts.
    await expect(rig.walkStep('next', 'follow')).resolves.toBe('committed')
    expect(rig.countdown.value).toBe(0)
    // Until the step releases `navigating` the element still holds N's source at
    // its end; a room pause there must not arm a countdown that would step N+2.
    roomPauseAt(rig, 0.001)
    rig.resetEpisodeTracking()
    roomPauseAt(rig, 0.001)
    runOut()
    expect(rig.goToEpisode).not.toHaveBeenCalled()
  })
})

// #533: a peer behind the room when the room pauses at the end. The room's position is then
// `>= v.duration`, which the apply refuses as out of file at any drift, so the peer is paused
// where it stands, never fires `ended`, and before this fix was never offered the countdown —
// the other peer's Cancel stranded it. Here the real composable applies the room's frames to a
// fake element and the lifted `maybeArmAutoAdvanceOnPause` runs on that element's `pause`, the
// way PlayerView's `onPause` calls `syncplay.onLocalPause()` and then it (wiring pinned above).
// Each case asserts both the arm count and whether the out-of-file toast fired.
const OUT_OF_FILE_TOAST = "Can't follow — the room is past the end of your file"

type RoomVideo = FakeVideo & {
  paused: boolean
  readyState: number
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
}

interface RoomRig {
  rig: Rig
  v: RoomVideo
  client: ReturnType<typeof useSyncplayClient>
  /** Every element-position write the composable made. */
  writes: number[]
  /** Every toast the composable showed, in order. */
  toasts: string[]
  emit: (s: Partial<SyncplayRemoteState>) => void
  /** Fires the element events the last calls queued: the apply returns first, as in Chromium. */
  dispatch: () => void
}

const unmounts: (() => void)[] = []
afterEach(() => {
  unmounts.splice(0).forEach((u) => u())
})

async function mountRoom(elementAt: number, duration = DURATION): Promise<RoomRig> {
  vi.useRealTimers()
  setActivePinia(createPinia())
  const queue: (() => void)[] = []
  let position = elementAt
  const writes: number[] = []
  const v = {
    ended: false,
    duration,
    paused: false,
    readyState: 4,
    play: vi.fn(),
    pause: vi.fn()
  } as unknown as RoomVideo
  Object.defineProperty(v, 'currentTime', {
    get: () => position,
    set: (t: number) => {
      writes.push(t)
      position = Math.min(Math.max(0, t), duration)
    }
  })
  let cb: ((s: SyncplayRemoteState) => void) | null = null
  const noop = (): (() => void) => () => {}
  ;(globalThis as { window?: unknown }).window = {
    api: {
      syncplayGetStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
      syncplayGetRoomUsers: vi.fn().mockResolvedValue([]),
      syncplaySetFile: vi.fn(),
      syncplaySendLocalState: vi.fn(),
      syncplaySendLocalSnapshot: vi.fn(),
      syncplayPlayerClosed: vi.fn(),
      syncplaySetReady: vi.fn().mockResolvedValue(undefined),
      shikimoriGetUser: vi.fn().mockResolvedValue({ nickname: '' }),
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      onSyncplayConnectionStatus: noop,
      onSyncplayRemoteState: (fn: (s: SyncplayRemoteState) => void) => {
        cb = fn
        return () => {}
      },
      onSyncplayRoomUsers: noop,
      onSyncplayRoomEvent: noop,
      onSyncplayTrace: noop,
      onSyncplayRemoteEpisodeChange: noop
    }
  }
  let client: ReturnType<typeof useSyncplayClient> | null = null
  const Host = defineComponent({
    setup() {
      client = useSyncplayClient({
        getVideoEl: () => v as unknown as HTMLVideoElement,
        getDuration: () => duration,
        getAnimeId: () => 1,
        getMalId: () => null,
        getAnimeName: () => 'Test Anime',
        getCurrentEpisodeInt: () => '4',
        getActiveEpisodeLabel: () => '4',
        activeTranslationId: ref(1),
        activeEpisodeIndex: ref(3),
        formatTime: (s) => `${s}`,
        onRemoteEpisodeChange: () => {}
      })
      return () => null
    }
  })
  const wrapper = mount(Host)
  unmounts.push(() => wrapper.unmount())
  await flushPromises()
  const c = client!
  const rig = makeRig(c.syncplayStatus as unknown as Ref<{ state: string }>, v, c)
  v.play.mockImplementation(() => {
    if (v.paused) {
      v.paused = false
      queue.push(() => c.onLocalPlay())
    }
    return Promise.resolve()
  })
  v.pause.mockImplementation(() => {
    if (v.paused) return
    v.paused = true
    queue.push(() => {
      c.onLocalPause()
      rig.onPause()
    })
  })
  const toasts: string[] = []
  const emit = (s: Partial<SyncplayRemoteState>): void =>
    cb?.({ position: 0, paused: true, doSeek: false, setBy: null, ...s })
  const dispatch = (): void => {
    while (queue.length) queue.shift()!()
  }
  c.syncplayStatus.value = { state: 'ready', username: 'me' }
  await flushPromises()
  // The room playing in step with us, so what follows starts from an ordinary playing peer.
  emit({ position: elementAt, paused: false, setBy: 'peer' })
  dispatch()
  v.paused = false
  v.pause.mockClear()
  writes.length = 0
  const stop = watchToasts(c, toasts)
  unmounts.push(stop)
  vi.useFakeTimers()
  return { rig, v, client: c, writes, toasts, emit, dispatch }
}

function watchToasts(c: ReturnType<typeof useSyncplayClient>, into: string[]): () => void {
  return watch(
    c.syncplayToast,
    (now) => {
      if (now) into.push(now)
    },
    { flush: 'sync' }
  )
}

const outOfFileToasts = (r: RoomRig): number =>
  r.toasts.filter((t) => t === OUT_OF_FILE_TOAST).length

describe('PlayerView — a room pause at the end arms a peer that was behind (#533)', () => {
  it('arms once with no toast when the room pauses at duration and we are 10 s short', async () => {
    const r = await mountRoom(DURATION - 10)
    r.emit({ position: DURATION, paused: true, setBy: 'peer' })
    r.dispatch()
    expect(r.v.pause).toHaveBeenCalledTimes(1)
    // Paused where it stands: nothing moves the element.
    expect(r.writes).toEqual([])
    expect(r.v.currentTime).toBe(DURATION - 10)
    expect(r.rig.countdown.value).toBe(5)
    expect(outOfFileToasts(r)).toBe(0)
    runOut()
    expect(advances(r.rig)).toBe(1)
    expect(outOfFileToasts(r)).toBe(0)
  })

  // At `duration` the room is out of file and nothing moves us. A frame inside it is in file, so
  // #524's pause-edge snap takes us to the room's position; the arm does not depend on that.
  it.each([
    ['== duration', DURATION, []],
    ['duration - 0.001', DURATION - 0.001, [DURATION - 0.001]]
  ])('arms once with no toast on a room paused at %s, us 1.5 s short', async (_, pos, moved) => {
    const r = await mountRoom(DURATION - 1.5)
    r.emit({ position: pos, paused: true, setBy: 'peer' })
    r.dispatch()
    expect(r.v.pause).toHaveBeenCalledTimes(1)
    expect(r.writes).toEqual(moved)
    expect(r.rig.countdown.value).toBe(5)
    runOut()
    expect(advances(r.rig)).toBe(1)
    expect(outOfFileToasts(r)).toBe(0)
  })

  it('does not arm when the room plays at its end and the ready gate pauses us', async () => {
    const r = await mountRoom(DURATION - 1.5)
    r.emit({ position: DURATION, paused: false, setBy: 'peer' })
    r.dispatch()
    r.client.syncplayRoomUsers.value = [
      { username: 'me', file: null, isReady: true },
      { username: 'peer', file: null, isReady: false }
    ]
    await vi.waitFor(() => expect(r.v.pause).toHaveBeenCalledTimes(1))
    r.dispatch()
    expect(r.client.roomPausedAtEnd(DURATION)).toBe(false)
    expect(r.rig.countdown.value).toBe(0)
    runOut()
    expect(advances(r.rig)).toBe(0)
    expect(outOfFileToasts(r)).toBe(0)
  })

  it('does not arm when the room pauses mid-episode, us 1.5 s short', async () => {
    const r = await mountRoom(DURATION - 1.5)
    r.emit({ position: 600, paused: true, setBy: 'peer' })
    r.dispatch()
    expect(r.v.pause).toHaveBeenCalledTimes(1)
    expect(r.rig.countdown.value).toBe(0)
    runOut()
    expect(advances(r.rig)).toBe(0)
    expect(outOfFileToasts(r)).toBe(0)
  })

  it('does not re-arm on a second pause after a Cancel', async () => {
    const r = await mountRoom(DURATION - 10)
    r.emit({ position: DURATION, paused: true, setBy: 'peer' })
    r.dispatch()
    expect(r.rig.countdown.value).toBe(5)
    r.rig.cancelAutoAdvance()
    // The user plays on; the room's end pause reaches us again.
    void r.v.play()
    r.dispatch()
    r.emit({ position: DURATION, paused: true, setBy: 'peer' })
    r.dispatch()
    expect(r.v.pause).toHaveBeenCalledTimes(2)
    // The room half alone would arm: only the latch holds it.
    expect(r.client.roomPausedAtEnd(DURATION)).toBe(true)
    expect(r.rig.countdown.value).toBe(0)
    runOut()
    expect(advances(r.rig)).toBe(0)
    expect(outOfFileToasts(r)).toBe(0)
  })

  it('does not arm a mid-episode pause from a room report that predates our play', async () => {
    const r = await mountRoom(DURATION - 10)
    r.emit({ position: DURATION, paused: true, setBy: 'peer' })
    r.dispatch()
    r.rig.cancelAutoAdvance()
    // Seek back (the latch reopens), play, and pause by hand with no room frame between.
    r.v.currentTime = 600
    r.rig.onSeeked()
    void r.v.play()
    r.dispatch()
    r.v.pause()
    r.dispatch()
    expect(r.rig.countdown.value).toBe(0)
    runOut()
    expect(advances(r.rig)).toBe(0)
  })
})

// #541: two peers on different cuts of one episode. When the shorter-cut peer ends, the room
// pauses at that peer's `duration`, which is inside our longer file: nothing is refused, we pause
// seconds short of our own end, and before this fix nothing armed. The ended peer's Cancel stays
// local, so we were stranded paused mid-credits. The pauser's roster row now counts as the end.
describe('PlayerView — a room pause at the pauser’s end arms a peer on a longer cut (#541)', () => {
  const LONGER = DURATION + 5
  const EP = 'Test Anime - 4'

  async function onLongerCut(elementAt: number): Promise<RoomRig> {
    const r = await mountRoom(elementAt, LONGER)
    r.client.syncplayRoomUsers.value = [
      { username: 'me', file: { name: EP, duration: LONGER } },
      { username: 'peer', file: { name: EP, duration: DURATION } }
    ]
    return r
  }

  it('arms once with no toast when the shorter peer ends and its Cancel stays local', async () => {
    const r = await onLongerCut(DURATION - 0.1)
    r.emit({ position: DURATION, paused: true, setBy: 'peer' })
    r.dispatch()
    expect(r.v.pause).toHaveBeenCalledTimes(1)
    expect(r.v.currentTime).toBeLessThan(LONGER - 4)
    expect(r.rig.countdown.value).toBe(5)
    // The ended peer cancels its own countdown; nothing of that reaches us, so ours runs out.
    runOut()
    expect(advances(r.rig)).toBe(1)
    expect(outOfFileToasts(r)).toBe(0)
  })

  it('does not arm on a mid-episode peer pause', async () => {
    const r = await onLongerCut(600)
    r.emit({ position: 600, paused: true, setBy: 'peer' })
    r.dispatch()
    expect(r.v.pause).toHaveBeenCalledTimes(1)
    expect(r.rig.countdown.value).toBe(0)
    runOut()
    expect(advances(r.rig)).toBe(0)
  })

  it('does not arm when the pauser’s row is the previous episode', async () => {
    const r = await onLongerCut(DURATION - 0.1)
    r.client.syncplayRoomUsers.value = [
      { username: 'me', file: { name: EP, duration: LONGER } },
      { username: 'peer', file: { name: 'Test Anime - 3', duration: DURATION } }
    ]
    r.emit({ position: DURATION, paused: true, setBy: 'peer' })
    r.dispatch()
    expect(r.v.pause).toHaveBeenCalledTimes(1)
    expect(r.rig.countdown.value).toBe(0)
  })

  // The reverse is #540's own-end arm: the longer-cut peer ends past our shorter file while we trail.
  it('still arms the shorter peer when the longer-cut peer ends', async () => {
    const r = await mountRoom(DURATION - 10)
    r.client.syncplayRoomUsers.value = [
      { username: 'me', file: { name: EP, duration: DURATION } },
      { username: 'peer', file: { name: EP, duration: LONGER } }
    ]
    r.emit({ position: LONGER, paused: true, setBy: 'peer' })
    r.dispatch()
    expect(r.writes).toEqual([])
    expect(r.rig.countdown.value).toBe(5)
    runOut()
    expect(advances(r.rig)).toBe(1)
    expect(outOfFileToasts(r)).toBe(0)
  })
})
