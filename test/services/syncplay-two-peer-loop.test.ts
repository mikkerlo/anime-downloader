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
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
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
})
