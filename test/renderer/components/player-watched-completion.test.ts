// PlayerView's watched tracking against the real watch-progress router (#572).
//
// Opening an already-watched episode restores `watchedReported` from the saved
// row, and the saves of that open used to send it as `watched: true`, which main
// read as a completed re-watch: `sync.watched` was re-stamped every 5 s of any
// playback. The flag that goes on the wire is now `completedThisOpen`, set only
// when this open crosses the threshold. As `player-auto-advance-pause.test.ts`
// does, the production text is lifted out of the SFC (`trackProgressDelta`,
// `saveProgress`, `maybeMarkWatched`, `resetEpisodeTracking`,
// `resumeFromSavedPosition`) and run over fakes, with `window.api`'s watch
// progress calls going to the real main router on an in-memory store.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { transformSync } from 'esbuild'
import { ref } from 'vue'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../../src/shared/ipc/channels'
import { InMemoryStorage } from '../../helpers/in-memory-storage'
import { register } from '../../../src/main/ipc/watch-progress.ipc'
import type { AppDeps } from '../../../src/main/ipc/index'

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

const T0 = Date.UTC(2026, 0, 1)
const OPEN = Date.UTC(2026, 9, 27, 20)
const DURATION = 300
const INSTALL = 'install-a'
const local = (at: number): SyncClock => ({ at, origin: INSTALL })

interface Rig {
  store: InMemoryStorage
  video: { currentTime: number; duration: number }
  markShikimori: Mock
  row: () => WatchProgressEntry
  open: () => Promise<void>
  /** One second of playback: the element's clock and the wall clock both move. */
  tick: () => Promise<void>
}

function makeRig(initial: Record<string, WatchProgressEntry>): Rig {
  const store = new InMemoryStorage({ installId: INSTALL, watchProgress: initial })
  register({ store } as unknown as AppDeps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
  )
  const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(handlers.get(channel)!({}, ...args))
  const markShikimori = vi.fn(async () => null)
  ;(globalThis as { window?: unknown }).window = {
    api: {
      watchProgressSave: (...args: unknown[]) => call(CHANNELS.WATCH_PROGRESS_SAVE, ...args),
      watchProgressGet: (...args: unknown[]) => call(CHANNELS.WATCH_PROGRESS_GET, ...args),
      shikimoriMarkEpisodeWatched: markShikimori
    },
    dispatchEvent: () => true
  }

  const tracking = slice(
    'const WATCH_THRESHOLD_RATIO',
    'async function persistSelectedTranslation('
  )
  const mark = slice('async function maybeMarkWatched(', 'function resetEpisodeTracking(')
  const reset = slice('function resetEpisodeTracking(', 'async function tryPrefetch(')
  const resume = slice(
    'async function resumeFromSavedPosition(',
    'function maybeMarkPendingPrevWatched('
  )
  const js = transformSync(`${tracking}\n${mark}\n${reset}\n${resume}`, { loader: 'ts' }).code
  const video = { currentTime: 0, duration: DURATION }
  const ctx = {
    props: { animeId: 5, malId: 42 },
    videoRef: ref(video),
    duration: ref(DURATION),
    playing: ref(true),
    seeking: ref(false),
    prefetchSetting: ref('off'),
    tryPrefetch: () => {},
    playingEpisodeInt: ref('3'),
    currentEpisodeInt: ref('3'),
    activeTranslationId: ref(77),
    // An unwatched resume returns here, before the seek this rig has no use for.
    roomOwnsPlayhead: () => true,
    mkvSessionSeededFromRoom: () => false
  }
  const fns = new Function(
    'ctx',
    `const { props, videoRef, duration, playing, seeking, prefetchSetting, tryPrefetch,
            playingEpisodeInt, currentEpisodeInt, activeTranslationId, roomOwnsPlayhead,
            mkvSessionSeededFromRoom } = ctx;
     let cumulativePlayTime = 0, lastTimeUpdateAt = 0, lastSaveAt = 0, watchedReported = false;
     let completedThisOpen = false;
     let autoAdvancePauseArmed = false, mkvSpawnFromRoom = false, openedIntoRoom = false;
     let episodeOpenedAt = 0;
     ${js}
     return { trackProgressDelta, saveProgress, maybeMarkWatched, resetEpisodeTracking,
              resumeFromSavedPosition };`
  )(ctx)

  return {
    store,
    video,
    markShikimori,
    row: () => (store.get('watchProgress') as Record<string, WatchProgressEntry>)['5:3'],
    open: async () => {
      fns.resetEpisodeTracking()
      await fns.resumeFromSavedPosition()
    },
    // `onTimeUpdate`'s three tracking calls, in its order.
    tick: async () => {
      vi.setSystemTime(Date.now() + 1000)
      video.currentTime += 1
      fns.trackProgressDelta(Date.now())
      await fns.saveProgress()
      await fns.maybeMarkWatched()
    }
  }
}

/** Plays until this open crosses the watched threshold (80 % and 180 s). */
async function playToThreshold(rig: Rig): Promise<void> {
  while (rig.video.currentTime < DURATION * 0.8) await rig.tick()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(OPEN)
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { window?: unknown }).window
})

describe('PlayerView × watch-progress router — the watched clock', () => {
  function watchedRow(): WatchProgressEntry {
    return {
      position: 0,
      duration: DURATION,
      updatedAt: T0,
      watched: true,
      watchedAt: T0,
      translationId: 77,
      sync: { position: local(T0), watched: local(T0) }
    }
  }

  it('opening a watched episode and playing 10 s leaves sync.watched alone', async () => {
    const rig = makeRig({ '5:3': watchedRow() })
    await rig.open()

    for (let i = 0; i < 10; i++) await rig.tick()

    expect(rig.row().updatedAt).toBeGreaterThan(T0)
    expect(rig.row().watched).toBe(true)
    expect(rig.row().sync?.watched).toEqual(local(T0))
  })

  it('crossing the threshold again stamps the re-watch, with no second Shikimori mark', async () => {
    const rig = makeRig({ '5:3': watchedRow() })
    await rig.open()

    await playToThreshold(rig)

    expect(rig.row().sync?.watched).toEqual(local(Date.now()))
    expect(rig.row().watchedAt).toBe(T0)
    expect(rig.markShikimori).not.toHaveBeenCalled()
  })

  it('a first completion still marks Shikimori exactly once and stamps the flip', async () => {
    const rig = makeRig({})
    await rig.open()

    await playToThreshold(rig)
    const completedAt = Date.now()
    for (let i = 0; i < 30; i++) await rig.tick()

    expect(rig.markShikimori).toHaveBeenCalledTimes(1)
    expect(rig.markShikimori).toHaveBeenCalledWith(42, 3)
    expect(rig.row()).toMatchObject({ watched: true, watchedAt: completedAt })
  })

  it('the completion belongs to one open: the next open of the episode starts clean', async () => {
    const rig = makeRig({})
    await rig.open()
    await playToThreshold(rig)
    const stamped = rig.row().sync?.watched

    rig.video.currentTime = 0
    await rig.open()
    for (let i = 0; i < 10; i++) await rig.tick()

    expect(rig.row().sync?.watched).toEqual(stamped)
  })
})
