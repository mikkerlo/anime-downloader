// `syncplay:get-room-position` (#262) — the value that seeds the MKV ffmpeg
// spawn, so the open doesn't pay a second spawn plus its buffer-ahead wait when
// the room is parked away from our local resume target.
//
// The discriminating property is the *gate*: a state we set ourselves — a user
// alone in a room, whose own position the server echoes back once a second —
// must answer `null`, even though `lastRoomState` is populated by it. An
// implementation built on `lastRoomState` (the spectator mirror's source,
// recorded deliberately *above* handleState()'s echo guards) passes every other
// test here and fails that one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write = vi.fn()
  destroy = vi.fn(() => {
    this.emit('close')
  })
}

let lastSocket: FakeSocket | null = null
let lastTlsSocket: FakeSocket | null = null

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    lastSocket = new FakeSocket()
    return lastSocket
  })
}))

vi.mock('tls', () => ({
  connect: vi.fn(() => {
    lastTlsSocket = new FakeSocket()
    return lastTlsSocket
  })
}))

import { SyncplayClient } from '../../src/main/syncplay'

describe('SyncplayClient.getRoomPosition (#262)', () => {
  let client: SyncplayClient

  // The file the caller is opening. Every read is scoped to it, so a helper
  // keeps the argument out of the way of what each case is actually about.
  const OPEN = 'Some Anime - 1'

  const file = (canonicalName: string, newPlayer = true): void => {
    client.setFile({
      animeId: 1,
      malId: 2,
      episodeInt: canonicalName.slice(-1),
      translationId: 3,
      canonicalName,
      duration: 1440,
      newPlayer
    })
  }

  const position = (canonicalName = OPEN): number | null => client.getRoomPosition(canonicalName)

  // Connect only — **no file push** (#276). Production order is
  // state-then-push: main is connected with no player open when the room's ~1 Hz
  // periodics start arriving, and `useSyncplayClient`'s onMounted push announces
  // our file afterwards. This helper used to end with that push, so every case
  // in the file ran backwards relative to the app — which is the one ordering in
  // which the pre-#276 seed worked, and why a feature that was structurally dead
  // on every first open shipped green. Each case now pushes its own file, where
  // the case wants it.
  //
  // **Invariant: at least two cases stay push-then-state**, marked in place —
  // `keeps answering while a seated peer is still driving the room` and
  // `re-earns the position from the next state after a switch`. Everything else
  // reaches `lastRemoteRoomState` through `setFile()`'s adoption of an *unkeyed*
  // state, so without them the **direct** stamp in `handleState()` (the
  // `this.currentFile?.canonicalName ?? null` write with a `currentFile` that is
  // not null) would lose its coverage. Measured: mutating that stamp to
  // `canonicalName: null` unconditionally failed 14 cases against the
  // pre-reorder fixture and fails 4 against this one — the two named above plus
  // `leaves an episode switch unseeded until the next state re-earns it` and
  // `answers again for a revisited episode inside the age cap`, both of which
  // are push-then-state by construction rather than by decision. That collapse
  // from 14 to 4 is exactly what the invariant buys back, so do not "tidy" the
  // two named cases into production order.
  const handshake = (room = 'cinema'): void => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room,
      username: 'me',
      autoReconnect: false
    })
    lastSocket!.emit('connect')
    lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
    lastTlsSocket!.emit('secureConnect')
    lastTlsSocket!.emit(
      'data',
      Buffer.from(`{"Hello":{"username":"me","room":{"name":"${room}"},"version":"1.6.9"}}\r\n`)
    )
  }

  // A `List` reply keyed to our room — the only thing that makes `rosterReceived`
  // true, and with it the "are we alone?" half of the bound below meaningful.
  const roster = (entries: Record<string, unknown>, room = 'cinema'): void => {
    lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ List: { [room]: entries } }) + '\r\n'))
  }

  // The reference `sendUserSetting` leave frame: one entry naming the departing
  // user with `event.left`.
  const peerLeaves = (username: string, room = 'cinema'): void => {
    lastTlsSocket!.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          Set: { user: { [username]: { room: { name: room }, event: { left: true } } } }
        }) + '\r\n'
      )
    )
  }

  // Latch `playbackAdopted` the way production does — a renderer push that has
  // converged on the room, then one heartbeat, since `sendStateMessage()` →
  // `buildPlaystate()` → `isAdopted()` is the only call that flips it. Costs one
  // heartbeat of wall time, which the projections in the cases below account
  // for. Needed since #277: unadopted is no longer the same client.
  const adopt = (roomPosition: number): void => {
    client.updateSnapshot({ position: roomPosition, paused: false })
    vi.advanceTimersByTime(1000)
  }

  const serverState = (position: number, paused: boolean, setBy: string | null): void => {
    lastTlsSocket!.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          State: {
            ping: { latencyCalculation: 1_770_000_000.25 },
            playstate: { position, paused, doSeek: false, setBy }
          }
        }) + '\r\n'
      )
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  describe('the gate', () => {
    it('reports the room position after a state set by a peer', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      file(OPEN)
      expect(position()).toBeCloseTo(600, 3)
    })

    // The solo-room case, and the whole reason this is a second field rather
    // than a read of `lastRoomState`: the server re-broadcasts our own reported
    // position with `setBy` naming us, so a client alone in a room *does* have a
    // `lastRoomState`. Answering with it would seed every MKV open from the
    // room instead of the saved position — the regression `roomOwnsPlayhead()`
    // exists to prevent, moved one layer earlier.
    it('returns null when the only states seen were set by us', () => {
      handshake()
      serverState(600, true, 'me')
      file(OPEN)
      expect(position()).toBeNull()
    })

    it('returns null for a state carrying no setBy at all', () => {
      handshake()
      serverState(600, true, null)
      file(OPEN)
      expect(position()).toBeNull()
    })

    it('returns null before any state has arrived', () => {
      handshake()
      file(OPEN)
      expect(position()).toBeNull()
    })

    it('returns null with no session at all', () => {
      expect(position()).toBeNull()
    })

    // A peer's state seen while connected must not answer for a session that
    // has since ended: `disconnect()` runs tearDown(), which drops the field
    // beside `lastRoomState`.
    it('returns null after the session is torn down', () => {
      handshake()
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      expect(position()).not.toBeNull()
      client.disconnect()
      expect(position()).toBeNull()
    })
  })

  describe('the projection', () => {
    it('advances with wall time while the room is playing', () => {
      handshake()
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      vi.advanceTimersByTime(4000)
      expect(position()!).toBeCloseTo(604, 1)
    })

    // A paused position does not age, so advancing it is pure error — the same
    // rule `projectedRoomPosition()` applies for the spectator mirror.
    it('does not advance while the room is paused', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      file(OPEN)
      vi.advanceTimersByTime(4000)
      expect(position()!).toBeCloseTo(600, 3)
    })

    it('never reports a negative position', () => {
      handshake()
      serverState(-5, true, 'mikkerlo')
      file(OPEN)
      expect(position()).toBe(0)
    })
  })

  // Regression for the review of #272. `lastRemoteRoomState` is refreshed *only*
  // by a state that clears handleState()'s setBy-null / self / unacked guards, so
  // two reachable shapes freeze it while `status.state` stays `ready` — and an
  // unbounded projection then walks the frozen value forward with wall time for
  // as long as the session lives. The number it produces becomes `initialSeek`
  // and reaches ffmpeg's `-ss`, where a target past the end of the file is a run
  // that emits nothing and an MSE session that buffers forever.
  describe('the bound', () => {
    // Shape 1 — the last peer leaves. The roster empties, the server keeps
    // sending periodics `setBy` us (its min() re-election elects the only
    // watcher left), and every one of them dies at the self-guard. Unbounded
    // this answered 2400 for a room that was at 600 half an hour ago.
    it('stops answering once the last peer has left the room', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      expect(position()!).toBeCloseTo(600, 1)

      peerLeaves('mikkerlo')
      vi.advanceTimersByTime(30 * 60 * 1000)
      expect(position()).toBeNull()
    })

    // The roster half is what makes that instant rather than one age-cap later:
    // two seconds after the leave the projection is only 2 s wrong, and still
    // must not be used — nobody is in the room to sync with.
    it('stops answering immediately on the leave, not one age cap later', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      peerLeaves('mikkerlo')
      vi.advanceTimersByTime(2000)
      expect(position()).toBeNull()
    })

    // Shape 2 — *we* pause the room. Our pause is broadcast back to us `setBy`
    // us and dropped, so the stored `paused: false` never flips and the
    // projection keeps walking a room that is standing still. Unbounded this
    // answered 900 after five minutes of a room parked at 600.
    //
    // Adoption is **pinned**, not incidental (#277 review). The user who paused
    // the room is adopted by construction — they have a player and it has
    // converged — and since #277 that is the difference between this case
    // modelling what it names and modelling a *spectator*: unadopted, the same
    // echo is `isRoomVoice()` and is applied, storing `paused: true`, and the
    // projection freezes at 600 instead of walking. The case would still pass
    // (the age cap kills it either way) while pinning nothing about the frozen
    // flag, so the walk is asserted directly below rather than left to the cap.
    it('stops answering after our own pause has frozen the stored paused flag', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      adopt(600)
      // The echo of our own pause: real frame, real pause, dropped at the
      // self-guard — so `lastRemoteRoomState` still reads `paused: false`.
      serverState(600, true, 'me')

      // The frozen flag itself, inside the age cap: the room is paused at 600
      // and the answer walks with wall time anyway. This is the defect the
      // bound exists for, and it is what makes the `null` below a *bound*
      // rather than a correctly-projected paused room.
      vi.advanceTimersByTime(5000)
      expect(position()!).toBeCloseTo(606, 1)

      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(position()).toBeNull()
    })

    // The age cap is a freshness test, not a projection test: a *paused* room
    // whose state has gone silent is equally untrustworthy, even though the
    // projection would return the stored value unchanged.
    it('stops answering when the last peer state has gone stale, paused or not', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, true, 'mikkerlo')
      file(OPEN)
      vi.advanceTimersByTime(20 * 60 * 1000)
      expect(position()).toBeNull()
    })

    // The bound must not cost the feature on the path it exists for: a peer is
    // seated and driving at ~1 Hz, so the value is fresh and the room owns the
    // spawn.
    //
    // **Push-then-state, deliberately, and one of the two cases the reorder
    // invariant on `handshake()` names (#276).** The file is announced *before*
    // any state arrives, so both states are stamped directly from a non-null
    // `currentFile` and nothing here goes through `setFile()`'s adoption of an
    // unkeyed state. This is what keeps the direct stamp covered now that the
    // rest of the file runs in production order. It is also the shape it models:
    // a player already open while a peer drives the room. Do not "tidy" the
    // order.
    it('keeps answering while a seated peer is still driving the room', () => {
      handshake()
      file(OPEN)
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, false, 'mikkerlo')
      vi.advanceTimersByTime(4000)
      serverState(604, false, 'mikkerlo')
      vi.advanceTimersByTime(4000)
      expect(position()!).toBeCloseTo(608, 1)
    })

    // The roster test is `isAdopted()`'s idiom *including its `rosterReceived`
    // guard*: "the roster is empty" and "the roster has not arrived" are
    // different answers, and a server whose `List` reply we cannot key to our
    // room (#223) never reports one at all. A fresh non-self state is its own
    // proof that a peer exists — only a peer can set it — so it stays usable,
    // bounded by the age cap alone.
    it('still answers from a fresh peer state when no roster has arrived', () => {
      handshake()
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      vi.advanceTimersByTime(4000)
      expect(position()!).toBeCloseTo(604, 1)
    })
  })

  describe('file identity', () => {
    // The room's position was reported for the file we were on. Handed to the
    // next episode's spawn it would be worse than the saved position it
    // replaces. Asked for under the *new* name, and main is already on that name
    // — so the caller-scope guard passes and the **key match** is the only thing
    // that can answer null here (#276). It used to be the `setFile()` clear;
    // that line is gone, and this case is what pins its replacement.
    it('drops the position when our canonical name changes', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      file(OPEN)
      expect(position()).toBeCloseTo(600, 3)

      file('Some Anime - 2')
      expect(position('Some Anime - 2')).toBeNull()
    })

    // Keyed on identity, not on `newPlayer`: a same-episode reopen (close the
    // player, pick another translation) re-pushes a byte-identical name at a
    // fresh <video>, and the room's position is still the right seed for it.
    it('keeps the position across a same-episode reopen', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      file(OPEN)

      file(OPEN, true)
      expect(position()).toBeCloseTo(600, 3)
    })

    // **Push-then-state, deliberately — the second case the reorder invariant on
    // `handshake()` names (#276).** Here it is push-then-state by *construction*
    // as well: the second `serverState` necessarily lands while `currentFile` is
    // already episode 2, so this one keeps the direct stamp covered even through
    // a naive wholesale reorder. The leading `file(OPEN)` is the deliberate half
    // — it is what makes the *first* state a direct stamp too, so the case reads
    // as "a player was open the whole time and the episode changed under it".
    it('re-earns the position from the next state after a switch', () => {
      handshake()
      file(OPEN)
      serverState(600, true, 'mikkerlo')
      file('Some Anime - 2')
      serverState(12, true, 'mikkerlo')
      expect(position('Some Anime - 2')).toBeCloseTo(12, 3)
    })

    // The caller's scope, not merely the ordering (#272 review). Main still
    // believes we are on episode 1 — the push for episode 2 has not landed — and
    // a read naming episode 2 must not be answered from episode 1's room
    // position, which is the exact seed that would spawn ffmpeg in the wrong
    // place if the two `onMounted` hooks ever reorder.
    it('answers null for a file main has not been told about yet', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      file(OPEN)
      expect(position('Some Anime - 2')).toBeNull()
      // ...and the file it *does* know about is unaffected.
      expect(position()).toBeCloseTo(600, 3)
    })

    // The one shape `setFile()`'s clear can never cover, because it never ran
    // (#272 review). With no `currentFile` at all, `this.currentFile?.canonicalName`
    // is `undefined`, so an optional-chained comparison against a nullish
    // argument reads as equal and the gate passes — "main has not been told about
    // any file" is the state where answering with the room's position is least
    // defensible. Unreachable through the typed preload path (`PlayerView` always
    // hands over `buildCanonicalName()`, always a string), which is exactly why
    // the guard has to be structural rather than incidental.
    it('answers null when main has no current file at all, for any name shape', () => {
      handshake()
      serverState(600, true, 'mikkerlo')

      expect(client.getRoomPosition(undefined as never)).toBeNull()
      expect(position('')).toBeNull()
      expect(position()).toBeNull()
    })
  })

  // Characterisation, and deliberately a no-op: #279 back-dates `lastRoomState`'s
  // arrival stamp by up to `MAX_ROOM_ANCHOR_LAG_S` to stop the spectator mirror
  // ratcheting the room backwards, and this record — a *different* one — must
  // not move with it.
  //
  // `lastRemoteRoomState` is written from `compensated`, which already carries
  // `+ serverRtt / 2` on the **position** axis under the same pause gate. Shift
  // its `at` as well and the same half-RTT is applied twice, on both axes, to
  // the value that becomes `initialSeek` and reaches ffmpeg's `-ss` (#275) —
  // and the 15 s freshness cap starts expiring early, from a stamp that is no
  // longer "when this frame arrived". Anyone later "unifying the anchor" for
  // tidiness breaks these two cases and nothing else, which is the point of
  // writing them down.
  describe('the #279 anchor shift does not reach this record', () => {
    // Seeds `serverRtt` by echoing a stale `clientLatencyCalculation`: the
    // client takes `now / 1000 - myTs` inside the `0 < rtt < 5` window.
    const peerState = (pos: number, paused: boolean, rtt: number): void => {
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            State: {
              ping: { clientLatencyCalculation: Date.now() / 1000 - rtt },
              playstate: { position: pos, paused, doSeek: false, setBy: 'mikkerlo' }
            }
          }) + '\r\n'
        )
      )
    }

    it('compensates on the position axis once, not on both axes', () => {
      handshake()
      // Explicit, and not redundant: `handshake()` pushes the file here but
      // stops doing so under #276, and `position()` answers `null` for a file
      // main was never told about. Keep the push at the case, not in the helper.
      file(OPEN)
      // An RTT whose half is well past MAX_ROOM_ANCHOR_LAG_S, so a leaked
      // anchor shift would be visible as its clamped 0.25 s rather than lost in
      // rounding.
      peerState(600, false, 2)
      expect(serverRttOf()).toBeGreaterThan(1.9)

      // 600 + serverRtt / 2, and nothing else. A doubled compensation reads
      // ~601.25 here.
      expect(position()!).toBeCloseTo(600 + serverRttOf() / 2, 3)
      vi.advanceTimersByTime(4000)
      expect(position()!).toBeCloseTo(604 + serverRttOf() / 2, 3)
    })

    it('runs the 15 s freshness cap from arrival, not from a back-dated anchor', () => {
      handshake()
      file(OPEN) // As above — the cap can't be exercised against an unannounced file.
      peerState(600, true, 2)
      // Just inside the cap. A back-dated `at` would have expired this by
      // MAX_ROOM_ANCHOR_LAG_S already.
      vi.advanceTimersByTime(14_900)
      expect(position()).not.toBeNull()
      vi.advanceTimersByTime(200)
      expect(position()).toBeNull()
    })

    const serverRttOf = (): number => (client as unknown as { serverRtt: number }).serverRtt
  })

  // The bug (#276) and the semantics that replace it. Every case in this file
  // now runs in production order — `handshake()` connects and nothing else, and
  // the file push lands where the case wants it — but before #276 the helper
  // ended with the push, so the whole suite ran the one ordering in which the
  // seed worked and a feature that was dead on every first open shipped green.
  // These are the cases about that ordering specifically.
  describe('the first open', () => {
    // On `main` the push that makes the read legal is the push that wipes the
    // field: `currentFile` is `null` on a first open, so `identityChanged` is
    // unconditionally true and the blind clear fires. The renderer's read lands
    // milliseconds later, far inside the ~1 s before another foreign state can
    // re-earn it, and the MKV spawn goes to 0 while the room sits at 600.
    it('seeds a first open from a state seen before we announced anything', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      expect(position()!).toBeCloseTo(600, 1)
    })

    // Answer (A), recorded. The keyed design fixes the first open and
    // deliberately leaves the episode *switch* answering `null`, exactly as
    // `main` does: `handleState()` can only stamp what **we** were playing, and
    // Syncplay's `State` frames carry no file identity at all, so ep 2's key can
    // only come from ep 2's own next state. Bounded by the server's ~1 Hz
    // cadence, not closed here.
    it('leaves an episode switch unseeded until the next state re-earns it', () => {
      handshake()
      roster({ mikkerlo: { isReady: true, file: {} } })
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      expect(position()!).toBeCloseTo(600, 1)

      file('Some Anime - 2')
      expect(position('Some Anime - 2')).toBeNull()
      serverState(12, true, 'mikkerlo')
      expect(position('Some Anime - 2')).toBeCloseTo(12, 3)
    })

    // The direction the key does **not** cover, so the caller-scope guard has
    // to. The state is stored under ep 1 and the caller *names* ep 1, so
    // `room.canonicalName === canonicalName` matches: only
    // `currentFile.canonicalName !== canonicalName` answers null here. Dropping
    // that line in favour of the key answers 600 for a file we have left — and
    // this passes on `main` too, so it is a guard-preservation test rather than
    // a behaviour delta.
    it('answers null for a file we have left, even though the state matches it', () => {
      handshake()
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      file('Some Anime - 2')
      expect(position('Some Anime - 1')).toBeNull()
    })

    // Adoption of the unkeyed state is **checked against the roster**, not
    // assumed: the flow this seeds (sit in a room with no player, then open
    // something) is also the flow most likely to open content the room is not
    // on. Ungated this answers 600 — somebody else's episode position, handed to
    // our ffmpeg spawn.
    it('refuses to adopt an unkeyed state when a peer is on different content', () => {
      handshake()
      roster({
        mikkerlo: {
          isReady: true,
          file: { features: { animeDlAppMeta: { animeId: 999, episodeInt: '7' } } }
        }
      })
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      expect(position()).toBeNull()
    })

    // The gate compares *content*, not "does any peer publish meta at all". A
    // peer on the same episode confirms the premise. `translationId` is
    // deliberately not compared: `canonicalName` has no translation component,
    // and two peers on different translations of the same episode share a
    // playhead legitimately.
    it('adopts an unkeyed state when a peer is on the same episode, any translation', () => {
      handshake()
      roster({
        mikkerlo: {
          isReady: true,
          file: {
            features: { animeDlAppMeta: { animeId: 1, episodeInt: '1', translationId: 77 } }
          }
        }
      })
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      expect(position()!).toBeCloseTo(600, 1)
    })

    // The new way *in*, and the reason `docs/syncplay.md`'s freeze-shape
    // analysis had to be rewritten rather than edited. With the `setFile()`
    // clear gone, ep 1 → ep 2 → back to ep 1 reads ep 1's stored state again,
    // because its key still matches — where `main` answers `null`. The room may
    // have moved on meanwhile, so the value can be stale by up to the cap, and
    // the **age cap is now the sole bound on this path**.
    it('answers again for a revisited episode inside the age cap, and not past it', () => {
      handshake()
      file(OPEN)
      serverState(600, true, 'mikkerlo')
      file('Some Anime - 2')
      file(OPEN)

      vi.advanceTimersByTime(5000)
      expect(position()!).toBeCloseTo(600, 1)
      vi.advanceTimersByTime(20000)
      expect(position()).toBeNull()
    })

    // A refusal leaves the state **unkeyed**, not nulled, so a later announce
    // that does match the roster may still adopt it inside the age cap — open
    // the wrong episode first, then the one the room is on. Without this the
    // refusal arm is free to null the field instead and the suite stays green.
    it('adopts a refused state on a later announce that does match', () => {
      handshake()
      roster({
        mikkerlo: {
          isReady: true,
          file: { features: { animeDlAppMeta: { animeId: 1, episodeInt: '2' } } }
        }
      })
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      expect(position()).toBeNull()

      file('Some Anime - 2')
      expect(position('Some Anime - 2')!).toBeCloseTo(600, 1)
    })

    // The peer scan excludes *us*, and that is not cosmetic: a refusal sets
    // `currentFile`, the server echoes our own `Set: {file}` back into the
    // roster, and our own entry then publishes meta matching what we announce.
    // Without the self-exclusion the very next re-push — PlayerView's
    // duration-known one — finds a "peer" agreeing with us and adopts the state
    // the gate just refused.
    it('does not let our own roster entry confirm a refusal on the next re-push', () => {
      handshake()
      roster({
        mikkerlo: {
          isReady: true,
          file: { features: { animeDlAppMeta: { animeId: 999, episodeInt: '7' } } }
        }
      })
      serverState(600, false, 'mikkerlo')
      file(OPEN)
      expect(position()).toBeNull()

      roster({
        me: {
          isReady: true,
          file: { features: { animeDlAppMeta: { animeId: 1, episodeInt: '1' } } }
        },
        mikkerlo: {
          isReady: true,
          file: { features: { animeDlAppMeta: { animeId: 999, episodeInt: '7' } } }
        }
      })
      file(OPEN, false)
      expect(position()).toBeNull()
    })
  })
})
