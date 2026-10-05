// @vitest-environment happy-dom
//
// A quality switch right after a pause (#498).
//
// `selectQuality` rebinds `activeStreamUrl`, and the rebind re-arms the bare
// `autoplay` on `PlayerView`'s `<video>`. Neither the episode index nor the
// translation id moves, so no watcher in `useSyncplayClient` sees the swap and
// nothing on the quality path disarms the element. On #498's rig a fast reload
// reached HAVE_ENOUGH_DATA before any incidental gate entry did, the element
// started itself, and `onLocalPlay` — finding no operation for that `play` —
// took it for the user's press and told the room `paused: false`. Solo it is
// not a race at all: `applySyncplayReadyGate` returns at once outside a ready
// session, so nothing ever disarms there.
//
// ── What is real and what is modelled ────────────────────────────────────────
//
// Real: both main `SyncplayClient`s, their routers, both mounted composables,
// `MinElectionServer`. Modelled: `PlayerView.selectQuality`, because there is
// no `PlayerView` mount harness, and the `autoplay` attribute, through
// `HarnessVideo`'s opt-in `autoplay` option. The source-scan block at the end
// pins the model's statements against `PlayerView.vue` so the two cannot drift
// apart without a red here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createTwoPeerRoom, HarnessVideo } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const DELAY_MS = 50
const HAVE_ENOUGH_DATA = 4

/**
 * Where `selectQuality`'s disarm sits.
 *
 *  - `'none'`: no disarm, `PlayerView` before #498.
 *  - `'after-rebind'`: in the `nextTick`, after Vue has patched `src` and the
 *    load algorithm has re-armed the element — what `PlayerView` does.
 *  - `'before-rebind'`: ahead of the patch, which the load algorithm then
 *    undoes. Only here to prove the order is what holds.
 */
type Disarm = 'none' | 'after-rebind' | 'before-rebind'

/** What `PlayerView.selectQuality` does today; the scan below holds it there. */
const PLAYER_VIEW_DISARM = 'none' as Disarm

/**
 * `PlayerView.selectQuality`, statement for statement. `ui` is `null` for a
 * player that never joined a room — the composable's registry is irrelevant
 * there, and the seek is a bare write.
 */
function selectQuality(
  el: HarnessVideo,
  ui: Peer['ui'] | null,
  src: string,
  disarm: Disarm = PLAYER_VIEW_DISARM
): void {
  const savedTime = el.currentTime
  const wasPlaying = !el.paused
  ui?.bumpPlaybackSourceGeneration()
  if (disarm === 'before-rebind' && !wasPlaying && el.paused) el.pause()
  // Vue's patch of `:src`, which lands in the flush ahead of the `nextTick`
  // callback below.
  el.reload(src)
  // ── nextTick ──
  if (ui) ui.beginProgrammaticSeek(savedTime)
  el.currentTime = savedTime
  if (disarm === 'after-rebind' && !wasPlaying && el.paused) el.pause()
  if (wasPlaying) {
    // `playProgrammatically(v, 'restore')`, #347 veto included.
    const state = ui?.syncplayStatus.value.state ?? 'idle'
    const sessionLive = state !== 'idle' && state !== 'disconnected'
    if (sessionLive && !ui!.shouldElementPlay()) return
    ui?.beginProgrammaticPlayback('play', 'restore')
    void el.play()
  }
}

const discreteSends = (p: Peer): number => p.counters().clientIgnoreCounter

/**
 * The fixture reload #498 measured at ~25–45 ms: the load's own queued tasks
 * are delivered at HAVE_NOTHING first, as on a real element, and the element
 * then reaches HAVE_ENOUGH_DATA before any roster or apply entry can run.
 */
const fastLoad = (peer: Peer): void => {
  peer.tick()
  peer.el.readyState = HAVE_ENOUGH_DATA
}

describe('a quality switch right after a pause (#498)', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  const seatPlayingPair = async (autoplay: boolean): Promise<[Peer, Peer]> => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const switcher = await room.seat({
      username: 'switcher',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      autoplay
    })
    const watcher = await room.seat({
      username: 'watcher',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)
    expect(switcher.el.paused).toBe(false)
    expect(watcher.el.paused).toBe(false)
    return [switcher, watcher]
  }

  /**
   * The 0 ms bucket of #498's sweep: the press, the switch, and a reload fast
   * enough to reach HAVE_ENOUGH_DATA before any roster or apply entry can run.
   * Returns every `paused: false` the switcher put on the wire from the press
   * on — counted, not sampled at the end, so a resume that a later frame
   * happened to undo still shows.
   */
  const pauseThenSwitch = async (
    switcher: Peer,
    disarm: Disarm = PLAYER_VIEW_DISARM
  ): Promise<number> => {
    const pressAt = Date.now()
    switcher.userPause()
    // The press's `pause` task runs before the click's: `onLocalPause` has
    // announced it by the time `selectQuality` latches `wasPlaying`.
    switcher.tick()
    selectQuality(switcher.el, switcher.ui, 'harness://switcher/360p', disarm)
    fastLoad(switcher)
    await room.advance(10)
    // From the press's own `paused: true` on: the wire stamps receipt, so the
    // heartbeat sent one link delay before the press lands on `pressAt` too.
    const sent = room.server.wire.filter((f) => f.username === 'switcher' && f.at >= pressAt)
    const press = sent.findIndex((f) => f.paused === true)
    expect(press, 'the press never reached the wire').toBeGreaterThan(-1)
    return sent.slice(press).filter((f) => f.paused === false).length
  }

  it('resumes the room nobody un-paused (✗ #498)', async () => {
    const [switcher, watcher] = await seatPlayingPair(true)
    const resumes = await pauseThenSwitch(switcher)

    expect(resumes).toBeGreaterThan(0)
    expect(switcher.el.paused).toBe(false)
    expect(watcher.el.paused).toBe(false)
    expect(room.server.roomState().paused).toBe(false)
  })

  it('stays paused without the autoplay model, so the model is what reproduces it', async () => {
    const [switcher, watcher] = await seatPlayingPair(false)
    const resumes = await pauseThenSwitch(switcher, 'none')

    expect(resumes).toBe(0)
    expect(switcher.el.paused).toBe(true)
    expect(watcher.el.paused).toBe(true)
    expect(room.server.roomState().paused).toBe(true)
  })

  it('still resumes with the disarm placed before the rebind: the load re-arms it', async () => {
    const [switcher, watcher] = await seatPlayingPair(true)
    const resumes = await pauseThenSwitch(switcher, 'before-rebind')

    expect(resumes).toBeGreaterThan(0)
    expect(switcher.el.paused).toBe(false)
    expect(watcher.el.paused).toBe(false)
  })

  it('leaves a gate-held element to the gate, which resumes it when the peer is ready', async () => {
    const [switcher, watcher] = await seatPlayingPair(true)
    // The switcher is paused only because a *peer* is not ready: `wasPlaying`
    // is false while the room plays.
    watcher.ui.setSyncplayLocalReady(false)
    await room.advance(2)
    expect(switcher.el.paused).toBe(true)
    expect(room.server.roomState().paused).toBe(false)

    selectQuality(switcher.el, switcher.ui, 'harness://switcher/360p')
    fastLoad(switcher)
    await room.advance(2)
    expect(switcher.el.paused).toBe(true)

    // The resume comes from `watch(syncplayRoomUsers)` when the peer flips, not
    // from the reload's `canplay`: `setSyncplayLocalReady` returns early on an
    // unchanged readiness, so `onLocalCanPlay` does not re-enter the gate.
    watcher.ui.setSyncplayLocalReady(true)
    await room.advance(3)
    expect(switcher.el.paused).toBe(false)
    expect(watcher.el.paused).toBe(false)
    expect(room.server.roomState().paused).toBe(false)
    // Neither the reload nor the resume was announced as the switcher's.
    expect(discreteSends(switcher)).toBe(0)
  })

  describe('solo, outside any room', () => {
    const soloSwitch = (disarm: Disarm = PLAYER_VIEW_DISARM): HarnessVideo => {
      const el = new HarnessVideo({
        position: ROOM_START,
        paused: false,
        readyState: HAVE_ENOUGH_DATA,
        autoplay: true
      })
      el.pause()
      expect(el.tick()).toEqual(['pause'])
      selectQuality(el, null, 'harness://solo/360p', disarm)
      el.readyState = HAVE_ENOUGH_DATA
      return el
    }

    // Solo rather than in the room on purpose: `HarnessVideo.reload()` queues a
    // `pause` for a playing element, which `onLocalPause` takes as intent and
    // which then outvotes the restore. That is the harness's reload model, older
    // than #498 and the same with or without the disarm, so a room case here
    // would pin it rather than the restore.
    it('keeps playing across a switch taken while playing', () => {
      const el = new HarnessVideo({
        position: ROOM_START,
        paused: false,
        readyState: HAVE_ENOUGH_DATA,
        autoplay: true
      })
      selectQuality(el, null, 'harness://solo/360p')
      el.readyState = HAVE_ENOUGH_DATA
      expect(el.paused).toBe(false)
      expect(el.tick()).toEqual(['pause', 'play', 'seeked'])
      expect(el.currentTime).toBe(ROOM_START)
    })

    it('autostarts after a pause → quality switch at any gap (✗ #498)', () => {
      const el = soloSwitch()
      expect(el.paused).toBe(false)
      expect(el.tick()).toContain('play')
    })

    it('autostarts with no disarm at all: nothing outside a room disarms it', () => {
      const el = soloSwitch('none')
      expect(el.paused).toBe(false)
      expect(el.tick()).toContain('play')
    })
  })
})

describe('PlayerView anchors for the #498 selectQuality model', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../../src/renderer/src/components/views/PlayerView.vue'),
    'utf8'
  )
  const body = SRC.slice(
    SRC.indexOf('function selectQuality('),
    SRC.indexOf('const TRANSLATION_TYPE_LABELS')
  )
  const flat = body.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')

  it('latches wasPlaying before the rebind and restores only on it', () => {
    expect(flat).toContain('const wasPlaying = video ? !video.paused : false;')
    expect(flat.indexOf('const wasPlaying')).toBeLessThan(
      flat.indexOf('activeStreamUrl.value = stream.url;')
    )
    expect(flat).toContain("if (wasPlaying) playProgrammatically(v, 'restore');")
  })

  it('carries a bare autoplay on the <video>, which every rebind re-arms', () => {
    const open = SRC.indexOf('<video\n')
    const video = SRC.slice(open, SRC.indexOf('>', open))
    expect(video).toMatch(/\n\s*autoplay\n/)
  })

  it('disarms in the nextTick only where the model says it does', () => {
    const tick = flat.slice(flat.indexOf('nextTick('))
    const disarm = 'if (!wasPlaying && v.paused) v.pause();'
    expect(tick.includes(disarm)).toBe(PLAYER_VIEW_DISARM === 'after-rebind')
    expect(flat.slice(0, flat.indexOf('nextTick(')).includes('v.pause()')).toBe(false)
  })
})
