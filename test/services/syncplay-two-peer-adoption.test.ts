// @vitest-environment happy-dom
//
// Adoption, the spectator mirror, and staleness, across two peers (#361 step 4).
//
// The three sibling files all run peers that agree with the room: they are
// about what a peer *says* when it is a full participant. This one is about the
// peer that is not one yet, or has stopped being one — the state
// `src/main/syncplay.ts` calls a spectator mirror, where `buildPlaystate` stops
// asserting and echoes the room back instead.
//
// A mirror is directly observable and needs no private reads: an asserting
// frame carries a `paused` key and a mirror does not, so `server.wireOf(user)`
// separates the two by hand. What makes it worth a file is the failure mode on
// the other side of it. A peer whose element is at 0 — freshly bound, still
// seeking, reloading — that *asserted* `position: 0` would win the room's
// `min()` election outright and drag every other watcher back to the start of
// the file. The mirror is what stops that, and each case here comes at it
// through a different door:
//
//  - **a peer that cannot reach the room**, whose seek never lands;
//  - **the same peer once it does land**, which is the adoption latch closing;
//  - **a peer whose element drops to `HAVE_NOTHING`**, which stops its snapshots
//    and walks main across the staleness thresholds from the other direction;
//  - **an episode change**, which de-adopts the switcher through `setFile()`
//    rather than through a timeout, and is the only path that puts a
//    `remote-episode-change` in front of the *other* peer.
//
// The first is the load-bearing one: it is the case where the room has
// something to lose, and the only one here that goes red when the mirror stops
// suppressing the `paused` key.
//
// What this file cannot separate: the two staleness thresholds. Main stops
// asserting at `PLAYBACK_ASSERT_STALE_MS` and de-adopts at `PLAYBACK_STALE_MS`,
// and both produce the same frame — a mirror with no `paused` key. The third
// case below crosses both and pins the first boundary, where the shape changes;
// the second is not a claim this harness can make from the wire, and nothing
// here pretends otherwise.
//
// Both peers are seated before the room is advanced in every case, which is not
// stylistic. Measured: a peer left alone in the room receives no `remote-state`
// at all — the room's `setBy` is itself, so every frame dies at the self-echo
// guard — and the pause the ready gate applies at mount is therefore never
// released, latching the room paused around it. A far joiner seated late would
// be measuring that instead of this.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { WireFrame } from '../helpers/syncplay-min-election-server'

const DELAY_MS = 50

/** The frames on which the peer made a pause claim — i.e. spoke as a
 *  participant. A mirror omits the key entirely, so `undefined` is the
 *  discriminator and `=== false` would silently count mirrors as assertions. */
const asserting = (frames: WireFrame[]): WireFrame[] => frames.filter((f) => f.paused !== undefined)
const mirroring = (frames: WireFrame[]): WireFrame[] => frames.filter((f) => f.paused === undefined)

describe('SyncplayClient — adoption and the spectator mirror across two peers', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  it('mirrors a room its element cannot reach, and never elects itself with a position it is not at', async () => {
    // The joiner is 600 s behind and its element is **not ready**: it reloads at
    // mount and its `loadedmetadata` is 30 s out, well past this run, so it sits
    // at `HAVE_NOTHING` reporting 0 for the whole of it. That is the
    // pathological shape on purpose: a peer that is *permanently* at 0 while the
    // room plays on.
    //
    // This used to be built on a seek that never landed — `seekLandMs: 1200`,
    // longer than the 1 Hz cadence, so every write was superseded before it
    // could take. #368 retired that premise. A real element reports the seek
    // **target** the moment `currentTime` is assigned, not a frozen pre-write
    // position, so a peer whose seeks are merely slow is not at 0 at all; it is
    // up at the room, and it announces the room's own position back. The door
    // that actually holds an element at 0 while the room plays is readiness, so
    // that is the door this case now comes through, and the outbound gate it
    // exercises is `hasAnnounceablePosition()`'s `readyState >= 1`
    // (`use-syncplay-client.ts:770`).
    //
    // The slow-seek version of this peer is not harmless — it is *worse*, and
    // it is the subject of `syncplay-two-peer-inflight-seek.test.ts`: under the
    // correction it elects itself with a position it is not at, which is the
    // exact failure this case's title says must not happen.
    room = await createTwoPeerRoom({ position: 600, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: 600,
      paused: false,
      delayMs: DELAY_MS
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: 0,
      paused: false,
      delayMs: DELAY_MS,
      bindGapMs: 30_000
    })
    joiner.el.reload('harness://reloading')
    await room.advance(8)

    // The premise: the element really never arrived, and this time it is
    // readiness that holds it there. It dropped to `HAVE_NOTHING` and never came
    // back, and with the outbound door shut it was never even written to.
    // Without this the rest would be vacuously true of a peer that had simply
    // caught up.
    expect(joiner.el.currentTime).toBe(0)
    expect(joiner.el.readyStates).toEqual([1, 0])
    expect(joiner.el.seekWrites).toHaveLength(0)

    // The claim. Every frame the joiner put on the wire is a mirror, counted
    // rather than sampled — an `every()` over a set that turned out empty would
    // report green while asserting nothing.
    const wire = room.server.wireOf('joinuser')
    expect(wire).toHaveLength(7)
    expect(mirroring(wire)).toHaveLength(7)
    expect(asserting(wire)).toHaveLength(0)

    // And the mirror echoed the *room*, not the element: every one of those
    // seven positions is up at 600, where the room is, not down at 0, where the
    // element is. Same count on both sides, so the filter cannot pass by being
    // empty.
    expect(mirroring(wire).filter((f) => f.position >= 600)).toHaveLength(7)

    // Which is the whole point: the room was never dragged. The joiner won no
    // election for the entire run, the host set every one of them, and the room
    // is where 8 s of playback from 600 should have put it.
    expect(room.server.electionsSetBy('joinuser')).toHaveLength(0)
    expect(room.server.electionsSetBy('hostuser')).toHaveLength(room.server.elections.length)
    expect(room.server.roomState().position).toBeCloseTo(605.95, 2)
    expect(room.server.roomState().setBy).toBe('hostuser')

    // The host is untouched by any of it — still playing, still where it should
    // be. A peer that had asserted 0 would have pulled this back with it.
    expect(host.el.paused).toBe(false)
    expect(host.el.currentTime).toBeCloseTo(606.95, 2)

    // A mirror is not a discrete change, so nothing was announced.
    expect(joiner.counters().clientIgnoreCounter).toBe(0)
  })

  it('asserts from its very first frame when the seek is merely slow, with no mirror at all', async () => {
    // The same joiner, with a seek that lands inside one cadence — and under
    // the corrected element there is **no mirror phase left to leave**.
    //
    // This case used to pin a transition: one mirror frame sent "while the
    // element was still in flight", then six asserting frames after it landed.
    // That one mirror was an artefact of the freeze. A real element reports the
    // target as soon as `currentTime` is assigned (#368), so the drift falls
    // inside `ADOPT_TOLERANCE_S` on the *write*, not 300 ms later on the
    // landing; adoption latches before the first snapshot goes out and all
    // seven frames are assertions.
    //
    // So the boundary this file is about does not live where seek latency puts
    // it. Read with the case above, the pair is what pins that: a slow seek
    // produces no mirror however slow it is, and an unready element produces
    // nothing but mirrors. The mirror is keyed on readiness, full stop.
    room = await createTwoPeerRoom({ position: 600, paused: false })
    await room.seat({ username: 'hostuser', position: 600, paused: false, delayMs: DELAY_MS })
    const joiner = await room.seat({
      username: 'joinuser',
      position: 0,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: 300
    })
    await room.advance(8)

    // One write, taken this time.
    expect(joiner.el.seekWrites).toHaveLength(1)
    expect(joiner.el.seekWrites[0]).toBeCloseTo(601, 2)
    expect(joiner.el.currentTime).toBeCloseTo(607.65, 2)

    // No mirror at all, and seven assertions where there used to be six. The
    // counts are pinned on both sides so neither half can drift into the other
    // unnoticed, and the total is pinned too so "no mirrors" cannot be bought by
    // the peer having gone quiet.
    const wire = room.server.wireOf('joinuser')
    expect(wire).toHaveLength(7)
    expect(mirroring(wire)).toHaveLength(0)
    expect(asserting(wire)).toHaveLength(7)
    // The boundary — the very first frame — restated where a reader looks for
    // it rather than left as a claim with nothing written under it. The two
    // lengths above already force it: `asserting` is an order-preserving
    // filter, so both arrays being 7 makes them the same frames, reference for
    // reference. It stands where an `indexOf(mirroring(wire)[0]) === 0` used to,
    // which did carry its own information against an unpinned `mirroring` set
    // but would read `-1` here — green-looking and meaningless — if it had
    // merely been left in place.
    expect(asserting(wire)[0]).toBe(wire[0])
    expect(asserting(wire).filter((f) => f.paused === false)).toHaveLength(7)

    // Adopting does not make it a leader. It agrees with the room rather than
    // arguing with it, so the host keeps setting the position and the joiner
    // still announces nothing discrete.
    expect(room.server.electionsSetBy('joinuser')).toHaveLength(0)
    expect(joiner.counters().clientIgnoreCounter).toBe(0)
    expect(room.server.roomState().position).toBeCloseTo(605.95, 2)
  })

  it('stops asserting when its element drops to HAVE_NOTHING, and the room runs on without it', async () => {
    // Staleness from the other direction. Nothing here is late on the wire — the
    // peer's own element went away underneath it. `reload()` puts it at
    // `HAVE_NOTHING`, which closes `hasAnnounceablePosition()` and stops the 1 Hz
    // snapshot; main's view of this peer then ages in place until it crosses
    // `PLAYBACK_ASSERT_STALE_MS` and stops asserting.
    //
    // `bindGapMs` is set past the end of the run so the metadata never lands —
    // deliberate, and not redundant with the 500 ms default. What happens when a
    // reloaded element comes back into a room that has moved on is #360, still open.
    room = await createTwoPeerRoom({ position: 300, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS,
      bindGapMs: 30_000
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)

    const reloadAt = Date.now()
    host.el.reload('harness://hostuser/ep-7-reopened')
    await room.advance(8)

    // The premise: the element did rebind, did drop to `HAVE_NOTHING`, and did
    // not come back.
    expect(host.el.loads).toEqual(['harness://initial', 'harness://hostuser/ep-7-reopened'])
    expect(host.el.readyStates).toEqual([1, 0])

    // The shape changes once, at the threshold. The last asserting frame is
    // 2000 ms after the reload and the first mirror 3000 ms after it — the
    // 1 Hz frame at exactly +2000 still asserts, because the comparison is a
    // strict `>` against a 2000 ms budget.
    const wire = room.server.wireOf('hostuser')
    expect(asserting(wire)).toHaveLength(5)
    expect(mirroring(wire)).toHaveLength(6)
    expect(asserting(wire).at(-1)!.at - reloadAt).toBe(2000)
    expect(mirroring(wire)[0].at - reloadAt).toBe(3000)

    // The mirror still echoes the room — six frames up where the room is, not
    // the 0 the element is actually sitting at.
    expect(mirroring(wire).filter((f) => f.position >= 304)).toHaveLength(6)

    // And the element was never written while it could not honour a write: no
    // seek landed on a `HAVE_NOTHING` element for the whole 8 s (#284).
    expect(host.el.seekWrites).toEqual([])
    expect(host.el.currentTime).toBe(0)

    // Meanwhile the room ran on, undisturbed, and so did the other peer — it was
    // never paused, never seeked, never told anything had gone wrong.
    expect(room.server.roomState().position).toBeCloseTo(309.95, 2)
    expect(room.server.roomState().paused).toBe(false)
    expect(joiner.el.paused).toBe(false)
    expect(joiner.el.seekWrites).toEqual([])
    expect(joiner.el.currentTime).toBeCloseTo(310.95, 2)

    // Going quiet is not an announcement.
    expect(host.counters().clientIgnoreCounter).toBe(0)
  })

  it('de-adopts the peer that changes episode and tells the other peer exactly once', async () => {
    // De-adoption through `setFile()` rather than through a clock: the identity
    // of the file changed, so the position main was holding for this peer is not
    // about the same media any more and the adoption latch opens on the spot.
    //
    // This is also the only path that produces a `remote-episode-change`, and
    // the frame that carries it — `Set: {user: {<name>: {room, file}}}` — is sent
    // to the setter as well as to everyone else, so both halves of that are
    // worth pinning.
    room = await createTwoPeerRoom({ position: 300, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS,
      // Explicit although 500 has been the helper's own default since #387, and
      // kept that way on purpose: this is a **pin**, not a leftover. Every
      // number this case asserts — the single 302 write, the room's 306.5, the
      // zero mirror frames the note below measures — belongs to this one cell of
      // #360's gap axis, and that axis is a comb rather than a slope, so a
      // default that moved would not degrade these assertions, it would silently
      // re-measure a different cell and still be green on some of them. The
      // pin is therefore about *this fixture's* numbers being addressable, not
      // about disagreeing with the default; the guard that the default itself is
      // still 500 is `syncplay-two-peer-loop.test.ts`'s own, and deleting this
      // line would hand that guard a second, undeclared job.
      bindGapMs: 500
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: 300,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)

    // Baselines, not noise: the assertions below are about what the *switch*
    // adds, and the starting point is lopsided. The host was already seated when
    // the joiner announced its file, so it heard it; the joiner arrived after
    // the host's announcement and heard nothing. The roster refresh it *did*
    // receive carries no `features`, so a late arrival learns which episode
    // everyone is on only when somebody next changes it — which is exactly what
    // the rest of this case is.
    expect(host.remoteEpisodes).toHaveLength(1)
    expect(host.remoteEpisodes[0].fromUser).toBe('joinuser')
    expect(joiner.remoteEpisodes).toEqual([])
    host.el.seekWrites.length = 0

    await host.goToEpisode('8')
    await room.advance(6)

    // The switcher really switched: new source, a real `HAVE_NOTHING` dip and
    // back, and a renderer that now reports the new episode while the other
    // peer's is unmoved.
    expect(host.el.loads).toEqual(['harness://initial', 'harness://hostuser/ep-8'])
    expect(host.el.readyStates).toEqual([1, 0, 1])
    expect(host.episode()).toBe('8')
    expect(joiner.episode()).toBe('7')

    // The other peer was told, once, and told the truth. This is the whole
    // `sendSetFile` → server relay → `absorbRemoteFile` → `remote-episode-change`
    // path; before this harness grew a file broadcast there was no way to reach
    // it with two real peers at all.
    expect(joiner.remoteEpisodes).toHaveLength(1)
    expect(joiner.remoteEpisodes[0]).toEqual({
      animeId: 1,
      malId: 2,
      episodeInt: '8',
      translationId: 3,
      canonicalName: 'Some Anime - 8',
      fromUser: 'hostuser'
    })

    // And the switcher was *not* told about its own change. The reference server
    // applies no sender filter to a file update: `sendFileUpdate` (`server.py:175-178`) hands it to `RoomManager.broadcast` (`server.py:447-450`), so that frame came back to this
    // peer and was dropped on the `username !== config.username` guard in
    // `handleSet` — a guard that is only ever exercised by a second peer being
    // present.
    expect(host.remoteEpisodes).toHaveLength(1)

    // The switcher's element is at 0 with the room near 302, so it is placed
    // back at the room — one write. That write is #360 verbatim: a brand-new
    // episode's element seeked to the *previous* episode's timestamp, a position
    // the new file bears no relation to. Pinned as shipped behaviour, not as a
    // desired one.
    //
    // This comment used to read "de-adoption is what keeps the switch from
    // costing the room its position", and that stated reason is contradicted at
    // this fixture's own bind gap. `bindGapMs: 500` puts the element back well
    // inside `PLAYBACK_ASSERT_STALE_MS` (2 s), so the de-adoption
    // `src/main/syncplay.ts:789` ("if (isNewPlayer) this.playbackAdopted = false")
    // performs never reaches the wire at all: measured on this exact scenario,
    // every post-switch frame this peer sends carries a `paused` key — zero
    // spectator-mirror frames — so it asserts continuously straight through the
    // switch. The seat is de-adopted for less than one push and re-latches at
    // `src/main/syncplay.ts:2597` on a drift of 0 taken from the previous
    // episode's snapshot, before the new element has pushed anything.
    // `syncplay-two-peer-episode-change.test.ts` sweeps the gap and #360 has the
    // chain.
    expect(host.el.seekWrites).toHaveLength(1)
    expect(host.el.seekWrites[0]).toBeCloseTo(302, 2)

    // The room is nowhere near the 0 the switcher's element passed through, and
    // the other peer was neither paused nor moved. What 306.5 is *not* is "where
    // six more seconds of playback should have left it" — that is ~308.95, which
    // is precisely where the untouched peer's element reads at this instant. 306.5
    // is the switcher's **dragged** value, so this line has been encoding a 2.45 s
    // room deficit as expected since before anyone had measured it. It is left
    // exactly as it stands because it is a true statement about shipped behaviour;
    // it is not a statement that the behaviour is right.
    //
    // And that 2.45 is the whole reason `joiner.el.seekWrites` two lines down is
    // still `[]`. Not de-adoption: the renderer's seek gate is
    // `src/renderer/src/composables/use-syncplay-client.ts:1411` ("const wouldSeek = state.doSeek || diff > 3.0")
    // over the difference computed at
    // `src/renderer/src/composables/use-syncplay-client.ts:1403` ("const diff = Math.abs(v.currentTime - state.position)")
    // — this peer's own element against the state it was handed — and 2.45 clears
    // 3.0 by 0.55. Measured constant from the switch out to a 20 s window, so it
    // is a standing near miss rather than a transient one. Raise the bind gap to
    // 3000 ms and the same shipped code writes 304.05 to that element instead;
    // `syncplay-two-peer-episode-change.test.ts` pins that. So nothing below is a
    // guarantee that a non-switching peer is never dragged — it is the 500 ms
    // corner in which it happens not to be.
    expect(room.server.roomState().position).toBeCloseTo(306.5, 1)
    expect(room.server.roomState().paused).toBe(false)
    expect(joiner.el.seekWrites).toEqual([])
    expect(joiner.el.paused).toBe(false)

    // An episode change announces a file, not a playstate.
    expect(host.counters().clientIgnoreCounter).toBe(0)
  })
})
