// A modelled Syncplay server, cut down to the one mechanism this repo's
// fixtures cannot express: `Room.getPosition()`'s `min()` election over
// watchers (`server.py:597-604`), and the link latency that decides it.
//
// Every other syncplay fixture here is single-client and hand-feeds one inbound
// frame at a time, so "who the server says set the room" is an input rather
// than a result. #277 lives entirely in that gap: an unadopted client mirrors
// the room *anchored on the frame's arrival*, lands one one-way delay behind
// it, wins the election, and from then on the room's `setBy` is itself — which
// its own self-`setBy` guard then drops. At zero latency none of that happens,
// which is why neither CI nor a LAN has ever reproduced the bug.
//
// Reference behaviour modelled, against Syncplay 1.7.6:
//  - `Watcher.updateState` stores `position + forwardDelay` (`avrRtt/2`, i.e.
//    one one-way delay) and stamps `_lastUpdatedOn` at **receipt**
//    (`server.py:875-884`). Those are two different axes, which is why the
//    compensation does not cancel the mirror's deficit.
//  - `Watcher.getPosition()` advances the stored value with wall time iff **the
//    room** is playing (`server.py:780-787`) — not iff that watcher is paused.
//    A watcher that claimed `paused: true` into a playing room still walks
//    forward with everyone else, and a paused room advances nobody.
//  - The paused-room creep is a *receipt*-side effect rather than a wall-time
//    one: `_updatePositionByAge` adds `messageAge` to any frame whose `paused`
//    is falsy or absent (`server.py:870-873`), a mirror sends no `paused` key at
//    all, and the room is re-derived from the value it just stored — so the
//    stored position gains one forward delay per turn round the election loop
//    even while the room stands still.
//  - `Watcher.__lt__` (`server.py:834-839`) is an *ordering*, not a filter: a
//    watcher whose file is `None` compares as "not less than" anything, and
//    anything compares as "less than" it. That is why a joiner with no player
//    open still hears the room, and why `Set: {file}` is the moment the
//    deafness starts. It is **not** an exclusion, and modelling it as one was
//    wrong (#307): `Room.getPosition()` runs `min()` over *all* watchers, and
//    Python's `min()` keeps its running best unless a candidate compares
//    strictly less — so a room in which every watcher is fileless elects the
//    **first inserted** one and updates `_position`, `_setBy` and `_lastUpdate`
//    from it, rather than holding no election at all.
//  - `Room.getPosition()` re-elects `min(watchers)` whenever the room state is
//    over a second old, and sets **both** `_position` and `_setBy` from it.
//  - `Watcher.setFile` (`server.py:739-743`) guards on `if file_ and "name" in
//    file_:`, so `Set: {file: null}` stores `None` — the clear #307 sends on a
//    player close — while `Set: {file: {}}` stores a non-`None` empty mapping
//    that `__lt__`'s `is None` test still counts as file-bearing. An absent
//    `file` key is not a command at all. All three are modelled separately.
//  - `sendFileUpdate` (`server.py:175-178`) relays a watcher's `Set: {file}` on
//    to the room as `Set: {user: {…}}`, whole and with no sender exclusion, and
//    refuses to send anything at all for a falsey file. Added for #361's
//    file-change scenarios: it is the only path a peer's episode reaches
//    `absorbRemoteFile`, and therefore the only path `remote-episode-change`
//    has. Note the asymmetry it leaves standing — `sendList` below synthesises
//    its file entries and carries no `features`, where the reference renders
//    the stored file — so `animeDlAppMeta` reaches a peer on the announcement
//    and is dropped again by the next `List`. Fixtures read the episode change
//    at arrival, never off the roster.
//  - `List` (`protocols.py:695`) renders a `None` file as `file: {}` rather
//    than omitting the key.
//  - A `doSeek` or a pause change forces a room update (`server.py:883-884`)
//    broadcast to everyone including the setter (no sender filter, `server.py:441-445`), and
//    `Room.setPosition()` re-seats every watcher onto that position
//    (`server.py:615-620`) without refreshing their `_lastUpdatedOn`. That is
//    the moment the room stops being the laggard's, and the reason a pause
//    "fixes" a session that was drifting.
//  - That forced update does **not** touch the room's `_lastUpdate` — only
//    `Room.__init__` (`server.py:547`) and the election branch (`:603`) do. So
//    the room's age, and with it the next re-election, runs from the last
//    *election* rather than the last write, and a playing room reads ahead of
//    the position a seek or a pause just set (`:606`). Both artefacts are #279's
//    subject; see `forcePositionUpdate()` for the measurements.
//  - `Watcher.sendState` **drops** a watcher that has gone `PROTOCOL_TIMEOUT`
//    without sending a `State` (#384 item 4), and the three lines are copied in
//    their own order rather than approximated:
//    `server.py:860` ("self._connector.sendState(position, paused, doSeek, setBy, forcedUpdate)")
//    puts the frame on the wire, *then*
//    `server.py:861` ("if time.time() - self._lastUpdatedOn > constants.PROTOCOL_TIMEOUT:")
//    tests the clock, *then*
//    `server.py:862` ("self._server.removeWatcher(self)") takes the watcher out
//    of the room and `server.py:863` ("self._connector.drop()") closes the
//    socket. So the drop tick's own `State` is **delivered**, not eaten — and
//    `protocols.py:63` ("self.transport.loseConnection()") is a flushing close,
//    which is the half of that argued from Twisted rather than from source text.
//    `PROTOCOL_TIMEOUT_MS` is the duration and the drop is **off by default**
//    (`protocolTimeoutMs`), because every fixture here predates it.
//
//    Four properties of it that are easy to model one step off:
//
//    **Quantised by the tick, not by the constant.** The comparison is a strict
//    `>` and it is sampled only when the server sends that watcher a `State`,
//    off the per-watcher 1 Hz `LoopingCall`
//    (`server.py:842` ("self._sendStateTimer = task.LoopingCall(self._askForStateUpdate)"),
//    `server.py:843` ("self._sendStateTimer.start(constants.SERVER_STATE_INTERVAL)"),
//    restarted on the same interval by `_resetStateTimer` at
//    `server.py:852` ("self._sendStateTimer.start(constants.SERVER_STATE_INTERVAL)");
//    `constants.py:78` ("SERVER_STATE_INTERVAL = 1")). So an idle *of*
//    `PROTOCOL_TIMEOUT` cannot drop at all, and the earliest drop is the first
//    tick strictly past it. Measured against the pinned server by
//    `conformance/syncplay-protocol-timeout.conformance.ts`: a watcher idle from
//    its own last `State` was dropped 12.902 s later, on the tick after the one
//    at 11.901 s.
//
//    **In `sendState`, not in the periodic broadcast.** Upstream's test is in
//    `Watcher.sendState`, which the 1 Hz tick reaches, and so does
//    `forcePositionUpdate`'s `broadcastRoom` and `setRoom`'s join-time forced
//    update. Hooking `broadcastPeriodicState` here would model only the first of
//    the three. And there is nothing to place the test *outside* of: upstream's
//    sits below `server.py:859` ("if self._connector.isLogged():"), so a
//    suppressed watcher is still on the clock, where this model has no
//    `isLogged` and no suppression at all — stated rather than left looking like
//    an omission.
//
//    **A `State` is the only thing that resets the clock, and traffic is not.**
//    `_lastUpdatedOn` has exactly two writes — the constructor and
//    `server.py:877` ("self._lastUpdatedOn = time.time()") in `updateState` —
//    and `updateState` has exactly one caller,
//    `protocols.py:789` ("self._watcher.updateState(position, paused, doSeek, self._pingService.getLastForwardDelay())"),
//    at the tail of `handleState`. So Chat, `Set` and `List` do not refresh it,
//    while a **ping-only** `State` carrying no playstate does: that same
//    `server.py:877 ("self._lastUpdatedOn = time.time()")` stamps above the
//    `if position is not None` guard, which is the same ordering
//    `applyState` below copies. The one refresh upstream *skips* is the one
//    inside its own ignore window (`protocols.py:788` ("if
//    self.serverIgnoringOnTheFly == 0:")), and that window is on this file's
//    deliberately-unmodelled list two paragraphs down — so it is out of scope
//    here too, rather than quietly diverging.
//
//    **The leave notice is the departure's only announcement, and the departing
//    watcher gets it.** `SyncFactory.removeWatcher`
//    (`server.py:155-161` ("def removeWatcher(self, watcher):")) calls
//    `sendLeftMessage` (`server.py:163-165` ("def sendLeftMessage(self, watcher):"))
//    *before* `_roomManager.removeWatcher`, so the watcher still has a room and
//    the notice can name it, and `broadcast`
//    (`server.py:447-450` ("def broadcast(self, sender, whatLambda):")) has no
//    sender exclusion. The frame is `Set: {user: {<name>: {room, event:
//    {left: true}}}}` with **no `file` key** — `sendUserSetting` writes that key
//    only for a truthy file — which is why `removeWatcher` below sends that
//    literal rather than standing a fresh `List` in for it the way `applySet`
//    does: `src/main/syncplay.ts:1406` ("if (data.event.left === true) {") reads
//    this exact shape, and a `List` stand-in would leave that client path
//    unreachable from any fixture. No `List` is pushed alongside, because
//    upstream's is gated on a rooms DB the conformance server is not started
//    with.
//
//    Three pieces of the removal path are **declared unmodelled** rather than
//    skipped quietly. Two of them belong to `Room.removeWatcher`
//    (`server.py:640-647` ("def removeWatcher(self, watcher):")). Its idempotence guard
//    (`server.py:641` ("if watcher.getName() not in self._watchers:")) and its
//    delete (`server.py:643` ("del self._watchers[watcher.getName()]")) *are*
//    modelled; the room-emptied reset
//    (`server.py:646` ("self._position = 0")) is not, because no fixture here
//    empties a room and modelling it would put a second write of `roomPosition`
//    on a path nothing exercises. `_deactivateStateTimer`
//    (`server.py:748` ("self._deactivateStateTimer()")) needs no counterpart at
//    all: upstream's timer is per-watcher and this model's is room-wide, and
//    `sendState` is only ever reached through a watcher snapshot, so a removed
//    watcher stops being ticked by construction.
//
//    The third is the close itself. `server.py:863` ("self._connector.drop()")
//    takes the socket down, where `removeWatcher` below only stops writing to
//    it — nothing here ever emits `'close'` on the captured socket. That costs
//    `conformance/`'s wire peers nothing, since they only read frames. But a
//    `SyncplayClient`-backed fixture under `test/services/` that opted into
//    `protocolTimeoutMs` would be handed a link that had gone quiet rather than
//    one that had been dropped, and would reach neither
//    `src/main/syncplay.ts:1134` ("sock.on('close', () => this.onSocketClose())")
//    nor its TLS twin
//    `src/main/syncplay.ts:1314` ("tlsSock.on('close', () => this.onSocketClose())"),
//    and so not the reconnect `onSocketClose()` leads to — which is what this
//    client actually does after a real drop. It is written down rather than
//    half-modelled because the mock sockets cannot yet take a second
//    `createConnection`, so the close would be a bigger change than it looks;
//    the likely next user of `protocolTimeoutMs` is a fixture for #360's (h),
//    and that is exactly the kind of test that would care.
//
// Deliberately **not** modelled: the `ignoringOnTheFly` ignore window (the
// server discarding playstates while its flag is up). `syncplay-ignoring-on-the-
// fly.test.ts` owns that seam frame by frame and does it better; a second,
// vaguer model of it here would only disagree with that one.
//
// Also deliberately **not** modelled, and stated rather than quietly assumed
// (#307): the **unknown-position** arm of `__lt__` and `Room.getPosition()`.
// The reference's `Watcher.getPosition()` can answer `None` — a watcher seated
// but never heard from — and both the comparison and `min()`'s result then take
// the same "not less than anything" path a fileless watcher does. `Watcher
// .position` here is a non-nullable `number`, seeded from the room at `seat()`,
// so that arm is unreachable in this model and no test may claim parity for it.
// The file arm *is* modelled exactly, and it is the one #307 turns on; the
// compatibility probe against the real server uses a peer with a known
// position for precisely this reason. Making positions nullable is its own
// refactor and is out of scope here.
//
// Conformance-verified rather than merely modelled (#384): `watcherPosition()`'s
// **paused** arm — the `this.roomPaused ? w.position` half of
// `test/helpers/syncplay-min-election-server.ts:616` ("return this.roomPaused
// ? w.position") — is already checked against the real Syncplay 1.7.6 server in
// both the steady state and the flip into it, so no new scenario is owed for it.
//  - **Steady.** `conformance/syncplay-election.conformance.ts:27`
//    (`conf-elect-lowest`) is a paused room holding two watchers at different
//    positions — alpha `position: 700` at
//    `conformance/syncplay-election.conformance.ts:34` and bravo
//    `position: 500` at `conformance/syncplay-election.conformance.ts:39` — and
//    it samples after `SETTLE_MS = 2600`
//    (`conformance/syncplay-election.conformance.ts:24`) of elapsed wall time,
//    against the ±0.05 s paused tolerance
//    (`conformance/helpers/trace-diff.ts:32`). An arm that advanced with wall
//    time would read ~2.6 s high by the time that sample is taken, more than
//    fifty times the tolerance, so the unprojected return is pinned against the
//    reference rather than assumed — and `conformance/README.md:35` ("verified
//    by running the election suite green against") puts that suite on the
//    record green. Every election scenario in that file is a paused room, so
//    the whole file rides on this arm.
//  - **The flip.** `conf-forced-pause-change`
//    (`conformance/syncplay-forced-update.conformance.ts:126`) drives a room
//    playing and then paused again underneath a stale watcher: alpha states once
//    (`conformance/syncplay-forced-update.conformance.ts:131`) and never again,
//    bravo unpauses (`conformance/syncplay-forced-update.conformance.ts:138`),
//    the room plays through `SETTLE_MS`, and bravo re-pauses at 720
//    (`conformance/syncplay-forced-update.conformance.ts:140`). The sample at
//    `conformance/syncplay-forced-update.conformance.ts:142` ("bravo pauses
//    again at 720, and the room re-seats") is the one taken *after* the flip,
//    and `assertConforms` puts it beside 1.7.6 like any other — at the paused
//    tolerance, because that scenario never sets `playing`.
//  - The clause a reader would otherwise go hunting for, stated rather than left as a
//    hole: `forcePositionUpdate`'s own write, the
//    `test/helpers/syncplay-min-election-server.ts:683` ("this.roomPosition =
//    this.watcherPosition(w)") line, reads through that same paused arm whenever the
//    change that forced it is a pause, because
//    `test/helpers/syncplay-min-election-server.ts:932-954` ("if (ps.doSeek === true ||
//    pausedChanged)") refreshes that watcher's `lastUpdatedOn`, flips `roomPaused`, and
//    only then calls it, in that order. Safe for a stated reason rather than by luck:
//    the refresh is what the *playing* arm would have projected from, and the paused
//    arm ignores the stamp regardless, so either way that write reads the setter's own
//    position at that instant. `test/helpers/syncplay-min-election-server.ts:727` ("for
//    (const other of seated) other.position = this.roomPosition") then re-seats them all.
//  - Option (B) — a scenario built to catch an election *flip* decided inside
//    the paused arm — is structurally excluded rather than deferred, so nobody
//    need re-open it. A flip that arm could decide needs the watchers'
//    positions to differ — the file arm is the other way to move `setBy`, and
//    `conf-elect-all-fileless` already owns it — and a pause change equalises
//    those positions by construction, in the same call that sets the flag:
//    the re-seat above leaves every watcher on the room position. They
//    diverge again in exactly two ways — a fresh `State`, which is the steady
//    case above, or the **playing** arm's per-watcher projection once the room
//    resumes. The second is the seam `conformance/README.md:240-250` already
//    records as unreachable here, with the reference and the model landing on
//    different peers at a spread under a millisecond of loopback RTT.
//
// Shared rather than file-local because #278 and #279 are written against the
// same model (#277 review) — they are the cross-fire and the room-slides-
// backwards halves of the same election.
//
// #279 adds three knobs on top, all additive and all defaulting to the
// reference's own behaviour: `forwardDelay` (the `fd` in `reported + fd`, so
// `2d − fd` can be pinned as a *relationship* rather than read off one
// measurement),
// `echoHoldCorrection` (whether the server corrects the echo of our
// `clientLatencyCalculation` for its own hold, which is what decides whether
// the client's `serverRtt` is a network RTT or a broadcast interval), and the
// `wire` readout — every outbound playstate stamped at *send*, which is the
// quantity #279 is about and the one `elections` cannot show, since it reports
// what the server made of a frame one delay after the fact.

import type { EventEmitter } from 'events'

// The socket shape the fixtures already build for `vi.mock('net'/'tls')`. The
// server takes ownership of `write` when it seats a client, and pushes inbound
// bytes back with `emit('data', …)`.
export type ModelSocket = EventEmitter & { write: (data: string) => void }

/**
 * The `setBy` a **playing** room is seeded with when the caller names none.
 *
 * Upstream pairs playing-ness with a setter rather than leaving the two free:
 * `Room.setPaused` writes `_playState` and `_setBy` in the same two statements
 * (`server.py:611-612`), it is reached only from `Watcher.updateState`
 * (`server.py:879`), and a fresh room is `STATE_PAUSED` by construction
 * (`server.py:543`) with `_setBy = None` beside it (`server.py:544`). So the
 * reference cannot put `paused: false` on the wire next to a null `setBy` —
 * `protocols.py:739` renders the stored watcher's own name — and this fixture's
 * former ability to do so was an infidelity rather than a degree of freedom.
 *
 * The history the sentinel stands in for, stated precisely because a looser
 * reading of it sounds impossible: a **playing, persistent room with a
 * non-empty playlist** whose position was last set by a watcher who has since
 * left, rejoined within one election age of the last `_lastUpdate` write.
 * `removeWatcher` (`server.py:640-647`) leaves `_setBy` and `_playState` alone;
 * `_deleteRoomIfEmpty` (`server.py:496`) spares an empty room that is permanent
 * (`server.py:497`) or persistent with a non-empty playlist
 * (`server.py:499`); and `removeWatcher` zeroes `_position`
 * (`server.py:645-646`) only when the room is not persistent. The window is
 * narrow because `Room.getPosition` (`server.py:597-603`) overwrites `_setBy`
 * with `min(watchers)` (`server.py:601`) as soon as anyone is seated and the
 * room state is older than the election age. It is also strictly
 * **in-process**: a DB reload cannot produce a departed name, because
 * `loadRooms` builds a fresh `Room` (`server.py:427`) and `loadRoom`
 * (`server.py:586-592`) restores name, playlist, index, position and saved
 * stamp — never `_setBy`.
 *
 * So the constructor's `_lastUpdate` stamp plus this seed models **a
 * `server.py:603` election whose winner has since left**. It does *not* model
 * `Room.__init__`, which can never open a window carrying a *name*, since
 * `server.py:547`'s stamp always comes paired with `server.py:544`'s `None` —
 * and the census of `_lastUpdate`'s writers that argument rests on is already
 * recorded in `forcePositionUpdate`'s own comment below.
 *
 * The value has to be a username **no seated watcher holds**, or a fixture
 * asserting "the room is not ours" would pass for the wrong reason. That is a
 * standing constraint on the fixtures rather than a property of this line, so
 * `test/services/syncplay-min-election-setby.test.ts` censuses the seated names
 * and holds it.
 */
export const DEFAULT_PLAYING_SET_BY = 'departeduser'

/**
 * `PROTOCOL_TIMEOUT` — how long a watcher may go without sending a `State`
 * before the reference drops it, in **milliseconds**.
 *
 * Upstream writes it in seconds, `constants.py:76 ("PROTOCOL_TIMEOUT = 12.5")`;
 * this is the same number in the unit every other duration in this file carries.
 *
 * ONE DECLARATION, TWO READERS, AND NEITHER MAY SPELL THE NUMBER OUT. The
 * readers are `sendState`'s drop test below and
 * `conformance/syncplay-protocol-timeout.conformance.ts`'s idle budget, which
 * writes its wait as `PROTOCOL_TIMEOUT_MS + IDLE_MARGIN_MS` rather than as
 * 15000. The vitest band in `test/services/syncplay-protocol-timeout.test.ts`
 * derives both its edges from this and `stateIntervalMs` rather than writing
 * 13000. A literal anywhere would let an upstream version bump move the
 * reference's rule while the fixtures kept asserting the old one — which is
 * "assert the mechanism, never the threshold" applied to the harness's own
 * clock.
 *
 * The drop itself is **off by default**: see `protocolTimeoutMs`. So this
 * constant states the reference's duration rather than this model's behaviour
 * until a caller asks for it.
 */
export const PROTOCOL_TIMEOUT_MS = 12_500

export interface MinElectionServerOptions {
  /** The room name the `Hello` and `List` replies are keyed to. */
  room?: string
  /** Where the room already is when the fixture starts. */
  position?: number
  paused?: boolean
  /**
   * Who the room's position was last set by, before the first election. The
   * default is the reference's pairing rule rather than a free field: a paused
   * room seeds `null`, as `Room.__init__` does (`server.py:543-544`), and a
   * playing one seeds `DEFAULT_PLAYING_SET_BY` — see that constant for why the
   * playing-and-nameless combination the fixture used to allow is a state the
   * reference cannot reach.
   *
   * Pass a name to model a particular departed setter. An explicit `null` is
   * **not** an escape hatch — `??` reads it as "unset", so it lands back on the
   * pairing rule — and that is deliberate rather than an oversight of the
   * nullable type: a nameless *playing* room is exactly the state the reference
   * cannot reach, so nothing should be able to ask for one. The `| null` is
   * there so a caller can spell the paused default out at a call site that also
   * chooses `paused`, without the two options disagreeing.
   *
   * Either way the seed survives only until the first `Room.getPosition()`
   * election, which overwrites it with the elected watcher (`server.py:601`);
   * with the default 1 s `electionAgeMs` and a watcher already seated, that is
   * one tick.
   */
  setBy?: string | null
  /** `SERVER_STATE_INTERVAL` — the reference's 1 s periodic `State`. */
  stateIntervalMs?: number
  /** `Room.getPosition()` re-elects when the room state is older than this. */
  electionAgeMs?: number
  /**
   * The `fd` rule in `Watcher.updateState`'s `position + forwardDelay` store
   * (`server.py:875-884`). `'avrRtt/2'` — the default — is the reference's own
   * rule, i.e. one one-way delay for a symmetric link. A number is a fixed
   * value in **seconds**: `0` models a server whose RTT estimate never
   * converged (no echo ever reaches it), and a larger constant models one that
   * over-compensates. #279 is written against the `2d − fd` relationship this
   * knob is the free variable of.
   */
  forwardDelay?: 'avrRtt/2' | number
  /**
   * Whether the echo of `clientLatencyCalculation` carries the server's own
   * hold correction. `true` is the reference's rule — `Watcher.getLatency
   * Calculation()` adds the time the server sat on our stamp waiting for its
   * next 1 Hz broadcast, the mirror image of our `consumeServerLatencyEcho()`
   * — and makes the client's `serverRtt` read the network RTT (`2d`).
   *
   * `false` models a server that echoes our stamp **verbatim**, billing the
   * hold to the network: measured here, a client's `serverRtt` reads ~1.05 s
   * against a 100 ms link. That is not hypothetical — it is exactly the failure
   * our own echo correction exists to spare the server — and it is the sample
   * #279's clamp on `serverRtt / 2` is sized for.
   *
   * **Default `true`: this shared harness models the reference.** The knob
   * arrived with #279 defaulting to `false`, because the #277 fixture had been
   * written and merged against the uncorrected echo and one of its cases ("lets
   * the joiner converge and adopt") sat *on* `ADOPT_TOLERANCE_S` under the
   * correction — 3.0000000477 s against a 3 s bound, with the inflated
   * `serverRtt` over-compensating `handleState()`'s `position + serverRtt / 2`
   * in the other direction. #279's own anchor back-dating changed that
   * arithmetic (the same fixture now reads 3.10 s corrected, 3.15 s with the
   * fix reverted), so the constraint that bought the `false` default is gone
   * and the default is the reference's rule. A case that wants the verbatim
   * echo — #279's clamp, which is *sized* for that sample — opts out with
   * `echoHoldCorrection: false`.
   */
  echoHoldCorrection?: boolean
  /**
   * `PROTOCOL_TIMEOUT` as a modelled disconnect: how long a watcher may go
   * without sending a `State` before `sendState` removes it from the room and
   * stops writing to its socket. `null` — **the default** — never drops, which is
   * what every fixture written before #384's item 4 assumes.
   *
   * **An explicit `null` here IS the escape hatch**, and that is worth saying
   * because `setBy` four interfaces up establishes the opposite convention: there
   * `??` reads an explicit `null` as "unset" and lands it back on the pairing
   * rule, deliberately, because a nameless playing room is a state the reference
   * cannot reach. There is no such impossible state here. `null` means "model a
   * server that never times anyone out", the resolver is `?? null`, and spelling
   * it at a call site that is sweeping the value is the normal way to name the
   * off end of the sweep.
   *
   * `number | null` rather than a boolean for that sweep's sake: the band this
   * feature is pinned over is measured by varying the *duration* from the call
   * site — `conformance/README.md` records both edges — and a boolean would make
   * `PROTOCOL_TIMEOUT_MS` the only value anything could ever ask for.
   *
   * The drop is quantised by `stateIntervalMs`, not by this number, because
   * upstream samples the test on its 1 Hz tick: pass `12_500` with a 1 s interval
   * and the earliest drop is at 13 s. See the header block for the rest.
   */
  protocolTimeoutMs?: number | null
}

export interface SeatOptions {
  username: string
  /** Symmetric one-way link delay, in ms. `0` is the localhost case, where #277 does not exist. */
  delayMs?: number
  /** The socket `net.createConnection` handed the client for this seat. */
  plain: ModelSocket
  /**
   * Called immediately after the TLS probe reply is delivered — i.e. once
   * `upgradeToTls()` has run and `tls.connect()` has minted the real socket.
   */
  takeTls: () => ModelSocket
}

/** One row of the `[ELECT]` log the diagnosis in #277 was read off. */
export interface Election {
  at: number
  setBy: string
  /**
   * Every watcher the `min()` considered, and where it read at that instant.
   * Since #307 that is **all** of them, fileless ones included — the reference
   * orders a fileless watcher last rather than dropping it from the iterable,
   * so a room whose watchers have not announced yet still holds an election and
   * still names a `setBy`. The shape is unchanged; the membership is not, and
   * a fixture counting rows or keys here has to say which it means.
   */
  positions: Record<string, number>
}

/**
 * One outbound playstate, as the client put it on the wire — stamped at *send*
 * rather than at receipt, so it can be read against ground truth without the
 * link delay folded in. `elections` says what the server made of these; this
 * says what we asserted, which is the quantity #279 is about.
 */
export interface WireFrame {
  at: number
  username: string
  position: number
  /** Absent exactly when the frame made no pause claim — i.e. a spectator mirror. */
  paused?: boolean
  doSeek?: boolean
  /**
   * Where the server's room read at that same instant. `position - room` is the
   * quantity #279 turns on: negative is a mirror below the room (it wins the
   * election and the room is re-derived from it), zero is a mirror that agrees,
   * positive is one that has over-corrected past it.
   */
  room: number
}

interface Watcher {
  username: string
  socket: ModelSocket
  delayMs: number
  /** `Watcher._position` — already forward-delay-compensated on store. */
  position: number
  /** A mirror sends no `paused` key, so this stays `false` for one. */
  paused: boolean
  /**
   * `Watcher._file`. `null` orders the watcher **last** in the election rather
   * than removing it from the iterable (`__lt__`, `server.py:834-839`), so it
   * can still win — and set the room's position, `setBy` and cadence — in a room
   * where nobody has announced. `''` is the reference's non-`None` empty
   * mapping (`Set: {file: {}}`), which is file-bearing membership.
   */
  file: string | null
  ready: boolean
  /** `Watcher._lastUpdatedOn`, stamped at receipt. */
  lastUpdatedOn: number
  /** The client's own timestamp, echoed back so its RTT calibration works. */
  latencyEcho: number | null
  /** When that timestamp arrived, for the hold correction on the way out. */
  latencyEchoArrivedAt: number
}

type JsonRecord = Record<string, unknown>

const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null

export class MinElectionServer {
  /** Every re-election, in order — the fixture's window onto the mechanism. */
  readonly elections: Election[] = []
  /** Every outbound playstate, in order, as its client sent it. */
  readonly wire: WireFrame[] = []

  private readonly room: string
  private readonly stateIntervalMs: number
  private readonly electionAgeMs: number
  private readonly forwardDelay: 'avrRtt/2' | number
  private readonly echoHoldCorrection: boolean
  private readonly protocolTimeoutMs: number | null
  private readonly watchers = new Map<string, Watcher>()
  private roomPosition: number
  private roomPaused: boolean
  private roomSetBy: string | null
  private roomLastUpdate: number
  private serverCounter = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: MinElectionServerOptions = {}) {
    this.room = opts.room ?? 'cinema'
    this.roomPosition = opts.position ?? 0
    this.roomPaused = opts.paused ?? false
    // Paired with the pause flag, never free: see `DEFAULT_PLAYING_SET_BY`.
    this.roomSetBy = opts.setBy ?? (this.roomPaused ? null : DEFAULT_PLAYING_SET_BY)
    this.stateIntervalMs = opts.stateIntervalMs ?? 1000
    this.electionAgeMs = opts.electionAgeMs ?? 1000
    this.forwardDelay = opts.forwardDelay ?? 'avrRtt/2'
    this.echoHoldCorrection = opts.echoHoldCorrection ?? true
    // `?? null`, and an explicit `null` reaches the same place an absent option
    // does on purpose — unlike `setBy` above, where that collapse is the point.
    this.protocolTimeoutMs = opts.protocolTimeoutMs ?? null
    this.roomLastUpdate = Date.now()
    this.timer = setInterval(() => this.broadcastPeriodicState(), this.stateIntervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Where the room reads *right now*, without running an election. */
  roomState(): { position: number; paused: boolean; setBy: string | null } {
    return { position: this.projectedRoom(), paused: this.roomPaused, setBy: this.roomSetBy }
  }

  /** The elections that named `username` as the `min()` watcher. */
  electionsSetBy(username: string): Election[] {
    return this.elections.filter((e) => e.setBy === username)
  }

  /** Every playstate `username` put on the wire, in send order. */
  wireOf(username: string): WireFrame[] {
    return this.wire.filter((f) => f.username === username)
  }

  /**
   * Drive one client all the way to `ready`. The handshake is delivered without
   * the link delay — it only moves `t0`, and every property under test lives in
   * the steady state — while every `State` after it pays the delay in both
   * directions, which is the whole point of the fixture.
   */
  seat(opts: SeatOptions): void {
    const now = Date.now()
    const watcher: Watcher = {
      username: opts.username,
      socket: opts.plain,
      delayMs: opts.delayMs ?? 0,
      // Seeded from the room rather than the reference's 0. A watcher with no
      // file is not a candidate, so the seed is only ever read in the sliver
      // between `Set: {file}` and that client's next `State` — where a 0 would
      // model #220 (a fresh joiner dragging the room to the start) on top of
      // the bug under test and make the fixture about two things.
      position: this.projectedRoom(),
      paused: this.roomPaused,
      file: null,
      ready: true,
      lastUpdatedOn: now,
      latencyEcho: null,
      latencyEchoArrivedAt: now
    }
    this.watchers.set(opts.username, watcher)

    opts.plain.write = (data: string): void => this.receive(opts.username, data)
    opts.plain.emit('connect')
    // The probe reply above ran `upgradeToTls()` synchronously, so the real
    // socket exists by now.
    const tls = opts.takeTls()
    watcher.socket = tls
    tls.write = (data: string): void => this.receive(opts.username, data)
    tls.emit('secureConnect')
  }

  // --- the election ------------------------------------------------------

  /** `Watcher.updateState`'s `forwardDelay`, in seconds, for this watcher. */
  private forwardDelayFor(w: Watcher): number {
    return this.forwardDelay === 'avrRtt/2' ? w.delayMs / 1000 : this.forwardDelay
  }

  private watcherPosition(w: Watcher): number {
    // `Watcher.getPosition()` (server.py:780-787) advances by wall time iff the
    // **room** is playing, not iff this watcher is paused — a watcher that
    // claimed `paused: true` in a playing room still walks with the room.
    return this.roomPaused ? w.position : w.position + (Date.now() - w.lastUpdatedOn) / 1000
  }

  /**
   * `Watcher.__lt__` (`server.py:834-839`), file arm only — the position arm is
   * unreachable here, per the header's unmodelled-unknown-position note.
   *
   * Strict, and asymmetric on purpose: a fileless watcher is less than nothing,
   * and everything with a file is less than a fileless one. Fed to a Python-
   * shaped `min()` — a running best replaced only on a strict `<` — that keeps
   * the **first inserted** watcher when no comparison ever succeeds, which is
   * exactly what an all-fileless room elects.
   */
  private watcherLessThan(a: Watcher, b: Watcher): boolean {
    if (a.file === null) return false
    if (b.file === null) return true
    return this.watcherPosition(a) < this.watcherPosition(b)
  }

  private projectedRoom(): number {
    if (this.roomPaused) return this.roomPosition
    return this.roomPosition + (Date.now() - this.roomLastUpdate) / 1000
  }

  /** `Room.getPosition()` — re-elects `min(watchers)` past `electionAgeMs`. */
  private electRoomPosition(): number {
    const now = Date.now()
    // `>=`, not the reference's bare `>`: the reference's own `LoopingCall`
    // jitters either side of the second it schedules, so it re-elects on every
    // tick, which is what the `[ELECT]` log in #277 shows. A strict `>` against
    // a fixed 1000 ms interval that is *exactly* `electionAgeMs` would model a
    // server that elects every other second — a fixture artefact, not the
    // reference.
    if (now - this.roomLastUpdate >= this.electionAgeMs) {
      // Every watcher, not the file-bearing ones (#307). `min()` is a fold over
      // the whole mapping and `__lt__` is what puts a fileless watcher last, so
      // the empty-**room** guard below is the only one the reference has. The
      // difference is visible: a room in which nobody has announced yet elects
      // its first-inserted watcher, writes `_position`/`_setBy` from it and
      // resets `_lastUpdate`, where a filter held no election at all and let the
      // room's age run on.
      const candidates = [...this.watchers.values()]
      if (candidates.length > 0) {
        let min = candidates[0]
        for (const c of candidates) {
          if (this.watcherLessThan(c, min)) min = c
        }
        this.roomPosition = this.watcherPosition(min)
        this.roomSetBy = min.username
        this.roomLastUpdate = now
        this.elections.push({
          at: now,
          setBy: min.username,
          positions: Object.fromEntries(
            candidates.map((c) => [c.username, this.watcherPosition(c)])
          )
        })
      }
    }
    return this.projectedRoom()
  }

  private forcePositionUpdate(w: Watcher, doSeek: boolean): void {
    // Reference order: `updateState` flips the room's pause flag
    // (`Room.setPaused`) and only then does the forced update read
    // `watcher.getPosition()` (`server.py:180-187`) — so the flag is already
    // flipped by the time we read the position, and nothing here writes it.
    this.roomPosition = this.watcherPosition(w)
    this.roomSetBy = w.username
    // `_lastUpdate` is deliberately **not** written here. On the plain `Room` the
    // reference writes it in exactly two places — `Room.__init__` (`server.py:547`)
    // and `Room.getPosition()`'s election branch (`:603`); the managed-room
    // subclass we do not model adds a third (`ControlledRoom.getPosition`, `:686`).
    // Meanwhile `Room.setPosition` (`615-620`) sets `_position`, re-seats the
    // watchers and sets `_setBy`, and `forcePositionUpdate` (`180-187`) touches
    // nothing else (#282 review). Two artefacts follow, and both are the point
    // rather than a rough edge:
    //  - the age gating re-election is measured from the last *election*, so a
    //    seek or a pause buys no protection from the next one. Measured on the
    //    seek case: the first election after the forced update lands 450 ms
    //    later, not the 1450 ms a reset here manufactures.
    //  - `getPosition()` then projects the freshly written `_position` from that
    //    stale stamp (`:606`), so a *playing* room reads ahead of the playhead
    //    the forced update just set, by the room's age — 0.601 s on that same
    //    case, against the 0.051 s of forward delay alone that a reset leaves.
    //    #279 is the room ratcheting through exactly this loop, so a harness
    //    that reset the age would report that error as ~0 and answer #279
    //    confidently and wrongly.
    //
    // `Room.setPosition()` re-seats **every** watcher onto the new room position
    // (`server.py:615-620`) and deliberately leaves their `_lastUpdatedOn`
    // alone, so each one then projects forward from its own stale stamp.
    // Modelled literally, stale stamp included: this is the instant the room
    // stops being the laggard's — the recovery the user reported as "we
    // synchronized only when he paused" — and with the room's age no longer
    // reset, it is what *holds* the room. Delete this loop and the pause-recovery
    // and seek-retention cases both go red: the mirror keeps its stale value and
    // takes the room straight back on the election 450 ms later. Under the old
    // reset the same mutation was invisible, because the manufactured second let
    // our own mirror re-anchor first — a redundancy that only ever existed
    // because every watcher in these fixtures is *our* client, where a real
    // Syncplay peer asserts its own player position and is re-seated by nothing
    // else.
    //
    // Both loops iterate a **snapshot**, mirroring `Room.getWatchers()`'s
    // `server.py:632` ("return list(self._watchers.values())"), which is what
    // every broadcast path upstream walks. Behaviourally identical while nothing
    // is removed; it matters once `sendState` can remove, because the second
    // loop below reaches the drop test and a live `Map` iterator would then be
    // mutated underneath itself.
    const seated = [...this.watchers.values()]
    for (const other of seated) other.position = this.roomPosition
    this.serverCounter += 1
    const playstate = {
      position: this.roomPosition,
      paused: this.roomPaused,
      doSeek,
      setBy: this.roomSetBy
    }
    for (const other of seated) {
      this.sendState(other, playstate, this.serverCounter)
    }
  }

  /**
   * `SyncFactory.removeWatcher` + `Room.removeWatcher`, folded into one call
   * because this model has no `RoomManager` layer between them. See the header
   * block for the upstream anchors, for what is deliberately unmodelled, and for
   * why the frame is the literal leave notice rather than a fresh `List`.
   *
   * Order is load-bearing in two places. The notice goes out **before** the
   * delete, so the departing watcher is still reachable and still has a room to
   * be named in — and it goes to a snapshot taken before the delete for the same
   * reason, so the departing watcher is one of the recipients. Idempotent, as
   * upstream's own guard is, so a second drop tick is a no-op rather than a
   * second notice.
   */
  private removeWatcher(w: Watcher): void {
    if (!this.watchers.has(w.username)) return
    const notice = {
      Set: { user: { [w.username]: { room: { name: this.room }, event: { left: true } } } }
    }
    for (const other of [...this.watchers.values()]) {
      this.send(other.username, notice, other.delayMs)
    }
    this.watchers.delete(w.username)
  }

  // --- the wire ----------------------------------------------------------

  private receive(username: string, data: string): void {
    for (const line of data.split('\r\n')) {
      if (!line.trim()) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(msg)) continue
      if ('TLS' in msg) {
        this.send(username, { TLS: { startTLS: 'true' } })
        continue
      }
      if ('Hello' in msg) {
        this.send(username, {
          Hello: { username, room: { name: this.room }, version: '1.7.6' }
        })
        // The reference's **join-time** `State`, which this fixture used to omit
        // entirely. `Watcher.__init__` schedules `_scheduleSendState` through
        // `reactor.callLater(0.1, ...)` (`server.py:737`), and the `LoopingCall`
        // that call starts (`server.py:841-843`) fires its first tick
        // immediately rather than one interval in — so a watcher gets a full
        // `State` about 0.1 s after connecting, well before the room's first
        // periodic second. The *other* immediate frame is no tick: it is the
        // forced `doSeek` update `setRoom` asks for at `server.py:751`, and it
        // dies in `Watcher.sendState`'s `isLogged()` guard (`server.py:858-860`)
        // because `handleHello` adds the watcher before it sets `_logged`
        // (`protocols.py:558-559`). One such frame; the `Hello` reply sends it.
        //
        // Delivered through `sendState`, so it pays the link delay like every
        // other `State`: `seat()`'s doc comment exempts the *handshake* from the
        // delay, and a frame carrying a room position is not handshake.
        const joined = this.watchers.get(username)
        if (joined) {
          this.sendState(joined, {
            // `SyncFactory.sendState` reads `room.getPosition()` (`server.py:85`)
            // — the election, not a bare projection — and `room.getSetBy()` only
            // after it (`server.py:86`). So a join landing inside the election
            // age holds no election and carries the `setBy` the room already had,
            // which on a fresh room is whatever the constructor seeded.
            position: this.electRoomPosition(),
            paused: this.roomPaused,
            doSeek: false,
            setBy: this.roomSetBy
          })
        }
        continue
      }
      if ('List' in msg) {
        this.sendList(username)
        continue
      }
      if ('Set' in msg && isRecord(msg.Set)) {
        this.applySet(username, msg.Set)
        continue
      }
      if ('State' in msg && isRecord(msg.State)) {
        const state = msg.State
        const w = this.watchers.get(username)
        if (!w) continue
        // The wire readout is taken *here*, at send time, before the frame pays
        // the delay: #279 measures what we asserted against where the room
        // truly was at that instant, and stamping it at receipt would fold one
        // of the two delays under test into the measurement.
        const sent = isRecord(state.playstate) ? state.playstate : null
        if (sent) {
          this.wire.push({
            at: Date.now(),
            username,
            position: typeof sent.position === 'number' ? sent.position : 0,
            ...(typeof sent.paused === 'boolean' ? { paused: sent.paused } : {}),
            ...(typeof sent.doSeek === 'boolean' ? { doSeek: sent.doSeek } : {}),
            // Read, not elected: `projectedRoom()` rather than
            // `electRoomPosition()`, so taking the readout can never move the
            // room the fixture is measuring.
            room: this.projectedRoom()
          })
        }
        // Inbound frames pay the link delay: the number inside was computed at
        // the client's send, and the server stamps it at arrival.
        setTimeout(() => this.applyState(username, state), w.delayMs)
        continue
      }
    }
  }

  private applySet(username: string, set: JsonRecord): void {
    const w = this.watchers.get(username)
    if (!w) return
    let rosterDirty = false
    // Three distinct cases, and `isRecord(null)` being `false` used to collapse
    // two of them into "no command" (#307).
    //
    //  - an object → `Watcher.setFile` stores it. A `name` makes it a real file;
    //    `{}` is a non-`None` empty mapping, which `__lt__`'s `is None` test
    //    still counts as membership. Modelled as `''`.
    //  - `null` → the guard `if file_ and "name" in file_:` is falsey, and the
    //    reference stores `None`. This is the clear #307's `playerClosed()`
    //    sends, and it is the one form that takes a watcher out of the ordering.
    //  - absent → the `Set` dispatch never reaches `setFile` at all. Untouched.
    if (isRecord(set.file)) {
      w.file = typeof set.file.name === 'string' ? set.file.name : ''
      rosterDirty = true
      // `sendFileUpdate`'s guard is `if watcher.getFile():` — a *truthiness*
      // test, and `{}` is falsey in Python just as `None` is. So the empty
      // mapping keeps its seat in the election and still announces nothing.
      // Found by `conformance/syncplay-file-membership.conformance.ts`, which
      // captured `real=[] model=[{"user":"bravo","file":null}]`: this branch
      // used to relay unconditionally.
      if (Object.keys(set.file).length > 0) this.sendFileUpdate(username, set.file)
    } else if (set.file === null) {
      w.file = null
      rosterDirty = true
      // No broadcast: `sendFileUpdate` (`server.py:175-178`) refuses a falsey
      // file, which is exactly why `sendClearFile()`'s own comment in
      // `src/main/syncplay.ts` says peers converge on the next `List` instead.
      // The roster refresh below is that `List`.
    }
    if (isRecord(set.ready) && typeof set.ready.isReady === 'boolean') {
      w.ready = set.ready.isReady
      rosterDirty = true
    }
    // A fresh `List` to everyone stands in for the reference's `Set: {user}`
    // broadcast — same effect on `roomUsers`, one code path.
    if (rosterDirty) for (const other of this.watchers.keys()) this.sendList(other)
  }

  /**
   * `sendFileUpdate` (`server.py:175-178`): a watcher's `Set: {file}` is pushed
   * on to the room as `Set: {user: {<name>: {room, file}}}`, the file object
   * relayed **whole** — `features.animeDlAppMeta` and all, which is what makes
   * it the one and only path `remote-episode-change` has. The `List` refresh
   * `applySet` sends alongside is the roster; this is the announcement, and the
   * two are not interchangeable: this repo's `List` reply synthesises its file
   * entries and carries no `features`, so a fixture reading the episode change
   * off `roomUsers` would read `undefined`.
   *
   * **No sender exclusion**, which is the reference's own shape rather than an
   * oversight here: `handleSet`'s Rule 0 in `src/main/syncplay.ts` states it and
   * depends on it ("our own file push is broadcast back to us without sender
   * exclusion, and absorbRemoteFile is what keeps our roster row's file current
   * between `List` replies"). Main's own `username !== this.config?.username`
   * guard is what keeps that echo from announcing an episode change to the peer
   * that made it, and modelling an exclusion here would hide a regression in it.
   */
  private sendFileUpdate(username: string, file: JsonRecord): void {
    const payload = { Set: { user: { [username]: { room: { name: this.room }, file } } } }
    for (const w of this.watchers.values()) this.send(w.username, payload, w.delayMs)
  }

  private applyState(username: string, state: JsonRecord): void {
    const w = this.watchers.get(username)
    if (!w) return
    if (isRecord(state.ping) && typeof state.ping.clientLatencyCalculation === 'number') {
      w.latencyEcho = state.ping.clientLatencyCalculation
      w.latencyEchoArrivedAt = Date.now()
    }
    const ps = isRecord(state.playstate) ? state.playstate : null
    // Stamped at receipt, above the playstate guard. `Watcher.updateState`
    // (`server.py:875`) writes `_lastUpdatedOn` at `server.py:877` as its second
    // statement — above the pause flip, above `setPosition` and above the
    // `if position is not None` guard the position work sits behind — and
    // `Watcher.sendState` reads that stamp against `PROTOCOL_TIMEOUT`
    // (`server.py:861`). Kept below this early return it would be the model's own
    // artefact rather than the reference's.
    w.lastUpdatedOn = Date.now()
    if (!ps) return
    const position = typeof ps.position === 'number' ? ps.position : 0
    const hasPaused = typeof ps.paused === 'boolean'
    const pausedChanged = hasPaused && ps.paused !== this.roomPaused
    // `+ forwardDelay` on store, `lastUpdatedOn` at receipt: the two axes that
    // make the correction land somewhere other than the error. Only for a frame
    // whose `paused` is falsy or absent, as in `_updatePositionByAge`
    // (`server.py:870-873`) — `not None` is true, so a mirror is compensated and
    // an explicit `paused: true` is stored raw. The `fd` term is the harness's
    // free variable (`forwardDelay`), because #279's deficit is `2d − fd` and a
    // single measurement at the reference's own `fd = avrRtt/2` cannot tell that
    // apart from a bare `d`.
    w.position = position + (ps.paused === true ? 0 : this.forwardDelayFor(w))
    if (hasPaused) w.paused = ps.paused as boolean
    // `Room.setPaused` only on a change (`server.py:876-879`); the forced update
    // reads `room.isPaused()` and never writes it. Unconditionally mirroring the
    // watcher's flag from inside the forced update would let a `doSeek` frame
    // that carries no `paused` key overwrite the room's flag with that watcher's
    // last stored one — `__hasPauseChanged(None)` is `False` in the reference, so
    // the room's flag survives such a frame untouched.
    if (pausedChanged) this.roomPaused = ps.paused as boolean
    if (ps.doSeek === true || pausedChanged) this.forcePositionUpdate(w, ps.doSeek === true)
  }

  private broadcastPeriodicState(): void {
    if (this.watchers.size === 0) return
    const position = this.electRoomPosition()
    const playstate = {
      position,
      paused: this.roomPaused,
      doSeek: false,
      setBy: this.roomSetBy
    }
    // A snapshot, as `forcePositionUpdate` takes: `sendState` below can remove a
    // watcher, and `Room.getWatchers()` hands out a `list(...)` rather than a
    // live view.
    for (const w of [...this.watchers.values()]) this.sendState(w, playstate)
  }

  private sendState(w: Watcher, playstate: JsonRecord, serverCounter?: number): void {
    const ping: JsonRecord = { latencyCalculation: Date.now() / 1000 }
    if (w.latencyEcho !== null) {
      // `Watcher.getLatencyCalculation()` adds the hold — the time the server
      // sat on our stamp waiting for its next 1 Hz broadcast — so the client's
      // `now − echo` is the network RTT and not the RTT plus a broadcast
      // interval. Switching it off is what makes a client's `serverRtt` read
      // ~1.1 s on a 100 ms link, which is the sample #279's clamp is sized for.
      ping.clientLatencyCalculation = this.echoHoldCorrection
        ? w.latencyEcho + (Date.now() - w.latencyEchoArrivedAt) / 1000
        : w.latencyEcho
      w.latencyEcho = null
    }
    const frame: JsonRecord = { ping, playstate }
    if (serverCounter !== undefined) frame.ignoringOnTheFly = { server: serverCounter }
    this.send(w.username, { State: frame }, w.delayMs)
    // After the send, never before: upstream puts the frame on the wire at
    // `server.py:860 ("self._connector.sendState(position, paused, doSeek, setBy, forcedUpdate)")`
    // and only then tests the clock at
    // `server.py:861 ("if time.time() - self._lastUpdatedOn > constants.PROTOCOL_TIMEOUT:")`.
    // What holds the ordering is vitest case 7's playstate **count** — one
    // `State` per tick up to and including the drop tick, `edge /
    // STATE_INTERVAL_MS` of them — and not the shape of its last two frames. A
    // test placed above the send would eat the drop tick's own `State` and leave
    // that count one short. The last-two-frames assertions cannot tell the two
    // orders apart: with that frame gone the notice is simply preceded by the
    // tick before it, which carries a playstate too.
    if (this.protocolTimeoutMs !== null && Date.now() - w.lastUpdatedOn > this.protocolTimeoutMs) {
      this.removeWatcher(w)
    }
  }

  private sendList(username: string): void {
    const entry: JsonRecord = {}
    for (const w of this.watchers.values()) {
      // `protocols.py:695` renders a `None` file as `file: {}` — the key is
      // present and empty, not absent (#307). Main maps both forms to `null`, so
      // the change is reference fidelity rather than a renderer-visible one; it
      // is worth making because `{}` is the shape every fixture reading a real
      // server's reply will see, and a helper that omitted the key would train
      // assertions the reference cannot satisfy.
      entry[w.username] = {
        isReady: w.ready,
        position: 0,
        file: w.file === null ? {} : { name: w.file, duration: 1440, size: 1 }
      }
    }
    this.send(username, { List: { [this.room]: entry } })
  }

  /**
   * One frame out, optionally one link delay late.
   *
   * The entry guard is a membership test — a call for a watcher that is no longer
   * seated sends nothing — but the socket is captured **at call time** rather than
   * re-looked-up in `deliver()`, and the difference is only visible once
   * `sendState` can remove a watcher. With a non-zero `delayMs` (50–1500 ms
   * across `test/services/`), a re-lookup would make a frame that was queued and
   * then overtaken by a removal vanish — so the drop tick's own `State` would be
   * eaten, which contradicts both the upstream order that puts
   * `server.py:860 ("self._connector.sendState(position, paused, doSeek, setBy, forcedUpdate)")`
   * ahead of `server.py:863 ("self._connector.drop()")` and
   * Twisted's flushing `loseConnection`. **This is the one change here argued from
   * transport semantics rather than from source text**, and `test/services/
   * syncplay-protocol-timeout.test.ts` case 7 is what holds it.
   */
  private send(username: string, obj: unknown, delayMs = 0): void {
    const w = this.watchers.get(username)
    if (!w) return
    const frame = JSON.stringify(obj) + '\r\n'
    const socket = w.socket
    const deliver = (): void => {
      socket.emit('data', Buffer.from(frame))
    }
    if (delayMs <= 0) deliver()
    else setTimeout(deliver, delayMs)
  }
}
