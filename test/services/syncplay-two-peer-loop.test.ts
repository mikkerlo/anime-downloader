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
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
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

  // The ten guards below — every remaining `it` in *this* `describe` — are about
  // the harness as an instrument rather than about the loop: each one pins a way
  // it used to mismodel or silently degrade, and each fails on the previous
  // behaviour. #390's call-site census is a second top-level `describe` at the
  // foot of the file rather than an eleventh guard here, and the scoping clause
  // is the reason this count did not have to move for it: it reads source text,
  // not the harness. Counting `it(` from here to EOF now gives eleven.
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

  it('defaults the bind gap to a clean positive one — not 0, not the drag regime', () => {
    // The default itself, which nothing in the suite observed until now. Every other
    // reload site seats an explicit gap — the two adoption reloads at
    // `syncplay-two-peer-adoption.test.ts:108` and
    // `syncplay-two-peer-adoption.test.ts:237` run under their own
    // `syncplay-two-peer-adoption.test.ts:106 ("bindGapMs: 30_000")` and
    // `syncplay-two-peer-adoption.test.ts:226 ("bindGapMs: 30_000")` seats, the
    // case above seats 0, and nine of the ten `goToEpisode` call sites across
    // the suite rebind a switcher that was seated on a literal — the tenth is
    // the rejection guard below, which never reaches `reload()` at all — so the
    // fallback at
    // `test/helpers/syncplay-two-peer.ts:239 ("this.bindGapMs = opts.bindGapMs ?? 500")`
    // was free to be any number at all: editing it to 3000, the exact value that
    // option's doc block spends its longest paragraph calling a trap, left the
    // suite at 1822 passed across 122 files. That figure is **historical and no
    // longer reproducible**, in both of its halves, and the sentence would be
    // misleading without saying so: it was measured before this case existed —
    // which is the whole of why it is quoted, nothing caught the edit — and the
    // suite has grown past 1822 since. Re-running the mutation today does not
    // hand back a different pass count, it reds *this* case by construction.
    // Do not refresh the number; it is evidence about a tree that had no guard
    // here, and refreshing it would quietly turn it into a claim about one that
    // does. The counterfactual that shipped with
    // the rename covers the opt-out at
    // `syncplay-two-peer-loop.test.ts:287 ("bindGapMs: 0")`, which shows the zero
    // gap stayed reachable — not that the default it opts out of is the right one.
    //
    // "Reload site" rather than "seat", because the two populations differ and
    // only the first one can observe the fallback. Plenty of seats take the
    // `?? 500` silently — `seatSwitchScenario`'s joiner below passes no
    // `bindGapMs`, and neither does the innocent peer in
    // `syncplay-two-peer-episode-change.test.ts`'s `seatPair` nor the joiner in
    // the adoption file's switch fixture. All of them are inert, for one
    // reason: `bindGapMs` is read in exactly one place,
    // `test/helpers/syncplay-two-peer.ts:393 ("this.metadataDueAt = Date.now() + this.bindGapMs")`
    // inside `HarnessVideo.reload()`, and a peer that never reloads never
    // reaches it. So the value they inherit is unobservable rather than
    // pinned, and moving the default cannot red them.
    //
    // Both counts in this file are the same kind of thing and rot together:
    // this one and the guard census in the block comment above the first guard
    // ("The ten guards below"). This very change re-derived that one from six
    // to ten and walked past this one — 136 lines away, still reading six —
    // which review caught and no gate would have. Re-derive the pair.
    //
    // Pins a band around the default rather than the whole clean cell, and the
    // band is what the batching can actually resolve: a positive gap is clean iff
    // `k = ceil(bindGapMs / HEARTBEAT_MS) === 1`, `HEARTBEAT_MS` being 1000
    // (`src/main/syncplay.ts:19 ("const HEARTBEAT_MS = 1000")`), but a gap shorter
    // than one step is invisible here — a reload queues `pause`, and `tick()`
    // holds metadata back while that queue is non-empty
    // (`test/helpers/syncplay-two-peer.ts:429 ("this.queued.length === 0")`), so
    // 0 and 300 both land in the second batch and read the same. Landing in the
    // *third* of three 200 ms steps is what says the gap outlived a step it was
    // given the chance to beat. The case therefore holds for a gap in (400, 600]
    // and reds on both sides: on a revert to the old `0` default, and on any
    // `k >= 2` one — 3000 is `k = 3`, mid-drag, the regime where #360 pulls the
    // non-switching peer backwards.
    const el = new HarnessVideo({ position: 100, paused: false })
    el.reload('harness://ep-8')

    const batches: string[][] = []
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(200)
      batches.push(el.tick())
    }

    expect(batches).toEqual([['pause'], [], ['loadedmetadata']])
    // And the landing moved the gate rather than merely being queued behind it.
    expect(el.readyState).toBe(1)
  })

  /**
   * Seat the 500 ms switch scenario `syncplay-two-peer-adoption.test.ts:285`
   * runs — room at 300, both peers there, `advance(4)` of agreement, the
   * switcher on the shipped bind gap — and hand back the switcher plus a log
   * the four cases below read.
   *
   * The log is built **here rather than in the helper**, and by wrapping the
   * *method* rather than replacing the handle: the composable resolves its
   * bridge once, at setup, and never re-reads it
   * (`src/renderer/src/composables/use-syncplay-client.ts:270` ("const api: SyncplayBridgeApi = deps.api ?? window.api")), so
   * `peer.api = {…}` would hand the wrapper to nobody and leave a green case
   * sampling an empty array. Writing one property on the retained object is
   * seen, because the push site reads `api.syncplaySetFile` at call time.
   *
   * Three of the four cases below assert the log is **non-empty**, and those
   * three are the wrapper's own guard: rebuild it as
   * `switcher.api = { ...switcher.api, syncplaySetFile: spy }` and all three go
   * red on `toHaveLength(1)` against an empty array. The fourth cannot be that
   * guard, because its central assertion is `expect(pushes).toEqual([])` — an
   * **empty** log is exactly what an unseen wrapper produces, so that rewrite
   * leaves it green while it has quietly stopped testing the announce half at
   * all. That is why its `expect(switcher.episode()).toBe('7')` is
   * load-bearing rather than a second opinion: it is the only assertion in the
   * throwing case that holds independently of whether the wrapper ever fires.
   */
  const seatSwitchScenario = async (): Promise<{
    switcher: Awaited<ReturnType<TwoPeerRoom['seat']>>
    pushes: { at: number; readyStateAtPush: number; episodeInt: string }[]
  }> => {
    const switcher = await room.seat({
      username: 'hostuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS,
      bindGapMs: 500
    })
    await room.seat({
      username: 'joinuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)

    const pushes: { at: number; readyStateAtPush: number; episodeInt: string }[] = []
    const realSetFile = switcher.api.syncplaySetFile.bind(switcher.api)
    switcher.api.syncplaySetFile = (file) => {
      pushes.push({
        at: room.elapsed(),
        readyStateAtPush: switcher.el.readyState,
        episodeInt: file.episodeInt
      })
      return realSetFile(file)
    }
    return { switcher, pushes }
  }

  it('bumps the episode index and flushes it before rebinding the element', async () => {
    // The seventh harness guard, and the only one whose subject is an *ordering*
    // the helper used to be unable to express at all.
    //
    // In the app, `PlayerView.vue:2279` writes `activeEpisodeIndex.value =
    // targetIndex` and every source write below it sits behind an `await` on
    // `window.api.playerFindLocalFile(…)` / `playerGetStreamUrl(…)`. The
    // episode-change watcher
    // (`src/renderer/src/composables/use-syncplay-client.ts:1882`) is a default
    // **pre-flush** `watch`, so Vue's scheduler runs it inside that suspension —
    // against the element still bound to the *old* episode, at HAVE_METADATA.
    // The helper had no suspension, so the watcher only ever ran after
    // `reload()` had already dropped the element to HAVE_NOTHING, and no fixture
    // on this harness had ever seen the shipped shape.
    //
    // `readyState` at the push is the discriminator, and it is the only one:
    //
    //   | `goToEpisode` form                   | `readyStateAtPush` |
    //   | ------------------------------------ | ------------------ |
    //   | `reload()` then bump (as shipped)    | 0                  |
    //   | bump then `reload()`, still sync     | 0                  |
    //   | bump, `await flushPromises()`, reload| 1                  |
    //
    // The middle row is why this case samples the element rather than the wire.
    // The watcher is pre-flush and therefore *queued*, so it runs after both
    // statements whichever order they appear in — swapping the two lines is
    // observably nothing, and an acceptance test that a reorder satisfies is the
    // no-op this guard exists to rule out. Nothing cheaper separates the three:
    // the watcher's other three calls (`clearPendingUserPause()`,
    // `bumpPlaybackSourceGeneration()`, `resetRemoteStateTracking()`) touch no
    // element at all; the push's own duration read is
    // `src/renderer/src/composables/use-syncplay-client.ts:721` ("const dur =
    // deps.getVideoEl()?.duration || deps.getDuration() || 0") and `reload()`
    // never writes `duration`, so it is identical in all three; both forms send
    // inside the same 50 ms slice at the same `Date.now()`, so neither the wire
    // nor `MinElectionServer` separates them; and `el.readyStates` is `[1, 0, 1]`
    // in all three, the trap the reload-batching case above already writes down.
    room = await createTwoPeerRoom({ position: 300, paused: false })
    const { switcher, pushes } = await seatSwitchScenario()

    await switcher.goToEpisode('8')
    await room.advance(6)

    // The wrapper fired — see `seatSwitchScenario`'s note on why this is not a
    // formality — and it fired once: the transition-into-ready push
    // (`src/renderer/src/composables/use-syncplay-client.ts:2182`, the
    // `pushSyncplayFile()` inside `watch(syncplayStatus, …)` under
    // `if (status.state === 'ready' && !wasReady)`) and the mount-time one
    // (`src/renderer/src/composables/use-syncplay-client.ts:2305 ("if (syncplayStatus.value.state === 'ready') pushSyncplayFile()")`,
    // inside `onMounted`) are both spent by the `advance(4)` above, so this one
    // is the watcher's. Each anchor carries the construct it lands in because
    // the two were paired the wrong way round here until #384, and nothing
    // would have caught it: `check:line-citations` verifies that a marked
    // citation's quote matches its line, never that the label the prose hangs
    // on it is the right one.
    expect(pushes).toHaveLength(1)
    expect(pushes[0].episodeInt).toBe('8')
    expect(pushes[0].readyStateAtPush).toBe(1)
    // The flush costs no fake time: the announce still lands on the switch
    // instant, the 4 s mark `seatSwitchScenario` leaves the room at, and not a
    // slice later. So `readyState` above is the *only* thing the flush moves,
    // which is what makes it the discriminator rather than one of several.
    expect(pushes[0].at).toBe(4000)

    // And the switch still happened, on the far side of the flush: the element
    // rebound, dipped to HAVE_NOTHING and came back. Plus the switch footprint
    // `syncplay-two-peer-adoption.test.ts` reads off this same scenario, so a
    // flush that moved the scenario rather than only its ordering reds here as
    // well as there.
    expect(switcher.el.loads).toEqual(['harness://initial', 'harness://hostuser/ep-8'])
    expect(switcher.el.readyStates).toEqual([1, 0, 1])
    expect(switcher.el.seekWrites).toHaveLength(1)
    expect(switcher.el.seekWrites[0]).toBeCloseTo(302, 2)
    expect(room.server.roomState().position).toBeCloseTo(306.5, 1)
  })

  it('is additive at suspendMs = 0 — the same push and the same switch footprint', async () => {
    // What makes the third parameter safe to add to six existing call sites: at
    // `0`, the default, it is the flush-only form and nothing else. Every literal
    // below is copied from the case above on purpose — the claim is that the two
    // calls are indistinguishable, so a divergence has to red one of them.
    room = await createTwoPeerRoom({ position: 300, paused: false })
    const { switcher, pushes } = await seatSwitchScenario()

    await switcher.goToEpisode('8', undefined, 0)
    await room.advance(6)

    expect(pushes).toHaveLength(1)
    expect(pushes[0].episodeInt).toBe('8')
    expect(pushes[0].readyStateAtPush).toBe(1)
    expect(switcher.el.loads).toEqual(['harness://initial', 'harness://hostuser/ep-8'])
    expect(switcher.el.readyStates).toEqual([1, 0, 1])
    expect(switcher.el.seekWrites).toHaveLength(1)
    expect(switcher.el.seekWrites[0]).toBeCloseTo(302, 2)
    expect(room.server.roomState().position).toBeCloseTo(306.5, 1)
  })

  it('keeps the switcher on the old episode for the whole of a non-zero suspension', async () => {
    // The parameter's reason for existing. In the app the index bump and the
    // source write are separated by real IPC — `window.api.playerFindLocalFile(…)`
    // or `playerGetStreamUrl(…)` — and the room does not stop for it: peers keep
    // ticking, frames keep arriving, and the switcher is still bound to the
    // **previous** episode's element the whole time, having already announced
    // the new one. `suspendMs` is that interval, and it runs through the room's
    // own `advance()` rather than a bare `vi.advanceTimersByTimeAsync`, so each
    // 50 ms slice still delivers every peer's media events and drains the
    // watchers — a bare timer jump would elapse the suspension with no frames
    // delivered at all, which is the blindness this whole parameter exists to
    // remove.
    room = await createTwoPeerRoom({ position: 300, paused: false })
    const { switcher, pushes } = await seatSwitchScenario()

    // Sampled per slice through the element's own `tick()`, which `seat()`'s
    // `deliver()` calls once per peer per slice. Only the samples taken *inside*
    // the `await` below are collected, because nothing else is running then.
    const samples: { src: string; readyState: number; pushesSoFar: number }[] = []
    const realTick = switcher.el.tick.bind(switcher.el)
    switcher.el.tick = () => {
      samples.push({
        src: switcher.el.src,
        readyState: switcher.el.readyState,
        pushesSoFar: pushes.length
      })
      return realTick()
    }

    await switcher.goToEpisode('8', undefined, 500)

    // Ten slices of 50 ms, and on every one of them the element is still the old
    // episode's, still at HAVE_METADATA — while the new episode has already been
    // announced. That pairing is the whole shape: the room has been told about
    // episode 8 and the element is still playing episode 7.
    expect(samples).toHaveLength(10)
    expect(samples.every((s) => s.src === 'harness://initial')).toBe(true)
    expect(samples.every((s) => s.readyState === 1)).toBe(true)
    expect(samples.every((s) => s.pushesSoFar === 1)).toBe(true)

    // And the rebind did land, once the suspension elapsed.
    expect(switcher.el.loads).toEqual(['harness://initial', 'harness://hostuser/ep-8'])
    expect(switcher.el.readyState).toBe(0)
  })

  it('refuses a suspension that is not a whole number of slices, and switches nothing', async () => {
    // A rounded suspension is deliberately not smoothed over: it would silently
    // run a different scenario than the one the caller wrote down, and the
    // crossfire timings on this harness are quoted to the slice.
    //
    // The teeth are below the throw, not on it. `rejects.toThrow` alone passes
    // against *both* placements of the check — at the top of `goToEpisode`, and
    // down inside the `advance()` call between the flush and the reload — and
    // those two are not the same helper. Validated late, `episodeInt = ep`, the
    // index bump and `await flushPromises()` have all already run when it
    // throws: the watcher has fired and the renderer has announced episode 8
    // while `el` still holds episode 7's source. That is the half-switched state
    // a late check would *leave behind* — no successful call ends in it, and
    // this case keeps asserting after catching the rejection, so it would be
    // asserting against a peer the helper can otherwise never hand it.
    //
    // "Leaves behind" is the load-bearing word, because the case 40 lines above
    // asserts that exact state on all ten of its slices: a `suspendMs > 0` call
    // *passes through* it deliberately, for the whole suspension, and then exits
    // it at the rebind. What no successful call produces is that state as a
    // terminal one. A late throw strands the peer there.
    //
    // Two of the four assertions after the `await expect` tell the two
    // placements apart, and it is worth naming which. Against the late
    // placement, `advance(0.12)` throws before any slice runs and before
    // `el.reload()`, so `expect(pushes).toEqual([])` goes red on the watcher's
    // push and `expect(switcher.episode()).toBe('7')` goes red on the `'8'` the
    // bump already wrote. The other two — `switcher.el.loads` and
    // `switcher.el.readyState` — are green under *both* placements, because
    // neither placement reaches `reload()`. They pin that the element was left
    // untouched, which is a statement about the call's footprint rather than
    // about where the guard sits.
    room = await createTwoPeerRoom({ position: 300, paused: false })
    const { switcher, pushes } = await seatSwitchScenario()

    await expect(switcher.goToEpisode('8', undefined, 120)).rejects.toThrow(
      'goToEpisode(8, …, 120): suspendMs must be a whole number of 50ms slices'
    )

    // Nothing announced. This is the index bump's observable: a bump that had
    // been flushed would have woken the episode-change watcher, and the
    // watcher's whole job is a file push — which the wrapper would have caught,
    // carrying `episodeInt: '8'` at `readyStateAtPush: 1`. An empty log is the
    // statement that the write never happened.
    expect(pushes).toEqual([])
    // Nothing rebound, and nothing even renamed: the peer still reports the
    // episode it was seated on, so `episodeInt = ep` did not run either.
    expect(switcher.episode()).toBe('7')
    expect(switcher.el.loads).toEqual(['harness://initial'])
    expect(switcher.el.readyState).toBe(1)
  })
})

// --- the `goToEpisode()` call-site census (#390) -----------------------------
//
// Four of the guards above rule out the pre-#384 ordering, and each drives its
// own correctly-awaited call — so deleting one `await` anywhere else in the glob
// restores that ordering on the site that lost it while all four stay green.
// Nothing in the toolchain catches that, which was checked rather than assumed:
// `eslint.config.mjs:22 ("...tseslint.configs.recommended,")` is the untyped
// preset, and `eslint.config.mjs:29 ("parserOptions: {")` carries no `project`
// or `projectService`, so `no-floating-promises` cannot be turned on as
// configured; `npm run typecheck` is indifferent to a dropped `await` on a
// `Promise<void>`.
//
// This census is the whole of the first half and stands on its own: how many
// call sites exist, per file, before anything classifies them. Per
// `docs/testing.md:323 ("Pin the count, never just loop over the set")` a scan
// that only walks the occurrences it finds goes green on an eleventh site it
// never sees, so the count is the assertion and the prefix check is layered on
// top of it.
//
// The census is per-file rather than a single total on purpose. A subtly wrong
// blanking pass reads `adoption: expected 1, got 0` — unmistakably a stripper
// bug — where a bare total reads `expected 10, got 8` next to a message
// inviting whoever sees it to re-derive the pin to 8, which is exactly the *no
// unguarded sites* versus *no sites at all* confusion the rule above is about.
//
// Unrelated, and named here because the issue title says "every call site":
// `src/renderer/src/components/views/PlayerView.vue` has its own `goToEpisode()`
// — a different function, called un-awaited on purpose at
// `src/renderer/src/components/views/PlayerView.vue:1783`,
// `src/renderer/src/components/views/PlayerView.vue:1786` and
// `src/renderer/src/components/views/PlayerView.vue:2442`.
// Nothing in this glob reaches it and nothing here should grow to cover it.

const SIBLING_PREFIX = 'syncplay-two-peer-'
const SIBLING_SUFFIX = '.test.ts'
const CALL_NEEDLE = 'goToEpisode('

/**
 * Blanks every comment and every string *body* in one left-to-right pass,
 * keeping newlines and the string delimiters so that byte offsets — and
 * therefore line numbers — survive for the `file:line` reporting below.
 *
 * Both halves are load-bearing and the comment half is the harder one.
 *
 * Comments: raw text carries matches that are not call sites, and did before
 * this guard added any of its own. On trunk `f33fac1d`, three of the thirteen
 * raw matches were not call sites —
 * `test/services/syncplay-two-peer-episode-change.test.ts:260` and
 * `test/services/syncplay-two-peer-episode-change.test.ts:496` are
 * prose, and `test/services/syncplay-two-peer-loop.test.ts:660` is the expected
 * error string of the rejection guard whose call site on the line *above* it
 * must stay counted. That adjacency is the sharpest single test of this pass.
 * Those two numbers are historical and deliberately not pinned anywhere: this
 * docstring and the failure message below name the call often enough that the
 * live raw count is now well above 13, which is exactly why `RAW_CENSUS` is
 * reported and never asserted.
 *
 * Strings: this also neutralises `CALL_NEEDLE` and every failure message that
 * quotes it, which is why the host file stays in the glob. Excluding it instead
 * would drop the loop file's own four sites — 40% of the census — from the
 * guard, so the two are not interchangeable.
 *
 * The pass is quote-aware, i.e. a `//` inside a string literal does not open a
 * comment, and that is not a refinement — it decides the number. The glob
 * carries 16 `harness://` string literals — the mention on this line is prose,
 * not a seventeenth — at
 * `test/services/syncplay-two-peer-loop.test.ts:551`,
 * `test/services/syncplay-two-peer-loop.test.ts:572`,
 * `test/services/syncplay-two-peer-loop.test.ts:620`,
 * `test/services/syncplay-two-peer-adoption.test.ts:242`,
 * `test/services/syncplay-two-peer-adoption.test.ts:330` and elsewhere. A
 * quote-unaware `//` rule truncates `toEqual(['harness:` mid-expression and
 * leaves an unterminated quote that the string pass then swallows forward across
 * real call sites: measured on this tree, that variant reports 8 rather than 10
 * and takes the adoption file's only site to 0. This is the same carve-out
 * `test/renderer/components/player-lifecycle-scope.test.ts:90` documents for
 * `stripComments`, re-implemented here rather than lifted —
 * `test/renderer/components/player-lifecycle-scope.test.ts:107`'s docstring
 * scopes that helper to one file and it copies string bodies through verbatim,
 * so it supplies neither half on its own. Promoting it is a separate change with
 * its own review surface.
 *
 * Inherited precondition, and the reason it is written down: a regex literal
 * carrying a quote, a `//` or a `/*` desynchronises this pass, silently. It
 * holds on this tree — the only regex literals in the glob are
 * `test/services/syncplay-two-peer-loop.test.ts:315` and
 * `test/services/syncplay-two-peer-loop.test.ts:325`, and neither
 * `/not re-entrant/` nor `/whole number of slices/` carries any of the three —
 * and this guard's own needle keeps it that way. A fact about the current glob,
 * not a property anything enforces. A template substitution containing a
 * backtick would desynchronise it the same way; the three `${…}` in this file
 * are ordinary one-level interpolations.
 */
function blankCommentsAndStrings(text: string): string {
  const out = text.split('')
  const wipe = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === ch) break
        j++
      }
      // Body only — the delimiters stay, so offsets do not shift.
      wipe(i + 1, j)
      i = j + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      const end = nl === -1 ? text.length : nl
      wipe(i, end)
      i = end
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? text.length : close + 2
      wipe(i, end)
      i = end
      continue
    }
    i++
  }
  return out.join('')
}

const SIBLINGS = readdirSync(__dirname)
  .filter((f) => f.startsWith(SIBLING_PREFIX) && f.endsWith(SIBLING_SUFFIX))
  .sort()
  .map((f) => {
    const raw = readFileSync(resolve(__dirname, f), 'utf8')
    return {
      path: 'test/services/' + f,
      key: f.slice(SIBLING_PREFIX.length, f.length - SIBLING_SUFFIX.length),
      raw,
      blanked: blankCommentsAndStrings(raw)
    }
  })

const occurrences = (text: string): number => text.split(CALL_NEEDLE).length - 1

const censusOf = (pick: (s: (typeof SIBLINGS)[number]) => string): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const s of SIBLINGS) {
    const n = occurrences(pick(s))
    if (n > 0) out[s.key] = n
  }
  return out
}

// Derived inside the run rather than pinned, because pinning it would red on the
// prose that legitimately names the call — and a comment mentioning
// `goToEpisode()` staying green is one of this guard's four mutation controls.
// It is reported alongside the assertion so the raw/blanked split is visible to
// whoever the pin reds, rather than being a number they cannot reproduce.
const RAW_CENSUS = censusOf((s) => s.raw)

// Derived on trunk `f33fac1d`, where raw read 13 (adoption 1, episode-change 7,
// loop 5) and blanked read 10. Only the blanked half is a pin; this guard's own
// prose has raised the raw half since, and is expected to. Files with no call
// site are absent rather than zero, so a new sibling only enters this map once it
// actually calls the helper.
const BLANKED_CENSUS: Record<string, number> = {
  adoption: 1,
  'episode-change': 5,
  loop: 4
}

describe('goToEpisode() call sites across the two-peer glob', () => {
  it('finds exactly the pinned per-file census in comment- and string-blanked source', () => {
    expect(
      SIBLINGS.length,
      `no ${SIBLING_PREFIX}*${SIBLING_SUFFIX} sibling was read`
    ).toBeGreaterThan(0)

    const blanked = censusOf((s) => s.blanked)

    expect(
      blanked,
      [
        `The per-file \`${CALL_NEEDLE}\` census moved.`,
        `  raw, unblanked (informational): ${JSON.stringify(RAW_CENSUS)}`,
        `  blanked (the assertion):        ${JSON.stringify(blanked)}`,
        `  pinned:                         ${JSON.stringify(BLANKED_CENSUS)}`,
        `Scanned ${SIBLINGS.length} files: ${SIBLINGS.map((s) => s.path).join(', ')}`,
        'A key that went DOWN — `adoption` reaching 0 above all — is a bug in',
        '`blankCommentsAndStrings`, not a census change. Fix the pass; do not',
        're-derive the pin to match it.',
        'A key that went UP, or a new key, is a real change: a new call site, or a',
        `new ${SIBLING_PREFIX}*${SIBLING_SUFFIX} file, which this glob picks up on`,
        'purpose and which reds this literal until someone re-derives it.'
      ].join('\n')
    ).toEqual(BLANKED_CENSUS)
  })
})
