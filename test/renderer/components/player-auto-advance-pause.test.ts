// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { transformSync } from 'esbuild'
import { ref } from 'vue'
import type { Ref } from 'vue'

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

function makeRig(state = 'ready'): Rig {
  const block = slice('function cancelAutoAdvance(', "\n// The user's Next")
  const reset = slice('function resetEpisodeTracking(', '\nconst ')
  const walk =
    slice('async function goToEpisode(', 'navigating.value = true;').replace(
      'async function goToEpisode(',
      'async function walkStep('
    ) + "navigating.value = true;\n  return 'committed';\n}\n"
  const js = transformSync(`${block}\n${reset}\n${walk}`, { loader: 'ts' }).code
  const v: FakeVideo = { ended: false, duration: DURATION, currentTime: 0 }
  const status = ref({ state })
  const navigating = ref(false)
  const countdown = ref(0)
  const goToEpisode = vi.fn()
  const ctx = {
    videoRef: ref(v),
    syncplayStatus: status,
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
    `const { videoRef, syncplayStatus, navigating, autoAdvanceCountdown, canNext, goToEpisode,
            activeEpisodeIndex, currentEpisodeInt, props, saveProgress } = ctx;
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
