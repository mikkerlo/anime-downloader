# Syncplay conformance harness

`test/helpers/syncplay-min-election-server.ts` is a hand-built model of the
Syncplay server's room election. Every two-peer fixture in `test/services/`
believes it. This directory is the only thing in the repo that checks whether it
is true, by replaying the same scenarios against a **real Syncplay 1.7.6 server**
and comparing the two on the wire.

It does not run in the `quality` gate. It needs a Python server on the machine,
it takes about five minutes of wall clock, and it is a claim about an upstream
project rather than about this one — so it runs nightly and on demand
(`.github/workflows/syncplay-conformance.yml`), and `npm run test` stays the
thing that gates a PR.

## Running it

```bash
python3 -m venv /tmp/sp176
/tmp/sp176/bin/pip install --no-deps \
  'git+https://github.com/Syncplay/syncplay@993232ab095bb810593459bc705b3e6fc64ad161'
/tmp/sp176/bin/pip install twisted certifi pem
SYNCPLAY_SERVER_BIN=/tmp/sp176/bin/syncplay-server npm run test:conformance
```

The commit is pinned, not the tag: `1.7.6` on PyPI is a different artefact from
the 1.7.6 source tree, and the whole point is to compare against a known
`server.py`. `conformance/helpers/real-server.ts` holds the same constant so a
run can say which server it proved anything about.

Two things worth knowing before wiring this into a runner:

- `--no-deps` is not a shortcut. The declared dependency set pulls PySide6 and
  PySide6_Addons — about 255 MB of Qt for a GUI the server entry point never
  starts — and takes the venv from 58 MB to 726 MB. The three named above are
  what it actually imports, verified by running the election suite green against
  exactly this install. `pip check` still complains about the missing PySide6
  marker afterwards, and that is expected rather than a warning to fix;
- if `SYNCPLAY_SERVER_BIN` is unset the harness looks for `syncplay-server` on
  `PATH`, and if it finds nothing it **throws**. It does not skip. A conformance
  suite that quietly passes because it never ran is the failure mode this
  directory exists to rule out. That claim is checked rather than asserted:
  `test/conformance-harness.test.ts` runs in `quality` and fails if a missing
  binary produces anything but a prompt `ENOENT`.

## What is compared

On the wire, not in the model's fields. Reaching into `MinElectionServer` to ask
what it thinks it did is asking the thing under test. A scenario is a list of
steps driven through real sockets against one backend and then the other, and
the observables are what came back:

- `State.playstate` — `position`, `paused`, `doSeek`, `setBy`;
- `Set: {user: {…}}` relays carrying a `file`, in arrival order;
- the `List` roster, on request.

`conformance/helpers/trace-diff.ts` holds both tolerances with the measurement
each is set from, and the field-level ignore list — one entry per field, each
naming the seam it belongs to. The list is not decoration:
`syncplay-field-coverage.conformance.ts` walks every frame both backends sent
and fails if any field is neither compared nor ignored, in either direction. A
field arriving on the reference's wire that nobody has decided about reds the
suite.

## Declared differences

Two cadence differences are known, deliberate, and not compared. Both are about
*when* a frame is sent rather than what it says.

**Broadcast phase.** The reference schedules one `LoopingCall` per watcher
(`server.py:841-843`), armed by the last line of `Watcher.__init__`
(`server.py:737`) 0.1 s after that watcher connects; the model runs a single
shared `setInterval`. The two are independently phased, so a sampled frame can
be anywhere from fresh to a full `SERVER_STATE_INTERVAL` old on either side. In
a paused room that costs nothing — the reference freezes the playhead outright —
and in a playing room it is what `POSITION_TOLERANCE_PLAYING_S` is sized for.

**`List` cadence.** `MinElectionServer.applySet` pushes a fresh `List` to the
whole room whenever the roster changes, standing in for the reference's
`Set: {user}` broadcast. The reference sends a `List` only when a client asks.
So the harness reads the roster off a `List` it explicitly requested
(`Peer.requestList()`), which compares the *render* and not the cadence.
Reading whatever `List` happened to arrive reported a divergence on all five
election scenarios and said nothing about the election.

## Findings

Four things the real server settled that source reading alone had not.

**A seated-but-unheard watcher's position is known, not unknown.**
`Room.addWatcher` (`server.py:634-637`) seeds a joiner from
`Room.getPosition()` whenever the room is not empty, so it is a full election
candidate the moment it announces a file — no `State` required. Captured: bravo
never sent one, and the room flipped to `setBy: "bravo"` pinned at the join-time
seed while alpha's claim of 900 was discarded. The unknown-position arm of
`__lt__` is therefore reachable only for the *first* watcher in an empty room,
which is why the model's `seat()` seeding is faithful rather than a shortcut.

**`Set: {file: {}}` announces nothing.** `sendFileUpdate`'s guard
(`server.py:175-178`) is `if watcher.getFile():` — a truthiness test, and `{}`
is falsey in Python exactly as `None` is. The empty mapping still keeps its seat
in the election, because `__lt__` asks `self._file is None`. The model relayed it
unconditionally; `syncplay-file-membership.conformance.ts` caught it as
`real=[] model=[{"user":"bravo","file":null}]`, and the fix is in
`test/helpers/syncplay-min-election-server.ts` with a unit-scale regression in
`test/services/syncplay-file-announcement.test.ts` so the PR gate holds the line
the nightly found.

**The reference goes silent on an un-acked forced update.**
`protocols.py:761` is `if self.serverIgnoringOnTheFly == 0 or forced:`, so a
watcher that has not echoed the counter stops receiving its periodic `State`
entirely — not merely having its own inbound frames discarded by
`protocols.py:788-789`. A peer that did not ack read as a model divergence of
1.8 s and a flipped `setBy` that were really the reference saying nothing. The
harness's peers ack immediately, which is what a conforming client does.

**A `PROTOCOL_TIMEOUT` drop announces itself, and the roster is live rather than
cached.** This is the one finding here that was *designed* as a finding:
`syncplay-protocol-timeout.conformance.ts` was written and run before
`MinElectionServer` could drop anyone, so its first run was red by construction
and the reference half of that red is the evidence. `conf-timeout-idle-drop`
holds `quiet` silent in `State` — while it keeps asking for rosters, so the
"traffic does not refresh" arm is exercised too — and keeps `pinger` alive on
ping-only frames alone. Captured against the pinned server, on `pinger`'s
socket, with `t` measured from that peer's first frame:

```
18103ms << {"State": {…, "playstate": {"position": 300, …, "setBy": "quiet"}}}
18106ms << {"Set": {"user": {"quiet": {"room": {"name": "conf-timeout-idle-drop"},
                                      "event": {"left": true}}}}}
19103ms << {"State": {…, "playstate": {"position": 500, …, "setBy": "pinger"}}}
20820ms << {"List": {"conf-timeout-idle-drop": {"pinger": {…, "file": {"name": "a.mkv", …}}}}}
```

Three things in four frames. The notice is a `Set: {user}` with an `event` and
**no `file` key**, so it is not a file relay and the suite's existing
`Set.user.[].event.*` ignore entry already covers it. The room re-elects on the
next tick, 500 and `pinger` replacing 300 and `quiet` — so a drop is visible as a
`playstate` flip and not only as a roster change. And the `List` the server
answers 1.7 s later carries one row, which is the half that tells a live removal
from a stale read. The drop itself landed 12.902 s after `quiet`'s last `State`,
on the tick after the one at 11.901 s: the comparison is a strict `>` sampled on
the 1 Hz `LoopingCall`, so 12.5 s is not the edge and 13 s is.

## The #307 mutation control

The suite's worth is whether it would have caught the bug it was built for. With
`electRoomPosition`'s candidate list mutated back into a *filter* —
`[...this.watchers.values()].filter((w) => w.file !== null)`, the shape head
carried before #307 — the all-fileless scenario reds, and both observables move
in opposite directions from the same step:

```
Error: scenario "conf-elect-all-fileless" — 4 divergence(s) at ±0.05s
  [nobody has a file] alpha.playstate.setBy: real="alpha" model="bravo"
  [nobody has a file] alpha.playstate.position: real=700 model=500
  [nobody has a file] bravo.playstate.setBy: real="alpha" model="bravo"
  [nobody has a file] bravo.playstate.position: real=700 model=500
```

A second scenario reds alongside it (`conf-elect-announce-beats`, where the
filtered model elects nobody at all and reports `setBy: null`). The mutation was
reverted; it is recorded here rather than left in a branch.

## The #384 mutation control, and the band it is green over

`conf-timeout-idle-drop` needs the same treatment and gets it twice over, because
it is the one scenario here whose assertion is a *removal* and removals are
invisible at the transport layer.

**With the model's drop switched off** — `protocolTimeout` dropped from the
scenario, which is also the state the scenario was first written and run in — it
reds with exactly three divergences, one label, and a 200 s position gap:

```
Error: scenario "conf-timeout-idle-drop" — 3 divergence(s) at ±0.05s
  [quiet timed out; the room re-elects to pinger at 500] pinger.playstate.setBy: real="pinger" model="quiet"
  [quiet timed out; the room re-elects to pinger at 500] pinger.playstate.position: real=500 model=300
  [quiet timed out; the room re-elects to pinger at 500] pinger.roster: real={"pinger":"a.mkv"} model={"pinger":"a.mkv","quiet":"b.mkv"}
```

All three on `pinger`, which is the point: `quiet` is the peer that goes, and a
peer that has gone reports nothing new, so the whole observable surface of a drop
is on the survivor.

**With the drop on, the duration swept.** The axis is the **model's**
`protocolTimeoutMs`, never the scenario's idle — moving the idle moves both
backends together and buys a green for the wrong reason. Twenty-six runs, each a
full real-plus-model pass:

| `protocolTimeoutMs` | verdict | why |
| --- | --- | --- |
| off (`null`) | red, 3 divergences | the model never drops; the control above |
| 3000, 3400, 3500 | red, 1 divergence (`roster`) | **`pinger`** is dropped too, so its final `List` is never answered and its roster is the stale one from the first sample |
| 4000 – 4500 | phase-dependent | both verdicts observed at 4000, 4400 and 4500 in different runs |
| 5000, 12500, 13000, 13400, 13500 | green | |
| 14000, 14400 | phase-dependent | green twice and red once at 14000 |
| 14500 – 14800 | red, 2 divergences | the model *does* drop `quiet`, one tick too late for the re-election to reach the sample; the roster agrees because the final `List` is still answered after the removal |
| 14900 – 17000 | red, 3 divergences | the model never drops before the sample at all |

**Neither edge localises to 100 ms, and that is a property of the mechanism
rather than a loose step list.** The threshold is read on the 1 Hz broadcast tick,
so any value measured through it carries ±1 `SERVER_STATE_INTERVAL` of phase
uncertainty, and `drive()` adds up to ~700 ms of accumulated `setTimeout` drift on
top (measured: one 2600 ms `wait` took 3212 ms). Both edges therefore reproduce as
*directions* with a one-tick shoulder, and both shoulders were measured rather
than inferred:

- **The floor is `pinger`'s largest tick-sampled idle**, which came out between
  3803 ms and 4897 ms over twelve backend runs — nominally
  `PING_EVERY_MS + LIST_MS`, 4400. Below the bottom of that range the scenario
  reds every time; above the top it is green every time.
- **The ceiling is how much of the run is left after the drop.** `quiet` is
  dropped at an idle of 12512–13241 ms against the 12 500 ms timeout — always
  inside one tick of it, which is the quantisation — leaving 2.0–3.2 s of tail,
  where the re-election needs one tick and the final `List` 400 ms. Push the
  timeout to 14 000 and the measured tail falls to 187 ms, which is the red above.

At the shipped `PROTOCOL_TIMEOUT_MS` the worst-case arithmetic is
`13500 + 1000 + 400 ≤ 15400`: the drop can be a full tick late, the re-election
takes another, and there is still ~900 ms spare before the sample. Green in six
independent runs at that value. It is the thinnest margin in this directory, so a
flake here is a reason to raise `PINGS` rather than to widen anything.

## What could not be reached

Recorded rather than quietly skipped, because an unrun scenario and a passing one
look the same from the outside.

**Everything latency-shaped.** Loopback `serverRtt` measured between 0.0003 s and
0.0013 s across every run here. That is three orders of magnitude below the
paused tolerance, so the `messageAge` perturbation
(`test/helpers/syncplay-min-election-server.ts:928` ("w.position = position +
(ps.paused === true ? 0 : this.forwardDelayFor(w))")), `forwardDelay`, and the
`echoHoldCorrection` echo are all unobservable: the model could compute them any
way at all and this suite would still report agreement. They stay owned by
`test/services/syncplay-two-peer-rtt.test.ts`, which can inject a link delay.
Adding an artificial delay here would mean delaying the model too, and a scenario
in which both sides are delayed by the same harness is measuring the harness.

**Multi-peer `setBy` while the room plays.** In a paused room
`Watcher.getPosition()` (`server.py:780-787`) returns `_position` verbatim, so
after a forced update every watcher ties and the election is decided by
insertion order — deterministic, and asserted. Once the room plays the same call
adds `time.time() - self._lastUpdatedOn`, a per-watcher stamp that
`Room.setPosition` does not refresh, so the winner turns on which peer's
acknowledgement reached the server first. Measured at a spread under a
millisecond, with the reference and the model landing on different peers.
`conf-forced-pause-change` therefore brackets the playing stretch and asserts
the unpause on the frames it produced, and `conf-forced-playing-clock` runs the
playing clock with a single watcher so the election has one candidate.

One scenario does sample a two-peer playing room: `conf-forced-ping-stamps`,
which has to, because the stamp is the thing it measures. It is not an exception
to the above — the gap it looks for is `PING_WAIT_MS`, four seconds, which
dominates a sub-millisecond phase spread by three or four orders of magnitude.
The margin is that scenario's own property, so a scenario that samples mid-play
on a smaller margin than that is back in the not-covered case.

**The `List` render of an empty file name.** `protocols.py:695` is
`"file": watcher.getFile() if watcher.getFile() else {}`, another truthiness
test, so the reference renders `{name: ""}` as a real object while the model
renders its `''` sentinel as `{name: '', duration: 1440, size: 1}`. Nothing in
`src/main/syncplay.ts` produces a nameless-but-present file, so no scenario can
send one without hand-writing a frame our client would never emit. Left as a
recorded difference rather than a fixed one.

**Readiness, shared playlists, managed rooms, chat, TLS.** The server runs
`--disable-ready` and the peers declare `sharedPlaylists: false` and
`managedRooms: false`; the suite is plaintext on loopback by construction. Each
has an entry in `IGNORED_FIELDS` naming the fixture that does own it.

## Runtime

20 scenarios across 5 files — 5 election, 5 file-membership, 6 forced-update,
3 field-coverage, 1 protocol-timeout — at about 314 s wall clock, run
sequentially — `fileParallelism: false` and `maxConcurrency: 1`, because both
backends are wall-clock-driven and a second suite running beside them becomes
their jitter. Most of that is `wait` steps: a scenario has to let both backends
re-elect at least once after the step under test before it looks.

The 314 s is derived, not freshly measured, and it has now been derived twice.
249 s is the original measurement, taken on a warm WSL2 box when this suite held
18 scenarios; `conf-forced-ping-stamps` then added
`2 × SETTLE_MS + PING_WAIT_MS + SETTLE_MS` — 11.8 s of scheduled waits, paid once
per backend, so 23.6 s, for 273 s. `conf-timeout-idle-drop` adds 41.2 s, and that
one **is** a measurement rather than a sum of its waits: it was timed on its own,
both backends, at 41 213 ms, against 20.6 s of scheduled waits per backend — so
the overhead the other two figures are sums of is about 2 % here, which is the
only evidence this file has that those sums are honest. One scenario is now 13 %
of the suite's budget, because holding a peer past a 12.5 s timeout costs 12.5 s
twice however little else it does. Re-measure rather than keep adding to it if the
number starts mattering.

Give it the box. Running it alongside `npm run test:coverage` and an Electron
build killed the server process outright part-way through, and the shape that
takes is misleading: the scenarios that already ran still passed, and the rest
failed with `connect ECONNREFUSED 127.0.0.1:<port>`, which reads as a partial
divergence rather than as a dead reference. `real-server.ts` now writes a
`[conformance] syncplay-server exited mid-run` line to stderr the moment it
happens, so the two are distinguishable without reading the port number.
