// @vitest-environment happy-dom
//
// The two-peer harness, end to end (#361 step 3).
//
// Deliberately thin. `test/helpers/syncplay-two-peer.ts` is the subject here,
// not the syncplay protocol: these four cases say "a user action on one peer's
// element reaches the other peer's element, through the real composable, the
// real preload bridge, the real IPC router, the real `SyncplayClient` and the
// modelled server" — the claim every fixture built on the harness rests on.
// #362's bridge test covers one loop; this covers two of them side by side, and
// the scenario work lives in the files that use it
// (`syncplay-seek-crossfire.test.ts` is the first).
//
// What is *not* here on purpose: anything the harness does not model (the
// header lists them), and anything that is really a unit assertion about the
// composable — the 205 cases in
// `test/renderer/composables/use-syncplay-client.test.ts` are cheaper and
// sharper for that, and duplicating them here would buy a slower copy.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { createTwoPeerRoom, HarnessVideo } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const DELAY_MS = 50

describe('two-peer syncplay harness', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  const seatBoth = async (
    opts: { hostPaused?: boolean; joinerPosition?: number } = {}
  ): Promise<
    [Awaited<ReturnType<TwoPeerRoom['seat']>>, Awaited<ReturnType<TwoPeerRoom['seat']>>]
  > => {
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: opts.hostPaused ?? false,
      delayMs: DELAY_MS
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: opts.joinerPosition ?? ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    return [host, joiner]
  }

  it('seats two peers who announce the same file, go ready and adopt playback', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()

    await room.advance(4)

    // Main-side: both connected and both driving rather than mirroring.
    expect(host.status().state).toBe('ready')
    expect(joiner.status().state).toBe('ready')
    expect(host.status().playbackAdopted).toBe(true)
    expect(joiner.status().playbackAdopted).toBe(true)

    // Renderer-side: the roster arrived over `EVENT_CHANNELS.SYNCPLAY_ROOM_USERS`
    // and each peer's composable can see the other. Announced by the composable
    // itself, not by the fixture — `getAnimeName` / `getCurrentEpisodeInt` are
    // what `setFile` was built from.
    expect(host.ui.syncplayRoomUsers.value.map((u) => u.username).sort()).toEqual([
      'hostuser',
      'joinuser'
    ])
    expect(host.ui.syncplayRoomUsers.value.every((u) => u.file?.name === 'Some Anime - 7')).toBe(
      true
    )

    // And both elements are playing the room's position, not their own.
    expect(host.el.paused).toBe(false)
    expect(joiner.el.paused).toBe(false)
    expect(Math.abs(host.el.currentTime - joiner.el.currentTime)).toBeLessThan(1)
  })

  it('carries a pause on one peer to the other peer element', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()
    await room.advance(4)
    expect(joiner.el.paused).toBe(false)

    // The user hits pause on the host. Nothing is armed, so the element's queued
    // `pause` is classified as the user's and leaves through
    // `sendLocalState('pause')`.
    host.userPause()
    await room.advance(1)

    expect(room.server.roomState().paused).toBe(true)
    expect(joiner.el.paused).toBe(true)
    // The far side paused because it was *told* to, and its composable can name
    // who did it — the `room-event` leg of the bridge, which no single-peer test
    // can produce because it needs a second username in the room.
    expect(joiner.ui.syncplayPausedBy.value).toBe('hostuser')
    expect(joiner.ui.shouldElementPlay()).toBe(false)

    // And back again: a resume on the same peer releases the other one.
    host.userPlay()
    await room.advance(1)
    expect(room.server.roomState().paused).toBe(false)
    expect(joiner.el.paused).toBe(false)
  })

  it('carries a seek on one peer to the other peer element', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()
    await room.advance(4)

    host.userSeek(900)
    await room.advance(2)

    // The joiner's element was written, once, to the host's target — the
    // `doSeek: true` arm of the apply rule, all the way from a scrubber drag on
    // the other peer.
    expect(joiner.el.seekWrites).toHaveLength(1)
    expect(joiner.el.seekWrites[0]).toBeGreaterThan(899)
    expect(joiner.el.currentTime).toBeGreaterThan(899)
    expect(room.server.roomState().position).toBeGreaterThan(899)
  })

  it('keeps each peer on its own bridge, sockets and client', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()
    await room.advance(2)

    // The property the whole helper is built to get: two module graphs, so the
    // `syncplay` singleton `src/main/ipc/syncplay.ipc.ts` imports at module
    // scope is a *different* singleton on each side, and so is the preload
    // `api` object the composable was handed.
    expect(host.client).not.toBe(joiner.client)
    expect(host.api).not.toBe(joiner.api)

    // And the broadcasts went to their own renderer rather than to a registry
    // keyed by channel name and shared by both.
    const remoteStates = (peer: typeof host): unknown[] =>
      peer.broadcasts.filter((b) => b.channel === EVENT_CHANNELS.SYNCPLAY_REMOTE_STATE)
    expect(remoteStates(host).length).toBeGreaterThan(0)
    expect(remoteStates(joiner).length).toBeGreaterThan(0)
    expect(host.broadcasts).not.toBe(joiner.broadcasts)
  })

  // The three guards below are about the harness as an instrument rather than
  // about the loop: each one pins a way it used to mismodel or silently degrade,
  // and each fails on the previous behaviour.
  it('freezes a stalled element at the first in-flight write, not the latest', () => {
    // A second `currentTime` write arriving before the first lands used to
    // re-read `live()` into `stalled`, and `live()` walks from the *old* anchor
    // — so the reported position un-froze and jumped forward by however long the
    // first seek had been pending. This read 102 before the fix. A real element
    // stays where the first seek left it until one of them lands, and the
    // crossfire fixture depends on it: a laggard drifting forward while stalled
    // under-reports its own lateness into the server's `min()` election.
    const el = new HarnessVideo({ position: 100, paused: false, seekLandMs: 6000 })
    vi.advanceTimersByTime(1000)
    expect(el.currentTime).toBeCloseTo(101, 6)

    el.currentTime = 645
    expect(el.currentTime).toBeCloseTo(101, 6)
    vi.advanceTimersByTime(1000)
    el.currentTime = 646
    expect(el.currentTime).toBeCloseTo(101, 6)

    // The interrupting write still replaces the target, and only one `seeked`
    // fires — an interrupted seek fires none of its own. 6 s after the *second*
    // write, the element lands on the second target.
    vi.advanceTimersByTime(6000)
    expect(el.tick()).toEqual(['seeked'])
    expect(el.currentTime).toBeCloseTo(646, 6)
  })

  it('refuses a re-entrant seat() rather than cross-wiring two peers', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    // Two seats in flight at once interleave `vi.resetModules()` and the
    // `window.api` swap over one module registry. That used to type-check and
    // hand back two silently cross-wired peers; now it throws.
    const first = room.seat({ username: 'hostuser', position: ROOM_START, delayMs: DELAY_MS })
    await expect(
      room.seat({ username: 'joinuser', position: ROOM_START, delayMs: DELAY_MS })
    ).rejects.toThrow(/not re-entrant/)
    await first
  })

  it('refuses an advance() that is not a whole number of slices', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    // `Math.round` on the step count used to make a non-multiple silently
    // shorter than asked — `advance(0.07)` ran 50 ms, not 70 — so a fixture's
    // quoted `t=` numbers could drift from its own prose with nothing to point
    // at. Clean multiples still pass, including the float-inexact ones.
    await expect(room.advance(0.07)).rejects.toThrow(/whole number of slices/)
    await expect(room.advance(15.95)).resolves.toBeUndefined()
  })
})
