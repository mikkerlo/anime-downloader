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
// **This file pinned #498 ✗ and now pins its fix.** `selectQuality` disarms in
// its `nextTick`, after the rebind: `if (!wasPlaying && v.paused) v.pause()`.
// The `'none'` cases below keep the pre-fix shape reproducible, so the harness's
// `autoplay` model stays proven able to see the bug.
//
// **Except before the first autostart (#509 review).** On mount playback rests
// on the bare `autoplay` alone, so for the whole initial load the element is
// paused with nobody having paused it. A switch taken there must not disarm the
// autostart the user is waiting for, so outside a session the disarm is skipped
// while `PlayerView`'s `awaitingFirstAutostart` latch is set. The
// `'after-rebind-unlatched'` cases keep the first cut of the fix, which had no
// latch, reproducible.
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
 *    load algorithm has re-armed the element, skipped while the first autostart
 *    is pending outside a session — what `PlayerView` does.
 *  - `'after-rebind-unlatched'`: the same place with no latch, the first cut of
 *    the #498 fix. Only here to show what the latch changes.
 *  - `'before-rebind'`: ahead of the patch, which the load algorithm then
 *    undoes. Only here to prove the order is what holds.
 */
type Disarm = 'none' | 'after-rebind' | 'after-rebind-unlatched' | 'before-rebind'

/** What `PlayerView.selectQuality` does today; the scan below holds it there. */
const PLAYER_VIEW_DISARM = 'after-rebind' as Disarm

/** Elements whose latch the disarm has cleared (`awaitingFirstAutostart = false`
 *  in the disarm's own branch). */
const disarmedLatch = new WeakSet<HarnessVideo>()

/**
 * `PlayerView`'s `awaitingFirstAutostart`, read off the element: a
 * `HarnessVideo` is constructed where `PlayerView` mounts, so the latch starts
 * set, and `onPlay` / `onPause` clear it on the first `play` / `pause` the
 * element delivers. The disarm clears it too.
 */
const awaitingFirstAutostart = (el: HarnessVideo): boolean =>
  !disarmedLatch.has(el) && !el.delivered.some((e) => e === 'play' || e === 'pause')

/** `PlayerView`'s `syncplaySessionLive()`; `ui` is `null` outside any room. */
const syncplaySessionLive = (ui: Pick<Peer['ui'], 'syncplayStatus'> | null): boolean => {
  const state = ui?.syncplayStatus.value.state ?? 'idle'
  return state !== 'idle' && state !== 'disconnected'
}

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
  if (disarm === 'after-rebind') {
    const autostartPending = awaitingFirstAutostart(el) && !syncplaySessionLive(ui)
    if (!wasPlaying && el.paused && !autostartPending) {
      disarmedLatch.add(el)
      el.pause()
    }
  }
  if (disarm === 'after-rebind-unlatched' && !wasPlaying && el.paused) el.pause()
  if (wasPlaying) {
    // `playProgrammatically(v, 'restore')`, #347 veto included.
    if (syncplaySessionLive(ui) && !ui!.shouldElementPlay()) return
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

  it('keeps the room paused: the switcher puts no paused: false on the wire', async () => {
    const [switcher, watcher] = await seatPlayingPair(true)
    const resumes = await pauseThenSwitch(switcher)

    expect(resumes).toBe(0)
    expect(switcher.el.paused).toBe(true)
    expect(watcher.el.paused).toBe(true)
    expect(room.server.roomState().paused).toBe(true)
  })

  it('resumes the room nobody un-paused without the disarm (the pre-fix shape)', async () => {
    const [switcher, watcher] = await seatPlayingPair(true)
    const resumes = await pauseThenSwitch(switcher, 'none')

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

  it('disarms a not-yet-started element in a live session, and the latch stays cleared after leaving', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: true })
    // Mounted into a paused room mid-load: the element has not started and has
    // delivered no `play` or `pause`, so the latch is still set.
    const switcher = await room.seat({
      username: 'switcher',
      position: ROOM_START,
      paused: true,
      readyState: 1,
      delayMs: DELAY_MS,
      autoplay: true
    })
    await room.seat({ username: 'watcher', position: ROOM_START, paused: true, delayMs: DELAY_MS })
    await room.advance(4)
    expect(switcher.el.paused).toBe(true)
    expect(awaitingFirstAutostart(switcher.el)).toBe(true)
    const before = Date.now()

    // In a session the disarm stands whatever the latch says: whether this
    // element plays is `shouldElementPlay()`'s call, and the room is paused.
    selectQuality(switcher.el, switcher.ui, 'harness://switcher/1080p')
    fastLoad(switcher)
    await room.advance(10)
    expect(switcher.el.paused).toBe(true)
    expect(awaitingFirstAutostart(switcher.el)).toBe(false)
    const sent = room.server.wire.filter((f) => f.username === 'switcher' && f.at >= before)
    expect(sent.filter((f) => f.paused === false)).toHaveLength(0)
    expect(room.server.roomState().paused).toBe(true)

    // The disarm cleared the latch, so a second switch after leaving the room
    // still disarms: this element was held, not waiting to autostart.
    switcher.client.disconnect()
    await room.advance(2)
    expect(syncplaySessionLive(switcher.ui)).toBe(false)
    selectQuality(switcher.el, switcher.ui, 'harness://switcher/720p')
    switcher.el.readyState = HAVE_ENOUGH_DATA
    expect(switcher.el.paused).toBe(true)
    expect(switcher.el.tick()).not.toContain('play')
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

    it('stays paused after a pause → quality switch', () => {
      const el = soloSwitch()
      expect(el.paused).toBe(true)
      expect(el.tick()).not.toContain('play')
    })

    it('autostarts with no disarm at all: nothing outside a room disarms it', () => {
      const el = soloSwitch('none')
      expect(el.paused).toBe(false)
      expect(el.tick()).toContain('play')
    })

    // The #509 review's case: an episode opened and switched 720p → 1080p
    // before the stream has started for the first time. The element is paused
    // only because the initial load has not reached HAVE_ENOUGH_DATA yet.
    const preStartSwitch = (
      switches: number,
      disarm: Disarm = PLAYER_VIEW_DISARM
    ): HarnessVideo => {
      const el = new HarnessVideo({ position: 0, paused: true, readyState: 1, autoplay: true })
      expect(awaitingFirstAutostart(el)).toBe(true)
      for (let i = 0; i < switches; i++) selectQuality(el, null, `harness://solo/${i}`, disarm)
      el.readyState = HAVE_ENOUGH_DATA
      return el
    }

    it('still autostarts after a switch taken before the first autostart', () => {
      const el = preStartSwitch(1)
      expect(el.paused).toBe(false)
      expect(el.tick()).toEqual(['play', 'seeked'])
      expect(awaitingFirstAutostart(el)).toBe(false)
    })

    it('still autostarts after two quick switches before the first autostart', () => {
      const el = preStartSwitch(2)
      expect(el.paused).toBe(false)
      expect(el.tick()).toContain('play')
    })

    it('stays paused before the first autostart without the latch (the first cut of the fix)', () => {
      const el = preStartSwitch(1, 'after-rebind-unlatched')
      expect(el.paused).toBe(true)
      expect(el.tick()).not.toContain('play')
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
    const disarm =
      'const autostartPending = awaitingFirstAutostart && !syncplaySessionLive(); ' +
      'if (!wasPlaying && v.paused && !autostartPending) { awaitingFirstAutostart = false; v.pause(); }'
    expect(tick.includes(disarm)).toBe(PLAYER_VIEW_DISARM === 'after-rebind')
    // Nothing pauses ahead of the rebind, where the load would re-arm it.
    expect(flat.slice(0, flat.indexOf('nextTick('))).not.toMatch(/\.pause\(\)/)
  })

  // The latch the model reads off `HarnessVideo.delivered`: set at mount, and
  // cleared only by the first `play` / `pause` and by the disarm above.
  const strip = (s: string): string => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')
  const fn = (name: string): string => {
    const start = SRC.indexOf(`function ${name}(`)
    return strip(SRC.slice(start, SRC.indexOf('\n}\n', start) + 2))
  }

  it('sets awaitingFirstAutostart once, at mount, and clears it in onPlay, onPause and the disarm', () => {
    expect(SRC).toContain('let awaitingFirstAutostart = true;')
    expect(SRC.match(/awaitingFirstAutostart = true/g)).toHaveLength(1)
    expect(SRC.match(/awaitingFirstAutostart = false;/g)).toHaveLength(3)
    expect(fn('onPlay')).toMatch(/^function onPlay\(\): void \{ awaitingFirstAutostart = false;/)
    expect(fn('onPause')).toMatch(/^function onPause\(\): void \{ awaitingFirstAutostart = false;/)
  })

  it('reads the same session term as the #347 restore veto', () => {
    expect(fn('syncplaySessionLive')).toBe(
      'function syncplaySessionLive(): boolean { const state = syncplay.syncplayStatus.value.state; ' +
        "return state !== 'idle' && state !== 'disconnected'; }"
    )
    expect(fn('playProgrammatically')).toContain(
      "if (kind === 'restore' && syncplaySessionLive() && !syncplay.shouldElementPlay()) return;"
    )
  })
})
