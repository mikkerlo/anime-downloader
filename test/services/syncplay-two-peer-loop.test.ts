// @vitest-environment happy-dom
//
// The two-peer harness, end to end (#361 step 3).
//
// Deliberately thin. `test/helpers/syncplay-two-peer.ts` is the subject here,
// not the syncplay protocol: the first four cases say "a user action on one
// peer's element reaches the other peer's element, through the real composable,
// the real preload bridge, the real IPC router, the real `SyncplayClient` and
// the modelled server" — the claim every fixture built on the harness rests on.
// The fifth and sixth pin the failure half of that bridge — both rejection
// shapes the harness's own copy of the `invoke` wrapper produces: the one a
// renderer sees when nobody handled the channel, and the one it sees when the
// handler threw.
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
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
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

  it('rejects an unhandled channel the way the shared mock does', async () => {
    // The loop's other rejection shape. `test/setup/electron-mock.ts` is the
    // source of truth for it, but a per-peer `vi.doMock('electron')` replaces
    // that module wholesale, so the harness carries its own copy of the wrapper
    // — and until this case nothing pinned that copy: mutating its
    // `Error invoking remote method` prefix left the whole suite green. A peer
    // graph registers `syncplay.ipc.ts`, `syncplay-broadcasts.ts` and
    // `settings.ipc.ts` and nothing else; `CHANNELS.APP_VERSION` is handled by
    // `src/main/ipc/app.ipc.ts`, which never loads here, so the channel is
    // genuinely unhandled — the same construction `test/ipc/syncplay-bridge.test.ts`
    // uses against the shared mock.
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    await expect(host.api.appVersion()).rejects.toThrow(
      `Error invoking remote method '${CHANNELS.APP_VERSION}': ` +
        `Error: No handler registered for '${CHANNELS.APP_VERSION}'`
    )
  })

  it('rejects a throwing handler the way the shared mock does', async () => {
    // The wrapper's *other* leg, and the one nothing pinned until now: swapping
    // the harness's `throw asRemoteError(err)` for a bare `throw err` left every
    // file that uses the harness green, so half of the copy was unobserved.
    //
    // Same construction as `test/ipc/syncplay-bridge.test.ts`, with one
    // difference that is the point of doing it here as well: that file drives a
    // `vi.fn()` client, and a peer graph holds the *real* `SyncplayClient` the
    // router closes over at module scope. So this is the real handler body
    // (`syncplay.disconnect()`) throwing, not a stub standing where it would be.
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })

    // `Once`, so the `dispose()` in `afterEach` still gets a real disconnect and
    // the socket is closed rather than leaked. Dropping it reds this case in
    // teardown — and only this case: `dispose()` drains its peers and rethrows,
    // so the throw stays here instead of reaching the next one.
    vi.spyOn(host.client, 'disconnect').mockImplementationOnce(() => {
      throw new Error('socket already gone')
    })

    // Asserted as the whole renderer-visible string, like the no-handler case
    // above: a caller that pattern-matches on `err.message` is matching this,
    // and the two shapes are only interchangeable with Electron's if both are.
    await expect(host.api.syncplayDisconnect()).rejects.toThrow(
      `Error invoking remote method '${CHANNELS.SYNCPLAY_DISCONNECT}': Error: socket already gone`
    )
  })

  // The six guards below are about the harness as an instrument rather than
  // about the loop: each one pins a way it used to mismodel or silently degrade,
  // and each fails on the previous behaviour.
  it('reports the in-flight seek target, not the pre-write position', () => {
    // The harness used to freeze the reading at the pre-write position for the
    // whole flight, and the crossfire fixture was built on that: a laggard
    // under-reporting its own lateness into the server's `min()` election. #368
    // captured the opposite against the stock build. Setting `currentTime`
    // updates the official playback position synchronously, so the getter hands
    // back the *target* while the seek is still pending and only readiness
    // lags — four drags 110 ms apart on a real seek bar each read back the
    // preceding target exactly (1107.7, then 1136.1, then 1164.5), where a
    // frozen element would have read the pre-drag 20.686 every time.
    //
    // So the sign of the modelled error was backwards: the harness had a
    // mid-seek peer announcing too low and winning the election, and reality
    // has it announcing too high and *losing* it. These three reads are that
    // correction, and every one of them read 101 before it.
    const el = new HarnessVideo({ position: 100, paused: false, seekLandMs: 6000 })
    vi.advanceTimersByTime(1000)
    expect(el.currentTime).toBeCloseTo(101, 6)

    el.currentTime = 645
    expect(el.currentTime).toBeCloseTo(645, 6)
    expect(el.seeking).toBe(true)
    // Readiness is what lags, not the position: the capture's mid-seek rows are
    // all `readyState` 1 with nothing buffered anywhere near the reported
    // position, which is exactly how the element gets into the election.
    expect(el.readyState).toBe(1)
    vi.advanceTimersByTime(1000)
    // A second write before the first lands replaces the target and the reading
    // follows it. The old model pinned 101 here for both writes.
    el.currentTime = 646
    expect(el.currentTime).toBeCloseTo(646, 6)

    // The interrupting write still replaces the target, and only one `seeked`
    // fires — an interrupted seek fires none of its own. 6 s after the *second*
    // write, the element lands on the second target.
    vi.advanceTimersByTime(6000)
    expect(el.tick()).toEqual(['seeked'])
    expect(el.currentTime).toBeCloseTo(646, 6)
  })

  it("hands back a reload's pause before the metadata that reopens the gate", () => {
    // This case passes `bindGapMs: 0` explicitly, and is the only one in the
    // suite that depends on the zero gap — the harness default is 500, which
    // would carry `loadedmetadata` past both of the 50 ms ticks sampled below
    // and empty the second batch. At a zero gap the HAVE_METADATA transition
    // used to be applied inside the same `tick()` that handed back the `pause`
    // `reload()` queued, so the caller — which dispatches a whole batch *after*
    // `tick()` returns — ran `onLocalPause` with the element already reporting
    // HAVE_METADATA. That is the inverse of a real element, where the load's
    // queued tasks run before the task that reaches HAVE_METADATA, and it is
    // the ordering this seam exists to model: the pause has to arrive at
    // `readyState` 0, which is what `hasAnnounceablePosition()`
    // (`src/renderer/src/composables/use-syncplay-client.ts:770`) and
    // `onLocalPause`'s own `readyState > 0` conjunct are both reading.
    //
    // Before the fix this read `[['pause', 'loadedmetadata'], []]` with
    // `readyState` 1 on the first batch. `readyStates` alone cannot tell the
    // two apart — it is `[1, 0, 1]` either way — so the batching is the
    // assertion, and the `readyState` sampled per batch is what the guards
    // downstream would have seen.
    const el = new HarnessVideo({ position: 100, paused: false, bindGapMs: 0 })
    el.reload('harness://ep-8')

    const batches: { events: string[]; readyStateAtDelivery: number }[] = []
    for (let i = 0; i < 2; i += 1) {
      vi.advanceTimersByTime(50)
      // Sampled after `tick()` returns and not inside it, because that is where
      // the harness's own `deliver()` reads it: every event in a batch is
      // dispatched into the composable at the `readyState` the tick left behind.
      batches.push({ events: el.tick(), readyStateAtDelivery: el.readyState })
    }

    expect(batches).toEqual([
      { events: ['pause'], readyStateAtDelivery: 0 },
      { events: ['loadedmetadata'], readyStateAtDelivery: 1 }
    ])
    // The landing is deferred, never dropped, and it still moves `readyState`.
    expect(el.readyStates).toEqual([1, 0, 1])
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

  it('tears down the rest of the room when one peer throws on disconnect', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()
    await room.advance(2)

    // A *permanent* throw — the shape the throwing-handler case above would
    // leave behind if it ever lost its `mockImplementationOnce`. `dispose()`
    // used to walk `peers` unguarded, so the host's throw abandoned the joiner
    // and skipped the `peers` reset; the next case's `room?.dispose()` then ran
    // the same throwing teardown a second time and red a case that was fine.
    vi.spyOn(host.client, 'disconnect').mockImplementation(() => {
      throw new Error('socket already gone')
    })
    const joinerDisconnect = vi.spyOn(joiner.client, 'disconnect')

    // Still surfaces on the caller that armed it, rather than being swallowed.
    expect(() => room.dispose()).toThrow('socket already gone')
    // The peer queued behind the thrower was torn down anyway (0 before).
    expect(joinerDisconnect).toHaveBeenCalledTimes(1)
    // And the room is drained, so the `afterEach` dispose is a no-op instead of
    // a second throw landing on whichever case runs next.
    expect(() => room.dispose()).not.toThrow()
  })

  it('defaults the bind gap into the clean cell, k = ceil(gap / HEARTBEAT_MS) === 1', () => {
    // The default itself, which nothing in the suite observed until now. Every
    // reload site seats an explicit gap — the two adoption reloads at
    // `syncplay-two-peer-adoption.test.ts:108` and
    // `syncplay-two-peer-adoption.test.ts:237` run under a
    // `syncplay-two-peer-adoption.test.ts:106 ("bindGapMs: 30_000")` seat, the
    // case above seats 0, and all six `goToEpisode` sites seat a literal through
    // `seat()` — so the fallback at
    // `test/helpers/syncplay-two-peer.ts:239 ("this.bindGapMs = opts.bindGapMs ?? 500")`
    // was free to be any number at all: editing it to 3000, the exact value that
    // option's doc block spends its longest paragraph calling a trap, left the
    // suite at 1822 passed across 122 files. The counterfactual that shipped with
    // the rename covers the opt-out at
    // `syncplay-two-peer-loop.test.ts:281 ("bindGapMs: 0")`, which shows the zero
    // gap stayed reachable — not that the default it opts out of is the right one.
    //
    // Pins the regime rather than the literal, because the regime is what that
    // block argues for: a positive gap is clean iff
    // `k = ceil(bindGapMs / HEARTBEAT_MS) === 1`, and `HEARTBEAT_MS` is 1000
    // (`src/main/syncplay.ts:19 ("const HEARTBEAT_MS = 1000")`). The two 300 ms
    // steps bracket that cell from both sides: a `k = 1` default lands
    // `loadedmetadata` inside the second of them, and any `k >= 2` one — 3000 is
    // `k = 3`, mid-drag, the regime where #360 pulls the non-switching peer
    // backwards — carries it past both and leaves that batch empty. So this holds
    // for any clean default and breaks for any dragging one, which is the property
    // being defended, rather than the number 500.
    const el = new HarnessVideo({ position: 100, paused: false })
    el.reload('harness://ep-8')

    const batches: string[][] = []
    for (let i = 0; i < 2; i += 1) {
      vi.advanceTimersByTime(300)
      batches.push(el.tick())
    }

    expect(batches).toEqual([['pause'], ['loadedmetadata']])
    // And the landing moved the gate rather than merely being queued behind it.
    expect(el.readyState).toBe(1)
  })
})
