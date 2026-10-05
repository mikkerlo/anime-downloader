# Testing

Two runners gate a PR, split by what they touch (refactor epic #84, Phase 7),
and the rest run outside it on a real Syncplay server (#367; #489 at the end):

```bash
npm run test            # Vitest: unit + integration (no Electron)
npm run test:watch      # Vitest in watch mode
npm run test:coverage   # Vitest + v8 coverage; enforces per-seam thresholds
npm run test:e2e        # Playwright: drives the built app in out/ (run `npm run build` first)
npm run test:conformance  # Vitest against a real Syncplay server; needs SYNCPLAY_SERVER_BIN
```

## Layers

- **Unit** (`test/`) — pure logic and single units against fakes. Main-process
  services/`lib` use the in-memory `StorageService` fake
  (`test/helpers/in-memory-storage.ts`); renderer stores/composables stub
  `globalThis.window.api`. The `electron` module is mocked globally via
  `test/setup/electron-mock.ts` (wired through `vitest.config.ts` `setupFiles`),
  so service code that imports `electron` runs without a real runtime.
- **API fixture replay** (`test/api-clients/` + `test/fixtures/`) — recorded,
  anonymized `shikimori.one` / `smotret-anime.ru` responses replayed via a
  mocked `global.fetch`, asserting the client parsers in `src/main/shikimori.ts`
  and `src/main/smotret-api.ts`. Catches upstream schema drift that pure mocks
  can't. `test/fixtures-anonymization.test.ts` fails the build if a fixture ever
  carries a real-looking token (`Bearer …`, non-fake `access_token` /
  `refresh_token`). See `test/fixtures/shikimori/README.md` for the
  refresh + anonymization procedure.
- **Modelled server** (`test/helpers/syncplay-min-election-server.ts`) — a
  cut-down Syncplay server for the one seam hand-fed frames cannot express:
  `Room.getPosition()`'s `min(watchers)` election and the link latency that
  decides it. It stores `reported + forwardDelay`, stamps receipt on a separate
  axis, orders file-less watchers **last** in the election, and re-elects once a
  second — so "who the server says set the room" is a *result* rather than an
  input. That ordering was modelled as an *exclusion* until #307, which is not
  what the reference does: `Watcher.__lt__` (`server.py:834-839`) makes a
  file-less watcher compare as "not less than" anything and everything compare
  as less than it, while `Room.getPosition()` still folds `min()` over **every**
  watcher. Two consequences the old filter hid, and both are now pinned: a room
  in which nobody has announced yet still holds an election — naming its
  *first-inserted* watcher, since no comparison ever succeeds — and
  `Election.positions` lists every watcher compared, file-less ones included, so
  it is a record of the comparison rather than of who holds a file. `Set: {file:
  null}` clears membership, `Set: {file: {}}` is non-`None` membership and does
  not, an absent `file` key is no command at all, and modelled `List` renders a
  `None` file as `file: {}` as the reference does. `Set: {file: {}}` also
  *announces* nothing, which the conformance layer below is what found:
  `sendFileUpdate`'s guard (`server.py:175-178`) is `if watcher.getFile():`, a
  truthiness test that `{}` fails in Python exactly as `None` does, and the model
  relayed it unconditionally until #367.
  `test/services/syncplay-file-announcement.test.ts` holds that line in the PR
  gate so the nightly does not have to find it twice. The **unknown-position** arm
  of `__lt__` is deliberately unmodelled (`Watcher.position` is a non-nullable
  `number`), stated in the helper header rather than silently assumed
  equivalent. A `doSeek` or a pause change takes the reference's other path instead:
  a forced update that bypasses the election, carries the `ignoringOnTheFly`
  server counter and re-seats every watcher on the new position
  (`Room.setPosition`) — while deliberately *not* refreshing the room's
  `_lastUpdate`, so the next re-election runs from the last election rather than
  the last write and a playing room reads ahead of the playhead a seek just set.
  Drives real `SyncplayClient`s through the `net`/`tls` mocks
  (`test/services/syncplay-mirror-election.test.ts`, #277;
  `test/services/syncplay-mirror-drift.test.ts`, #279), and, through the
  two-peer harness below, real renderers on top of them
  (`test/services/syncplay-seek-crossfire.test.ts`, #361).

  Three knobs on top, all added by #279 and all defaulting to the reference's
  own behaviour. `forwardDelay` sets the `fd` in `reported + fd` to `'avrRtt/2'` (the
  reference's rule), `0`, or a fixed number of seconds — the mirror's deficit is
  `2d − fd` per election, and a single measurement at the reference's own rule
  cannot tell that apart from a bare `d`. `echoHoldCorrection` says whether the
  echo of a client's `clientLatencyCalculation` carries the server's hold
  correction; the reference's does, so **the default here is `true`**, and the
  one case that wants the uncorrected echo — under which a client's `serverRtt`
  reads ~1 s rather than the network RTT, which is the sample #279's clamp is
  sized for — opts out at its own call site. And `wire` is the readout of every
  outbound playstate stamped at *send*, alongside where the room read at that instant —
  `elections` reports what the server made of a frame one delay after the fact,
  which is not the same quantity.

  A fourth knob arrived with #384's item 4, and it is the only one whose
  default is *not* the reference's behaviour: `protocolTimeoutMs` models
  `PROTOCOL_TIMEOUT`, the drop a real server applies to a watcher that stops
  sending `State`, and it is **off** unless a caller names a duration. Off
  because every fixture here and all nineteen conformance scenarios predate it;
  the reference's own value is exported beside it as `PROTOCOL_TIMEOUT_MS` so
  nothing has to spell 12 500 out. What resets the clock is the part worth
  reading rather than assuming, and it is read off the real server by
  `conformance/syncplay-protocol-timeout.conformance.ts` rather than off
  `server.py`: a **`State` frame and nothing else**, a ping-only one carrying no
  `playstate` included, because the stamp sits above the guard the position work
  is behind. `Chat`, `Set` and `List` traffic refreshes nothing however often it
  arrives, so "silent" means *sends no `State`* and not *reports no position*.
  The one refresh the reference itself skips is the one inside its own
  `ignoringOnTheFly` window, which is this model's declared-unmodelled seam, so
  it stays out of scope here too rather than quietly diverging. The drop is
  quantised by the broadcast tick and not by the constant — a 12.5 s timeout on a
  1 s interval drops at 13 s — and `test/services/syncplay-protocol-timeout.test.ts`
  pins both edges from the pull-request gate, deriving them instead of writing
  them.
- **Integration** (`test/integration/`) — multi-service flows (auto-download
  tick, Shikimori offline-queue drain) wired through `test/helpers/app-harness.ts`
  (in-memory store + broadcast spy + stub HTTP/download seams). Not a full `App`
  reconstruction — each test composes only what it needs.
- **In-process IPC loop** (`test/setup/electron-mock.ts` → `test/ipc/`) — the
  global `electron` mock can close the bridge on itself: `ipcMain.handle`
  registrations are always recorded, and `__enableIpcLoop()` makes
  `ipcRenderer.invoke` route into them and return the handler's result. Both
  failure paths reject with the string a renderer actually sees — `Error
  invoking remote method '<channel>': <Name>: <message>` — for a handler that
  throws and for a channel nobody handled; `syncplay-bridge.test.ts` pins both
  shapes verbatim. The main→renderer half
  was already closed — a broadcaster that calls `__emit` lands on the same
  `ipcRenderer.on` registry the preload's `subscribe()` writes to — so a test
  can drive a real router, the real `src/preload/index.ts` and a real
  broadcast module against each other with no Electron runtime. Opt-in per
  file, because routing `invoke` changes what every other suite's bare spy
  returns; `__reset()` clears both registries and disarms it. It is **not** an
  IPC emulation: arguments and return values pass by reference where real IPC
  structured-clones them, and a file that declares its own `vi.mock('electron',
  …)` replaces this module wholesale, loop included.
  `test/ipc/syncplay-bridge.test.ts` (#361) is the first user — all 12
  `CHANNELS.SYNCPLAY_*` invoke channels and all 6 `EVENT_CHANNELS.SYNCPLAY_*`
  broadcasts, asserted against a census of the constants rather than a
  hand-written list, so an unwired thirteenth channel reds the file. The
  broadcast half exists at all because `src/main/ipc/syncplay-broadcasts.ts`
  extracted the six `syncplay.on(…) → broadcastToAll(…)` wirings out of
  `src/main/index.ts`, which coverage excludes and no test can import.
- **Two-peer interaction** (`test/helpers/syncplay-two-peer.ts`) — two complete
  Syncplay stacks in one Vitest process, each running the real composable, the
  real `src/preload/index.ts`, the real `src/main/ipc/syncplay.ipc.ts` and a real
  `SyncplayClient`, all four of them against a shared
  `MinElectionServer`. It exists to delete a stand-in:
  `test/services/syncplay-seek-crossfire.test.ts` used to carry a `LaggyElement`
  whose `apply()` was commented "the renderer's apply rule, verbatim" and was a
  hand-copied `Math.abs(…) <= 3`, so the shipped literal at
  `src/renderer/src/composables/use-syncplay-client.ts:1529` could drift from it
  and nothing would notice. Both peers now run the shipped rule. The file no
  longer pins that literal: #488 rewrote it to pin the yank's absence in both
  roles, and the window `[3.0, 4.0)` it held the literal in is now named only
  by `use-syncplay-client.test.ts`'s 1 Hz mirror-sourced playing-frames case.

  The loop is **not** built on the in-process IPC loop above, because that mock's
  registries are process-wide and keyed by channel name — two peers would
  overwrite each other's handlers. Each peer gets a private module graph instead
  (`vi.resetModules()` plus `vi.doMock` of `electron`, `net` and `tls`), which
  gives it its own IPC registries, its own sockets, its own `syncplay` singleton
  — the one `syncplay.ipc.ts` imports at module scope, and the reason a shared
  graph cannot work — and its own preload `api` object. The renderer half needs
  one production seam for the same reason, `SyncplayDeps.api` (#361 step 3),
  because `window.api` is one object per renderer and cannot be swapped around
  two interleaved mounts. Same non-emulation caveat as the IPC loop: payloads
  cross by reference, not structured-cloned. `HarnessVideo` models a playhead on
  the fake clock, a seek that takes `seekLandMs` to land, and queued
  `play`/`pause`/`seeked`/`loadedmetadata` tasks — deliberately not the composable
  test file's `fakeVideo`, which models a static playhead for 205 single-frame
  cases. While a write is in flight the element reports the **seek target**, not
  a frozen pre-write position: assigning `currentTime` updates the official
  playback position synchronously and it is only readiness that lags, so a
  second write arriving before the first lands replaces the target and the
  reading follows it. #368 corrected this from the opposite model on a capture
  against the stock build, and the sign is the whole point — a mid-seek peer
  announces too *high*, so it loses the server's `min()` election to a peer
  genuinely behind it rather than under-reporting its lateness and winning.
  It also carries a file identity, because losing one is a scenario rather than a
  detail: `reload(src)` rebinds the element the way an episode change does,
  dropping it to `HAVE_NOTHING` and bringing it back on a `loadedmetadata` that
  lands `bindGapMs` (500 ms by default) later, closing `hasAnnounceablePosition()`
  (#284) for the gap, which stops the peer's snapshots and is how a fixture
  walks main across the staleness thresholds without faking a clock. The element
  records its own seek writes, `readyState` transitions and loads, so "it was
  never written while it could not honour a write" is a claim read off the element
  rather than inferred. Callers own `vi.useFakeTimers()`; `advance()` steps the
  one shared clock in 50 ms slices and drains microtasks between them, because
  Vue's scheduler flushes on microtasks rather than on the timer queue. Three of
  the helper's contracts are enforced rather than documented. `advance()` rejects
  a duration that is not a whole number of slices. `seat()` refuses re-entry,
  because two seats in flight at once interleave `vi.resetModules()` and the
  `window.api` swap and hand back two silently cross-wired peers. And `dispose()`
  tears down every peer even when an earlier one throws, draining the room before
  it rethrows the first error — a case that mocks something `dispose()` calls used
  to abandon the peers queued behind the thrower *and* leave the room populated,
  so the next case's `room?.dispose()` re-ran the same throwing teardown and red
  a neighbour that had nothing wrong with it.
  `test/services/syncplay-two-peer-loop.test.ts` pins the harness itself — those
  three guards, the in-flight target reading above, both rejection shapes this
  bridge copy produces (the no-handler one and a handler that throws), the bind
  gap's `?? 500` default, held inside `(400, 600]` so neither a revert to the old
  `0` nor a move into the drag regime passes, and `goToEpisode()`'s ordering: the
  episode-index bump is flushed before the element rebinds, so the pre-flush
  episode-change watcher sees the element still bound to the *old* episode at
  `HAVE_METADATA`, the way it does in the app across `PlayerView`'s IPC await.
  That last one is sampled at the file push rather than on the wire, because
  merely swapping the two statements is observably nothing — a queued pre-flush
  watcher runs after both either way — and an `advance()`-driven `suspendMs`
  models the length of that await with the room still ticking. `suspendMs` is
  validated before the first write rather than on the way into `advance()`, and
  the guard pins that as a *no-op* — nothing announced, nothing rebound — since
  a bare `rejects.toThrow` passes against a late check too, and a late check
  leaves behind a half-switched peer no successful call can produce. A second
  `describe` at the foot of that file is a source-text census rather than a
  harness guard: it reads every `syncplay-two-peer-*.test.ts` sibling, itself
  included, and pins how many `goToEpisode(` call sites each one holds against
  source with comments and string *bodies* blanked. On the trunk it landed on,
  raw text over the glob returned 13 where the blanked form returned 10, so the
  form the number is a census *of* is half the claim; only the blanked half is
  pinned, and the guard's own prose names the call often enough to have raised
  the raw half already. The blanking pass is quote-aware because that decides
  the number rather than refining it: the glob carries 16 `harness://` literals,
  and a quote-unaware `//` rule truncates one mid-expression, leaves the quote
  open and swallows forward over real call sites — fewer than 10, and the
  adoption file's only site reads 0. The pin is the per-file map rather than
  the total for the same reason, so that variant reads `adoption: expected 1,
  got 0` instead of a bare total inviting whoever it reds to re-derive the pin
  downward against a file the scan can no longer see at all. A second case in
  that `describe` classifies those sites rather than counting them: each one
  must read `await` followed by an unconstrained member chain, so `await host.`,
  `await even.switcher.` and the `await expect(…).rejects` wrapper all pass,
  while a dropped `await` reds naming the offending `file:line` and the line's
  own source text. The chain is unconstrained deliberately — none of the ten
  sites reads `await goToEpisode(` verbatim, so hardcoding one receiver would
  red the other four shapes. A call Prettier reflowed so that `await` sits on
  the preceding line reds as unclassifiable rather than being skipped, which is
  the direction a source-text scan has to fail in. And
  `syncplay-seek-crossfire.test.ts` is the first scenario on it. Eight more
  scenario files sit on the same harness — the count read "six" while seven
  were listed, because #368 added the in-flight-seek file without moving it:
  `syncplay-two-peer-playpause.test.ts` (both directions, a peer
  joining a room that is already paused, and a peer's own pause not coming
  back), `syncplay-two-peer-seek-echo.test.ts` (a drag propagating, its echo
  suppressed on the originator, and the re-assert behind
  `SEEK_REASSERT_TOLERANCE_S` — the two cases there go red under *opposite*
  moves of that literal, which is what pins it as the cause),
  `syncplay-two-peer-ignore-counters.test.ts` (the `ignoringOnTheFly`
  bookkeeping across a clean round trip, two changes in flight, and a peer's
  forced update crossing our window),
  `syncplay-two-peer-adoption.test.ts` (the spectator mirror and the adoption
  latch, reached through an element that is not ready rather than through a seek
  that never lands — #368 moved that door, because a merely slow seek leaves the
  peer up at its target and adopted, not down at 0 — plus an element that drops
  to `HAVE_NOTHING`, and an episode change),
  `syncplay-two-peer-inflight-seek.test.ts` (the other half of that correction:
  a peer whose seek is still in flight announces the target, adopts, and wins
  `min()` with a position its element has not reached),
  `syncplay-two-peer-rtt.test.ts` (the `serverRtt / 2` position compensation and
  its pause gate, on a deliberately fat 500 ms link so the term is worth half a
  second rather than one `advance()` slice) and
  `syncplay-two-peer-readiness.test.ts` (the ready gate, the one mechanism here
  with no wire playstate at all — one peer's `setSyncplayLocalReady(false)`
  travels `Set: {ready}` → `List` → `room-users` → the *other* peer's
  `watch(syncplayRoomUsers)` and pauses an element that received no state and
  made no call of its own) and `syncplay-two-peer-episode-change.test.ts` (until
  #486 every assertion there was a *characterisation* pin of #360's drag; since
  #486's forced seek to 0 they are guards that both peers land on the new
  episode's start and stay there, at the bind gaps and switch phases #360
  measured, plus the follower, both-press, paused-room and chained cases).
  The adoption file reads the mirror straight off the wire — an asserting frame
  carries a `paused` key and a mirror does not — which is what makes "this peer
  cannot drag the room to 0"
  an observation rather than an inference; the readiness file reads the same
  wire for the opposite claim, that a gate pause is announced as nothing,
  because the snapshot carries the user's intent rather than `v.paused`.
  A private-state reader on `Peer` is what makes the RTT file's premise a
  measurement rather than arithmetic over the link delay — `serverRtt` is
  projected onto nothing, not even `SyncplayStatus`, so `rtt()` joins
  `seekIntent()` and `counters()` as an element-access read of the real class.
  Each file's header records what it
  cannot isolate on this harness rather than asserting around it — the
  pause-on-join case is guarded twice, `pendingServerAck` is never observable
  as non-zero, the server never echoes a `client` key, the two staleness
  thresholds produce the same frame so only the first is pinned, and the RTT
  file sees the compensation only through the `doSeek` arm (a periodic carries
  the identical term and is never applied) and leaves the room-anchor axis of
  the same `serverRtt` to the single-client files, where the election it
  otherwise feeds back into can be held still.
- **End-to-end** (`e2e/`) — Playwright drives the built Electron app: a boot
  smoke (`e2e/smoke.spec.ts`) plus deterministic, network-free flows
  (`e2e/navigation.spec.ts`: sidebar navigation, settings persistence
  round-trip, keyboard shortcuts; `e2e/anime-video.spec.ts`: crossorigin
  `<video>` + ranged `fetch()` of a 2 KB fixture over `anime-video://`).
  Search→enqueue, player seek and live Shikimori sync are excluded to keep
  CI deterministic; their logic is covered at the unit + integration layers.
- **Conformance** (`conformance/`, #367) — the only layer whose subject is
  `MinElectionServer` itself rather than our code. Every fixture above believes
  the model; this one replays two-peer scenarios through real sockets against a
  real Syncplay 1.7.6 server and against the model in turn, and compares the two
  **on the wire** — `State.playstate`, the `Set: {user}` file relays, the `List`
  roster. Reaching into the model to ask what it thinks it did would be asking
  the thing under test. `conformance/helpers/trace-diff.ts` holds both position
  tolerances with the measurement each is sized from and a field-level ignore
  list, one entry per field naming its seam; a field the reference puts on the
  wire that nobody has decided about reds the suite
  (`syncplay-field-coverage.conformance.ts`). Full detail, including the two
  declared cadence differences and the scenarios loopback cannot reach, is in
  `conformance/README.md`.

  One scenario here is not a comparison of an existing model behaviour but the
  **source** of one. `syncplay-protocol-timeout.conformance.ts` was written and
  run before `MinElectionServer` could drop anyone, so its first run was red by
  construction, and the reference half of that red is where the `PROTOCOL_TIMEOUT`
  reset rule above was read: the real server's `"left"` notice, the surviving
  peer's next `List` without the dropped row, and the room re-electing off the
  departed watcher. Its premises assert all three before the comparison runs,
  because `assertConforms` throws and cannot tell agreement about a drop from
  agreement about nothing having happened.

  It runs nightly and on demand (`.github/workflows/syncplay-conformance.yml`),
  **not** in `quality`. It needs a Python server provisioned on the machine
  (`python3 -m venv` + `pip install --no-deps` from the pinned commit
  `993232ab095bb810593459bc705b3e6fc64ad161` — `--no-deps` because the declared
  set pulls 255 MB of PySide6 for a GUI the server entry point never starts), it
  takes about five minutes of wall clock — four until #384's item 4 added a
  scenario that spends 41 s of it holding a peer past a 12.5 s timeout — and a red
  there is a claim about an upstream project rather than about the PR's diff.
  `conformance/README.md` carries the derivation. If `SYNCPLAY_SERVER_BIN` is
  unset and nothing named `syncplay-server` is on `PATH` the harness **throws**
  rather than skipping — a conformance suite that quietly passes because it
  never ran is the failure mode it exists to rule out.

  Four of this layer's own properties are pinned from `quality`, because a
  nightly-only layer is not exercised by the pull request that breaks it.
  `test/conformance-workflow.test.ts` asserts that every piped step in the
  workflow runs under a shell that sets `pipefail`: without it a diverged suite
  exits with `tee`'s status and lands as a green nightly with nothing filed.
  `test/conformance-harness.test.ts` asserts the throw above actually happens —
  it did not, until #381: a missing binary reports `ENOENT` asynchronously, and
  the port `freePort()` handed out still answered for ~10 ms after its probe
  socket closed, so the readiness check passed against the probe's own corpse
  and `bootRealServer()` resolved in 9 ms against no server at all. The same
  file pins `reachesFieldPath()`, the predicate behind "reaches every compared
  field at least once", on the case that made its predecessor weaker than it
  read: a join notice satisfying `Set.user.[].file.name` with no `file` in it.
  It also pins the two option resolvers a scenario's declarations pass through,
  `peerOptions()` and `modelOptions()`, in both directions each. Both fail
  quietly rather than loudly if they are inverted — a peer that acks when it was
  told not to collapses the wait its scenario measures, and a modelled timeout
  resolved on for every scenario would start dropping watchers out of budgets
  written to keep them alive — and a quiet failure in a nightly-only layer is a
  night late at best.

  What this does and does not underwrite in the layers above. The mirror and
  two-peer fixtures split by what their *expected value* is derived from. One
  group is conditional on the model's election being the reference's, because
  the number or the name being asserted is the election's output: the whole of
  `syncplay-mirror-election.test.ts`, the drift arithmetic in
  `syncplay-mirror-drift.test.ts`, and everywhere a fixture says which peer the
  room ended up following. Those are what `conformance/` now backs, and what
  would move if the model turned out to be wrong. The other group is not
  conditional on it at all, because the quantity under test is our own client's
  rule and the server is only the courier that delivers a frame to it — the
  `SEEK_REASSERT_TOLERANCE_S` window, the `Math.abs(…) <= 3` apply rule, the
  `ignoringOnTheFly` bookkeeping, the readiness gate that produces no playstate
  at all. A wrong model would change which frames arrive in those files but not
  what the assertions mean.

  Three terms are conditional on *nothing* here and stay owned where they were,
  because loopback RTT measured 0.0003-0.0013 s across every run and cannot show
  them: `messageAge`, `forwardDelay` and `echoHoldCorrection`.
  `conformance/README.md` records them as unreached rather than as agreeing,
  which is the distinction that matters — a suite that reported agreement on a
  term it cannot observe would be worse than one that reports nothing.

## Structural (source-scanning) tests

A few tests assert things about source *text* rather than behaviour — most of
them in `test/renderer/components/player-lifecycle-scope.test.ts`, which pins
the ownership guards in `PlayerView.vue`. They are cheap and they catch a real
class of regression, but they fail silently in ways ordinary tests do not. Two
rules, both learned the hard way:

- **Pin the count, never just loop over the set.** A scan that walks a closed
  set of symbols and asserts "no unguarded site" cannot tell *no unguarded
  sites* from *no sites at all*. Dropping a symbol from the set — a one-line
  edit, and the way this kind of test rots — turns a red site green with
  nothing to notice it. The pinned per-flow count is the assertion that
  catches that.
- **An aggregate assertion is structurally blind to a dropped symbol.** Counting
  the enclosing blocks, files or functions a scan reached looks like a stronger
  check than counting sites, and it is not: whenever a *sibling* match keeps the
  same aggregate unit satisfied, the aggregate does not move. It is a useful
  shape check; it is never the assertion that catches set rot.

Blindness is the normal case rather than an occasional gap, and the ownership
scan in `player-lifecycle-scope.test.ts` is the measured example. Across its two
flows there are **33** symbol-set sites in **10** post-`await` blocks, and
**32** of those sites share a block with a sibling. So dropping one of the
**15** symbols moves the block count for exactly **one** of them —
`prepareMkvForPlayback(` in `goToEpisode`, the only site alone in its block. For
the other fourteen the block assertion reports the same number as before while a
guarded site has silently gone unguarded.

#317/#318 is where this nearly shipped a hole. Adding `reportPrepareError(` to
the symbol set during review moved the per-flow site counts 14→15 and 17→18 and
left both block counts at 5, because the newly matched site landed in a block
another symbol already kept red.

(Figures measured at #322 against the head of `main`; they move when
`SYMBOL_SET` does, and the pins in `SYMBOL_SCAN` are the live copy.)

Related, and the other way these tests go quietly wrong: a **positive** scan
over raw source is satisfied by a commented-out copy of the needle, so a
declaration deleted and left behind as a comment still reports green. Positive
scans read comment-stripped source; negative (`not.toContain`) scans read raw,
where stripping could only loosen them. See #302 and #321, and the per-site
notes in that test file.

The third way out is to stop scanning: a text guard on `src/main/index.ts` exists
only because that file boots Electron at module scope and no test can import it,
so extracting the code it guards converts the guard into an ordinary assertion.
#409 did that for the four download-completion tails, now
`src/main/lib/episode-completion.ts` and covered by
`test/lib/episode-completion.test.ts`. Two of the three constraints the old
`wiring placement` block in `test/services/download-manager-episode-metadata.test.ts`
pinned as text were strictly weaker than what replaced them: "the metadata write
sits above the `.mp4` early return" became "a `.mkv` path still persists and is
not probed", and "the repair write is gated on `info.hasVideo`" became a pair of
calls whose store contents are compared. The third one, that the manager's single
`onVideoDownloaded` slot is claimed exactly once, is about the wiring rather than
about any tail, so it stays a counted text scan — there is nothing to import that
would answer it. That is the general shape: extraction removes the text guards
that were standing in for behaviour, and leaves the ones that are genuinely
about where a call site is.

## Typechecking the test tree

`npm run typecheck` is three projects, not two: `tsconfig.node.json` (main +
preload), `tsconfig.web.json` (renderer), and `tsconfig.test.json` (#400), which
covers `test/`, `conformance/` and `e2e/` plus the three runner configs
(`vitest.config.ts`, `vitest.conformance.config.ts`, `playwright.config.ts`).
Until #400 the test tree was only ever compiled by Vitest's esbuild transform,
which strips types without checking them — so a test could assert against a
shape the source had not had for months and still report green, and 154 real type
errors had accumulated behind that.

It runs under `vue-tsc`, matching `typecheck:web`, because tests mount real
SFCs. `tsc` happens to report the same diagnostics today (the `*.vue` shim in
`src/renderer/src/env.d.ts` is what resolves the imports either way), but only
`vue-tsc` gives a mounted component its real prop types, so `tsc` would be the
weaker of the two as soon as a test asserts on one.

The include set carries three ambient declaration sets alongside the test
directories — `src/shared/types/**/*.d.ts`, `src/preload/types.d.ts` and
`src/renderer/src/env.d.ts`. They are not decoration: a test importing a `src/`
module pulls that module into the program, and without the globals every
`SyncplayStatus` / `window.api` / `*.vue` reference inside it fails to resolve.

`scripts/` is deliberately outside the project. Those are plain `.mjs` CI
scripts: checking them would mean either `allowJs` or hand-written `.d.mts`
siblings that nothing verifies against the `.mjs` they describe, which is a
maintenance trap rather than a check. The seam shows in exactly one place —
`test/check-version-not-lower.test.ts` imports its subject through a
`@ts-expect-error` on the module specifier (where `TS7016` is reported, not on
the `import` keyword).

The `--composite false` asymmetry is deliberate: `typecheck:node` and
`typecheck:web` pass the flag, `typecheck:test` does not, because
`tsconfig.test.json` sets no `composite`. `TS6307` ("not listed within the file
list of project") is a composite-project diagnostic, so with `composite` absent
there is nothing for the flag to suppress — measured on a green tree: no
`composite` and no flag reports 0 errors, `composite: true` plus the flag also 0,
and `composite: true` without the flag reports 125 `TS6307`s from the 55 `src/`
files the test tree reaches transitively. `composite`, a root `references` entry
and the flag are one decision, not three: add any one of them and the other two
become necessary.

## IPC contract guard

`test/ipc-channels.test.ts` asserts every `CHANNELS` / `EVENT_CHANNELS` entry is
referenced as a symbol on both sides, has a registered `ipcMain.handle`, and has
a matching preload binding — so deleting a handler or binding fails the build.

## Version-ordering gate

`npm run check:version-not-lower` (`scripts/check-version-not-lower.mjs`, the
first `run` step of the CI `quality` job) fails a PR whose `package.json` version
is strictly below its base branch's; equal and greater both pass. The comparison
is numeric per component, not lexical, and the script splits into a pure
`check({ base, head })` plus a CLI that fetches the base's `package.json` — so
`test/check-version-not-lower.test.ts` drives the decision directly instead of
the four throwaway branches the alternative would need, and the 9-to-10 boundary
gets a real assertion rather than a case nobody constructs. Why the ordering
matters at all is in `docs/build.md`, "Version numbers and merge order".

## Line-citation gate

`npm run check:line-citations` (`scripts/check-line-citations.mjs`, in the CI
`quality` job between `check:subscription-contract` and `test:coverage`) checks
the `<path>:<line>` anchors written in comments and docs prose. Nothing else in
the job reads a number inside a comment, so before #336 these were repaired by
hand after the fact — four PRs' worth. It scans `src`, `test`, `docs`, `e2e`,
`scripts`, `.github` and the repo root — the root because `DESIGN.md` and
`CLAUDE.md` are prose about paths, and an unscanned file is invisible twice over:
its anchors are neither checked nor counted, so the gate prints OK.

It **fails** on an anchor whose path does not exist, whose line is past EOF, or
whose range starts after it ends. Whether the cited line *means* what the prose
says is not decidable, so the rest is a heuristic that only **warns**: an anchor
landing on a blank line, a bare brace or a comment line is usually stale. A
range is judged by its **start line only** — several legitimate ranges close on
a `}`. Since #344 that enumeration is **not uniform across extensions**. The
blank-line test runs on every scanned extension, `.md` included: no file
deliberately cites the blank line between two of its own paragraphs, which is
decidable on prose in a way the rest is not — and two of the five markdown
anchors in the tree were stale and landing exactly there. The other three tests
stay exempt for `.md`, and not for the same reason. The comment-line predicate
collides with Markdown's own emphasis syntax, measured: of the 135 markdown
lines it matches, 102 are `**bold**` openers and 25 open with a single `*` —
17 emphasis markers and 8 real bullets — leaving 8 that are genuinely
comment-shaped, and both lines #344 repaired *to*
are `**` openers, so running it on prose would red the gate on the repair
itself. The bare-brace and `<!--` predicates have no measured false positive in
either direction (all 16 brace matches sit inside fenced code blocks, and no
markdown line starts with `<!--`); they stay exempt on the argument that a
fenced `}` carries code semantics and that markup is not cited deliberately.

Four pinned counts are what give that teeth, for the reasons in *Structural
tests* above — two exact, one a floor and one a ceiling:

- **Suspicious landings, pinned exactly.** Every such landing on this tree was
  stale: #336 repaired all thirteen, and #344 repaired the two the narrowing
  above exposed — both anchors from
  `test/services/syncplay-mirror-election.test.ts` into `docs/syncplay.md`, one
  81 lines behind its subject and one 119. So the heuristic's measured
  false-positive rate on that population is zero, and the pin began there. What
  it holds now is the deliberate landings that followed: #390's three, all
  anchors in the `blankCommentsAndStrings` docstring in the two-peer loop test,
  whose subject *is* which `goToEpisode(` matches are comments rather than call
  sites, so its worked examples can only be comment lines; plus #384's one, the
  premise correction in the conformance-harness header, which cites an
  *absence* and so has no code line to point at. The comment block above
  `SUSPICIOUS_LANDING_PIN` enumerates each of them. A further deliberate landing
  raises the pin by the landings it adds, with its reason in the commit
  message. What the pin does **not** cover is an anchor landing on a live
  code line: that is checked for existence only. The four same-file anchors in
  the `suspiciousLanding()` comment are the clearest case — all four target
  `if (…)` lines, so while they are right no predicate here has anything to say
  about them. **What that does not mean is that they go stale invisibly**, and
  until #395 this paragraph said it did: it predicted that a single line inserted
  above the ladder re-points each at its neighbour's test, "green and wrong".
  #393 inserted exactly that line and the build went **red** and wrong. The
  predicates classify the anchor's *new* landing, not the `if (…)` line it used
  to name, and the ladder is interleaved with comment lines and closes its
  hash-comment branch on a bare `}` — so an insertion above it re-points one or
  two of the four onto lines the comment-line and bare-brace tests do catch,
  depending both on where the line goes and on what it is. Measured: a live-code
  line above the blank predicate's comment block catches two; directly above
  `if (text === '')` it catches one, the bare-brace anchor, because the first
  anchor then lands on the inserted line itself — and two again if that inserted
  line is a comment. #393 measured three of four on its own tree. Either way the
  landing count is exact, and the gate fails. Since #407 the drift check names
  them individually as well.
  The failure that produces is narrower than either prediction, and it is the
  part worth knowing: it names whichever siblings happened to land on a comment
  or a brace and says nothing about the ones that landed on live code, which are
  stale too and ride in underneath a failure about their neighbours. A reviewer
  who repairs what the gate named has repaired half the drift. `resolved` counts
  anchors that resolve, not anchors that are checked.
- **Uncheckable anchors.** Bare basenames more than one tracked file carries
  (`syncplay.ts` is both `src/main/syncplay.ts` and
  `src/renderer/src/stores/syncplay.ts`) and pathless `:NNN` anchors that
  inherit their path from a neighbouring line. Neither can be resolved, so the
  pin bounds how much the gate is blind to. Adding one reds the build; the fix
  is almost always to give the anchor a resolvable path rather than raise the
  number.
- **Marked citations, floored at 75.** One of the two one-sided counts here,
  because the marked class can only shrink silently — see *The marked form*
  below. Falling below the floor reds; rising above it is free. #395 raised it
  from the 12 #372 set, where 52 anchors of slack let the verified population
  lose 81% of its members with the gate green; #459 took it 64 to 75 with its
  retrofit, since slack is exactly what stops a floor from binding.
- **Unmarked upstream `.py` anchors, capped at 262.** The other one-sided count,
  and the only one where *growth* is the hazard, so it is the floor's mirror image
  and is compared the other way. Nothing in this repo resolves a Python target:
  each of these is counted as unresolvable by construction, no landing predicate
  ever runs on it, and its line number is never compared with anything. 262
  anchors across 27 citing files, and **none of them carries a quote** — which is
  why the count is of the *unmarked* ones rather than a widening of `marked`
  above, whose printed line says "verified against their target" and would be
  false by 262 in a single step. One more than the cap reds the PR that writes it,
  which is the property a floor could not deliver: `analyze()` has no notion of
  "added in this PR" and a floor only says the count must not fall, so a new
  unmarked upstream anchor would arrive green. The 262 already here are
  grandfathered rather than retrofitted under duress, and a retrofit lowers the
  count, so the number ratchets toward zero. The hash-comment predicate learned
  `.py` in the same change — 0 occurrences today, since no Python target resolves
  for it to fire on, so it is covered by a fixture rather than by the tree and the
  hole is closed before the population arrives. Re-measuring the cap has one
  trap worth knowing, and it is not a number to carry forward by hand: a direct
  scan returns **292** — 286 unmarked and 6 marked — against the gate's 262, so
  the gap is 30 citation-shaped fixture strings inside
  `test/check-line-citations.test.ts`, which sits in `EXCLUDED_PATHS`. That gap
  is a property of the fixture file rather than of the tree, and it grows with
  every fixture added, which is exactly how it was last carried forward wrong:
  #457 added one to each side of a stale 268-and-seven while in fact adding
  several fixture strings, and #395 step 2 added more of its own. Pin against what
  the gate counts, not what a hand census does. The cap last rose
  by one, for a qualifier on `RoomManager.broadcast` in
  `test/services/syncplay-two-peer-adoption.test.ts` naming the default-config
  branch that constructs the room manager — spelled out there and deliberately
  not repeated here, because an upstream anchor written into this paragraph is
  counted by the very cap the paragraph describes. The reason for a rise goes in
  the commit message, as the failure text requires.
- **Marked upstream `.py` anchors — printed, with no pin.** The cap above bounds
  the *unmarked* half, and a marked `.py` anchor is in neither printed count
  that sounds like it: the quote is extracted before the extension gate, so
  marking one takes it out of the cap, and the gate's `continue` for a foreign
  extension then fires before the quote is ever compared with anything. So it
  leaves the `marked quotes` line alone too — that line says "verified against
  their target", and this class is verified by nothing in the `quality` run. **A
  marked upstream anchor carries its evidence for a human reader, and since #395
  step 2 for a machine as well**: the quote lets a reviewer check the citation
  with no upstream tree at hand, and the nightly check in
  `scripts/check-upstream-citations.mjs` compares it against the installed
  upstream line, because there the target is on disk and the foreign-extension
  `continue` has been lifted by an injected extension set. Mechanical
  verification therefore holds for this class in the nightly run and not in
  `quality`, which is the split *The nightly upstream check* below describes. The
  count is **0** today, so the figure exists to keep it visible rather than to
  clear a backlog — folded into either neighbour it would falsify that line's own
  sentence, and left unprinted the class could grow with every figure on the
  gate's output unmoved. It takes no pin in either direction: marking an upstream
  anchor is the remedy the cap's failure text recommends, so a floor would
  penalise the retrofit and a ceiling would penalise the cure.

**Write the shortest path suffix only one file matches.** The resolver accepts
any unique suffix of a tracked path, and checks it exactly as it checks a full
one — `composables/use-syncplay-client.ts` resolves, and a wrong directory fails
as a missing file rather than falling back to the basename. The full
repo-relative path is always correct and is what a repair should reach for when
the line has room; when it does not, a leading directory or two keeps the anchor
inside its paragraph instead of pushing a comment past 130 columns, and if that
suffix ever stops being unique the anchor lands in the uncheckable pin and reds
— it does not go quiet.

A quote or a closing brace before a `:NNN` is not an anchor: the Syncplay wire
transcripts in `docs/syncplay.md` quote JSON whose values parse as pathless
anchors, and there is nothing to spell out in a `"position"` value. Counting
them meant the pin partly measured non-citations, and appending a transcript
line redded the gate with advice its author could not follow.

Citations to files outside the repo pass because their extension is one this
repo does not contain — that rule, not a filename allowlist, is also what keeps
`syncplay.pl:8999` (a host and port) from reporting as a missing file.
`test/check-line-citations.test.ts` drives the analyzer over synthetic corpora
rather than the real tree, whose counts are the pins themselves.

### What `resolved` does and does not attest

`resolved: N` says that N anchors name a file that exists and a line that is not
obviously blank, braced or commented. It is **not a claim about meaning.** #344
audited the four markdown anchors outside its own repair, cleared them on the
grounds that they landed on live prose "on their exact subjects", and two of
them went **87 lines** stale within three days — a whole subsystem section was
inserted above their targets — with `check:line-citations` green the whole time.
Landing on live prose is what the heuristic cannot see, and prose cannot be told
from prose by looking at one line in isolation.

**The marked form is the convention for a new anchor whose target is prose.**
Write the citation as `path:NN ("quoted text")` and the gate asserts the quote
still occurs at that line, or anywhere inside that range. The quote may wrap
across adjacent comment lines; both sides are normalized (Markdown emphasis and
backticks dropped, whitespace collapsed) before comparing, so a quote may
include or omit the target's `**`. This is the one part of the gate that judges
meaning, and it can, because the comparison is a substring test against a string
the comment already contains rather than a judgement about prose.
That assertion needs the target on disk, so it does **not** hold for an upstream
`.py` anchor: the form is checked and the content is not, and those anchors are
counted on their own printed line rather than inside `marked quotes`.

- **It hard-fails, and the count has a floor rather than a pin.** A quote found
  elsewhere in the file is reported as **drift**, with the corrected line named,
  which makes the repair mechanical; a quote found nowhere is reported as
  **stale**. If a drifted quote matches several lines the gate names them all and
  refuses to guess. The escape hatch for a citation that genuinely means "around
  here" is to not mark it, which degrades to the rest of this gate rather than to
  a silenced failure — but since #372 that costs a deliberate lowering of
  `MARKED_PIN` rather than nothing, because the class is one-sided: it cannot
  grow silently (marking is opt-in, so every arrival is deliberate) but it *can*
  shrink silently, and shrinking is the direction that costs coverage.
- **Multiplicity governs the drift report only.** If the quote is at the cited
  span, the citation is right and how many other lines carry the same text is
  not a question anyone asked. Fifteen of the tree's single-line anchors target
  a line that is not unique in its file, and four of the twelve markdown anchors
  are self-file citations, where marking one necessarily puts the quoted string
  on the citing line as well.
- **The spelling admits no slack, and that is the design.** The quote must open
  immediately after the citation — one space, one paren, one double quote, the
  citation optionally closed by a backtick. Measured tree-wide: no slack selects
  exactly the marked anchors; a ten-character gap admits three more, all of them
  scare-quoted concepts or lines of UI copy sitting next to an anchor; triggering
  on mere adjacency admits 75 candidates for two true ones. The measurement is
  recorded in `scripts/check-line-citations.mjs` beside the pattern, because the
  first loosening re-imports that population.

All twelve markdown-target anchors in the tree are written in this form. The 107
code-target anchors are not: they keep the landing heuristic as partial cover,
and each retrofit would be a fresh claim about what a line means, so they are a
separate job. A range is still classified by its **start line** for the brace and
comment predicates — thirteen legitimate ranges close on a `}` — but since #366
the **blank-line** predicate also runs on every line of a range after its start,
its **end line included** — a range whose last line is a paragraph gap has slid
just as surely as one with a gap in the middle. That measures zero hits today and
catches a range that has slid across a paragraph gap.

### Drift: the anchor that resolves and is still wrong

The class above has a second half, and unlike "landed on live prose" it is
decidable. When a file grows above a cited line the anchor does not break: it
resolves, it lands on live code, and it names something else. #371 inserted the
auto-advance overlay above `PlayerView.vue`'s `<video>` bindings, so line 2835
stopped being the `@loadedmetadata` binding and became a modal `<div>`, with the
binding pushed 59 lines down; the anchor in `test/helpers/syncplay-two-peer.ts`
never moved, and this gate was green throughout. That is the worked example
here, and deliberately the only one: on #408 one editing round left three
anchors a line short and the landing heuristic flagged exactly the one that
happened to sit on a comment, but this gate would not have caught the other two
either. All three were hand retargets, and a changed number is exempt by
construction — see "What it does not catch" below. #408 is evidence for the
practice the gate asks for rather than for the gate: **let the gate tell you the
new line; do not pre-count it.**

Since #407 the gate reads each cited line **as the base revision of this branch
had it** and compares. The rule is an occurrence count rather than a resolution
check, because resolution is precisely the part that already passes:

- **The precondition is an unchanged anchor token.** The same `path:N` string has
  to occur somewhere in the base version of the citing file. An anchor this
  branch wrote or retargeted has no base claim to hold it to and is exempt.
  Ranges are compared at **both** ends here, unlike the landing heuristics, whose
  start-line-only rule exists to avoid redding the ranges that legitimately close
  on a `}`.
- **The comparison is whole-line equality**, after the same normalization the
  marked form uses. A substring test would make every `}` and `return` match half
  its file and an empty line match all of it. Since normalization collapses
  whitespace, reindenting a cited line is not a change.
- **An in-place edit passes.** If the base content appears nowhere else in the
  head file, the line was reworded where it stands and there is no other line the
  anchor could have meant instead. Rewording a cited line is the most ordinary
  edit in the repo, and the author would have no number to copy in response.
- **So does an edit to one of several identical lines.** The elsewhere-search
  alone reds that, having found the other copies, so a count decides it: drift is
  reported only when the head file holds **at least as many** copies of the old
  content as the base did. One fewer means the cited copy went away rather than
  moved.
- **It is a hard failure and carries no pin.** Every other class here is a
  population with a legitimate steady state. This one has none, and a pin would
  do nothing but record how many wrong numbers the tree is currently carrying.

**What it does not catch**, all four by construction rather than by oversight:

- **A hand retarget that lands short.** Editing the number changes the token, the
  token is the precondition, and so the gate has nothing to compare and says
  nothing. The practice that follows is the point of the whole gate: **let the
  gate tell you the new line; do not pre-count it.** Leave the stale number where
  it is, run the gate, and copy the line out of the failure it prints.
- **Drift that is already on `main`.** The comparison is diff-scoped, so an
  anchor that went stale in some earlier branch reads identically in base and
  head and is invisible here. That is deliberate: it keeps the gate from opening
  with a backlog that nobody in the current PR caused, at the cost of never
  finding one.
- **The semantic case, still.** A line whose content is untouched but whose
  meaning moved — the function around it renamed, the condition it sits under
  inverted — is not a string comparison away from being caught, and nothing in
  #407 changes that.
- **An anchor in a file the base does not carry.** The unchanged-token
  precondition needs base content for the *citing* file, and a file this branch
  adds has none, so the anchor reaches no comparison at all. Since #420 that is no
  longer silent: those anchors are listed on their own advisory line, below.

**The exemption for a new citing file is not a clearance, so the gate now names
it.** An anchor in a file the branch adds was measured against the branch's own
earlier state, which a base-vs-head comparison cannot see, so it may already have
gone stale before the base was merged in. That is not a theoretical concern. #417
added `test/services/download-manager-episode-metadata.test.ts`, whose comment
cited `src/main/download-manager.ts` at line 533, the write of
`item.quality = best.height`. Bringing `main` in put #410's eight added lines
above it and the write moved to line 541. Drift skipped it because the base did
not carry the citing file, and the landing heuristic missed it too: post-merge,
line 533 is a `try {`, which is not blank, not a closer and not a comment marker.
Nothing about the landing was suspicious; it simply named the wrong statement. A
manual sweep of the merge's nine files caught it, and nothing in the gate would
have.

Since #420 those anchors print on their own advisory line, immediately after the
`drift:` line and never folded into it — the scanned-against-compared cross-checks
in PR descriptions read `driftChecked` as it stands, and a third number absorbed
into it would change what it means. Each anchor is listed in the `at: cites …`
shape the resolve failures use, in scan order, followed by the remedy. Reading it:

- **It covers new files only**, so `0` here does **not** mean this branch's new
  anchors were checked. An anchor a branch adds to a file the base *does* carry
  fails the **third** term of the precondition instead — the base parsed no such
  token — and is not in this bucket. That arm cannot tell a brand-new anchor from
  a deliberate hand retarget, which is #407's stated limit, so collecting it would
  fill the bucket with retargets. Separating the two populations is worth its own
  issue and is deliberately not attempted here.
- **A renamed citing file lands in the bucket wholesale.** Absent-from-the-base
  covers a file this branch renamed into place as well as one it added, so a
  `git mv` of a heavily-cited test file puts every one of its anchors here on a PR
  that wrote no citations at all. Nothing is wrong when that happens — the base
  cannot vouch for them under the new path — but it is the one way the advisory
  gets loud on a PR that never touched a citation, so it is documented rather than
  left to be discovered. An unexplained wall of advisory lines is how an advisory
  becomes ignorable.
- **An anchor whose *target* the branch adds or renames is not collected.** There
  is no base content for the target either, so there is nothing an author could be
  told to compare against, and a rename that broke the anchor is already the
  resolver's business.
- **The remedy is the marked form**, and it reaches through the exemption because
  quote verification runs outside the base guard. On the shape above, a marked
  anchor would have **failed** at line 533 and **named line 541** as the drift
  target. It reports the correction rather than applying it, which is the same
  bargain the rest of this gate offers. **A marked anchor is therefore not
  collected here at all**: it has already been checked against its target, so
  listing it would advise its author to do what they did. Marking one shortens
  the advisory by exactly that line.
- **The bucket is deliberately unpinned, and a pin should not be added later.**
  `SUSPICIOUS_LANDING_PIN` and `UNCHECKABLE_PIN` count properties of the head
  tree, so a value measured on `main` stays valid on every branch. This count is
  base-relative, for the same diff-scoping reason as the bullet above, and on
  `main` the base tree and the head tree are the same object — so it measures zero
  by construction rather than by luck, while being non-zero on precisely the PRs
  it exists to notice. An exact pin at zero therefore reds every PR that adds a
  cited test file, with "edit the pin" as the only repair; a `MARKED_PIN`-shaped
  floor at zero is unfalsifiable, and a ceiling at zero is the exact pin again.
  Advisory is the design here, not a fallback.
- **A merge is the common case, not the only one.** The within-branch variant —
  commit 1 adds the anchor, commit 3 shifts the target, no merge involved — lands
  in the same bucket, and it is also the case this route cannot catch even in
  principle. The complete fix compares against the state the author measured,
  found by walking the citing file's own history, and CI blocks it: neither
  `actions/checkout` step in `.github/workflows/check.yml` sets `fetch-depth`, so
  the clone is depth 1 and there is no history to walk. **The bucket therefore
  does not mean "checked."** It means this is where a stale new-file anchor would
  be hiding.

`test/check-line-citations.test.ts` drives both trees as synthetic corpora
through injected readers, so nothing in the suite shells out to git, and the
`#371` fixture is built at that file's real line numbers so the assertion reads
`2894`. The base plan is a pure function with its own table — merge-base against
the tracking ref locally, the base tip in CI, and failure rather than a skip when
CI has neither — because a wrong answer there breaks the gate in the one place it
has to run.

That table routes on `CI` **before** the tracking ref, which is the opposite of
how it reads. In CI the tracking ref is present by the time this gate runs, even
though the checkout is depth 1 with only the PR ref: `check:version-not-lower`
runs earlier in the same job and fetches one shallow base ref, and that fetch
also writes `refs/remotes/origin/<base>`, because `actions/checkout` builds the
clone with `git remote add` and its `remote.origin.fetch` wildcard makes the
update opportunistic. Routing on the ref would therefore send CI down
`merge-base`, where `git merge-base` exits 1 having found nothing — at depth 1
HEAD's parents are outside the shallow boundary. A row in the table pins that
case on its own, because it is the combination CI actually presents.

### The nightly upstream check

The cap above bounds the upstream-Python anchors; it cannot check one, because
nothing in this repo resolves a Python target. `npm run check:upstream-citations`
(`scripts/check-upstream-citations.mjs`) does check them, and it runs in
`.github/workflows/syncplay-conformance.yml` rather than in `quality` — the
nightly job that already provisions a pinned Syncplay tree. Vendoring a copy
would put thousands of lines of upstream source in the repo and a second thing
to keep in step with the pin; fetching one during `quality` would put the
network on every pull request's critical path, to settle a number inside a
comment. The nightly reads the tree pip already installed, so the anchors are
attested against the same artefact the conformance suite is believed against,
rather than against a second copy that could differ.

Four classes are reported, each finding carrying its citer, its anchor, the
predicate that flagged it and the commit it was measured against:

- **anchors that do not resolve** — a path the installed tree does not carry, or
  a line past the end of the file;
- **ranges that cross a `def`/`class` boundary** — the predicate this check adds.
  The **start line is exempt** and that exemption is the whole design: measured
  over the 165 ranged upstream anchors at the pin, counting the start line flags
  **97** of them, every one of which cites a function from its own signature,
  which is the correct way to cite a function. Exempting it flags **0**, so the
  predicate ships against a clean tree and its first flag is news. The end line
  stays in scope, and only the first boundary in a range is reported;
- **suspicious landings on an upstream line** — the existing ladder, which never
  fires in `quality` because a Python target cannot resolve there. Exactly one
  such landing exists at the pin: `docs/syncplay.md` cites `_allowTLSconnections()`
  whole, and the blank line the heuristic objects to is the intra-function gap
  between its `open()` calls and the `getmtime()` below them. It is allow-listed
  by **citer and anchor together**, not by count — pinned as "one landing is
  expected", a different anchor sliding onto a different blank line would hold
  the count at one and pass;
- **marked anchors whose quote has rotted** — the content half of the marked form,
  which `quality` can only check the spelling of.

All of those figures are pinned to the commit `993232ab…`, read from the
workflow's own install line and confirmed against the installed distribution's
`direct_url.json` before a single anchor is examined: a mismatch aborts with both
shas rather than reporting line numbers measured against the wrong tree. A
marked upstream anchor is therefore verified mechanically as soon as the
population is non-empty — it is **0** today — which is what the printed
marked-Python figure in `quality` exists to keep visible. A failure files its own
issue, separate from the divergence one and deduped on the title, because a wrong
line number in a comment and a model that has drifted from the reference have
different readers and different repairs.

## Prose-shape gate

`npm run check:prose-shape` (`scripts/check-prose-shape.mjs`, in the CI `quality`
job beside `check:line-citations`) measures the shape of the ragged edge in
hand-wrapped Markdown. Nothing else in the job reads prose shape at all:
`.prettierignore` carries `**/*.md`, and removing that line changes nothing here,
because `.prettierrc` sets no `proseWrap` and the default is `preserve` —
Prettier does not reflow prose. The defect that motivated it is a line a rebase
conflict left at 41 columns in the middle of a sentence, inside a block whose
longest line is 79. A max-column check cannot see that by construction: the line
is too **short**, not too long.

A line is **ragged** when all five hold: (a) it is inside a block — a maximal run
of prose lines, broken by a blank line, a heading, a table row, a blockquote, a
`---` rule, a list-item start, and a fence, whose contents are not scanned at
all; (b) it is not the block's last line; (c) it is at least **20 columns**
shorter than the longest line in its own block; (d) it does not end in `.`, `:`,
`;`, `!` or `?`; and (e) a greedy wrapper could have appended the first token of
the next line, i.e. `len + 1 + token <= blockMax`.

**(e) is what keeps the rest honest, and it arrived after the population was
measured.** The first run reported 14 lines and claimed no false positives.
Asking _why_ each line was short showed that 8 of the 14 were short only because
the next thing in the paragraph was an unbreakable backticked path — the shape
every greedy wrapper produces, reported as a defect. The rule is content-free:
two lengths and a space, with no knowledge of citations, URLs or any other
content class. Adding it after the count was known is recorded rather than waved
through, on the argument that it moves no threshold (the deficit is still 20) and
that it moves the count in the unflattering direction.

The count is **pinned exactly**, following `UNCHECKABLE_PIN` rather than
`SUSPICIOUS_LANDING_PIN`, and the choice is about the instruction the pin
carries to whoever next reds it. It is not the instruction a _new_ member gets —
there both pins say the same thing, _repair what you just added_: a new ragged
line reds the build and the fix is to rewrap the line you just wrote, exactly as
the fix for a new uncheckable anchor is to spell its path out rather than raise
the number. What differs is what the members already under the pin are, and so
which way the number is allowed to move. Every landing under
`SUSPICIOUS_LANDING_PIN` is a deliberate exception that carries its own written
argument, so that pin only ever rises, by what a change adds, and each rise is
paid for by making that argument. Every line under this one is a real defect
left unrepaired, and most of them sit in `docs/testing.md`, where rewrapping
one reflows the file and renumbers the very anchors the gate above pins — so
this pin _bounds a known blindness_, and it moves one way only: down, when one
of those lines is genuinely repaired.
**Never re-pin to clear a red.** A number moved to match whatever the tree
happens to say measures nothing at all.

**What it does not police.** It is **vacuous on prose that is not hand-wrapped**.
Several pages put one long line per paragraph, so the block holds a single line,
clause (b) exempts it, and nothing is measured however long that line is. That is
accepted rather than fixed, because the predicate reads the shape of a wrap and a
file nobody wrapped has no shape to read. The consequence is the one worth
writing down: **silence here is not coverage**, and a page that drifts from
wrapped to unwrapped prose leaves the measured population without redding
anything. It is likewise silent inside fenced blocks, raw HTML blocks and YAML
front matter, and it has no opinion on agent-instruction Markdown under
`.claude/`, `.gemini/` and `.github/agents/` — machine-read files with a
different audience and a different shape, excluded on that ground and not on a
hit count.

**What it over-reports.** Clause (c) measures the deficit against `blockMax`, so
one line a wrapper could not break — a bare URL, a long backticked path — raises
the bar for every other line in the same paragraph. A six-line paragraph wrapped
at 76-77 columns around a 103-column link reports four hits, none of them a
defect, and the failure text's advice to rewrap the paragraph is wrong for all
four. A URL alone on its line reports three, not four: clause (e) pardons the
line before it as well, and the fourth hit needs a short word ahead of the URL.
Nothing on this tree is close: the widest block the predicate examines is 88
columns and only two exceed 84. Blocks of one line run far wider — there is an
8572-column paragraph in `docs/syncplay.md` — but `raggedLines` skips a block
shorter than two lines outright, so the multi-line figure is the one to compare
against. It is a latent class, named here rather than discovered by whoever
first writes a long link. Narrowing `blockMax` to ignore a line no wrapper could
have broken is a **predicate change**, and this gate's own rule is that a
threshold does not move once the count is known — so it belongs in its own
issue with its own measurement, not in the PR that first measured the count.

`test/check-prose-shape.test.ts` drives `analyze()` over synthetic corpora rather
than the real tree, for the reason the citation tests give: the real counts are
the pin itself. The motivating 41-column line is frozen there as a corpus string,
copied verbatim, because the widths **are** the fixture. One block there does
read this page (#464), and the reason above still holds of it: it checks that the
pin's prose restatement — the paragraph immediately above **What it does not
police.** — opens exactly once and does not spell `RAGGED_PIN`'s own value. That
last is narrower than "states no figure": a deficit or a column count written
there passes, deliberately, because this section measures its own population in
prose. It compares the page with the constant and never with a count taken off
the tree.

## Evidence retention

Some findings are settled by a capture rather than by a test: two instrumented
app instances against a real server, a driver, and a run directory of records.
Those runs are not reproducible on demand and their artifacts do not survive —
the five-run campaign behind #348's root cause was written up in a comment and
its run trees, instrumentation patch, harness scripts and sha256 manifest were
all gone by the time the fix was written, wiped with the scratchpad that held
them. The issue-body retention rule that used to cover this is retired; these
four rules replace it.

1. **The posted comment is the record.** Anything not published at post time is
   deemed destroyed at post time and may not be cited by a later step. A claim
   whose support lives only in a run directory is a claim with no support the
   moment that directory is gone, and the failure is silent: the prose still
   reads as evidence. Write the report so that it stands alone, and where it
   cannot, say so in it — "run 5's per-record sequence is not quoted because the
   comment summarises it in prose" is a usable disclosure; a reconstruction from
   the mechanism is not.
2. **Publish every run verbatim, not a representative one.** Selecting the run
   that reproduces discards the denominator, and the denominator is the claim:
   "4 of 5" and "the one we kept" are different findings. Verbatim means the
   record lines with their numbers and clocks, not a paraphrase of what they
   showed.
3. **The rig goes on an `evidence/<issue>-<step>` branch, never a scratchpad.**
   Push the instrumentation patch, the driver, the clock anchoring and the
   environment setup from the instrumented checkout and link the branch from the
   report. Such a branch is never opened as a PR, so it costs zero CI and never
   merges — and rebuilding a rig from scratch is the real cost an artifact loss
   imposes, not the records themselves.
4. **This section is the rule's home.** It lives in a file under `docs/`, on
   purpose: the rules in this repo that hold are the ones with a file behind
   them, and a retention rule kept in an issue body is subject to exactly the
   loss it exists to prevent.

## Coverage thresholds

`test:coverage` enforces **per-glob** floors (in `vitest.config.ts`) on the
seams Phase 7 covers — `src/shared`, `src/main/lib`, `src/main/store`, the
unit-tested `src/main/services/*`, `src/renderer/src/stores`, and
`src/renderer/src/composables`. A single global number isn't used: it would be
dominated by the `.vue` components and `main/ipc` routers that are out of scope
for unit testing. Floors sit a few points below current coverage so churn
doesn't flake CI; raise them in follow-ups as coverage climbs. The CI `quality`
job runs `test:coverage` (not plain `test`) so a threshold regression fails the
PR.

Two entries name a **single file** rather than a directory (#361). With
`perFile: false` every glob is an aggregate, and an aggregate is exactly what a
large, high-coverage file can sink into unnoticed: `src/main/syncplay.ts` — the
biggest and most defect-dense file in the project — matched no glob at all, so
it was measured and never gated, and `use-syncplay-client.ts` sat inside the
55% `composables/**` number with room to fall a long way before anything
noticed. A one-file glob is its own aggregate. Measured at #361:
`src/main/syncplay.ts` 98.49% statements/lines, floored at 88;
`src/renderer/src/composables/use-syncplay-client.ts` 97.15%, floored at 87 —
both inside the ~7–13 point margin the other floors use. The single-file globs
**overlap** the directory ones rather than carving out of them, so
`use-syncplay-client.ts` still counts into the composables aggregate too and
the tighter of the two floors is what binds.

## Syncplay interaction suite

```bash
npm run test:e2e:syncplay  # two built instances on a real Syncplay server; needs SYNCPLAY_SERVER_BIN
```

#489 turned a manual two-instance run into a permanent suite. Three
timing-dependent two-person bugs (#486 stale position after next, #487 double
next, #488 an in-flight seek undone) were found by that run, and each sat in a
gap the fixtures above did not sweep. The suite has two tiers, split by cost.

**Tier 1** is ordinary `test/services/` files on the two-peer harness, so it
runs in `quality` on every PR. Each sweeps the timing axis its bug lives on
(press gap, landing time, heartbeat phase, leg latency) and pins the result
cell for cell. A row marked ✗ pins the broken behaviour **as it is on main**,
with a header naming the issue; the fix PR rewrites that table rather than
deleting the file, so the sweep that proved the bug proves the fix.

**Tier 2** (`e2e-syncplay/`, `playwright.syncplay.config.ts`) drives two built
app instances in one room on a real Syncplay 1.7.6 server, playing generated
fixture videos from a local server that slows every byte-range request. It is
a separate top-level directory with its own config, the layout `conformance/`
uses, so `npm run test:e2e` (`testDir: './e2e'`) can never collect it. The
config sets `retries: 0`, because a row's verdict is a count over N timed
runs; setup steps retry inside the helpers instead. A ✗ row asserts only
`bad ≥ 1` at its N (proof the rig can see the bug), since the rates measured
on real streams do not carry over to synthetic delays; the exact pins are
Tier 1's. A non-✗ row asserts `bad == 0` over its scoreable runs.

The rig changes nothing in `src/`. `player:get-stream-url` and
`player:find-local-file` are swapped from the Playwright side with
`app.evaluate()` (`ipcMain.removeHandler` + `ipcMain.handle`) in
`e2e-syncplay/helpers/duo.ts`, and the player is opened with a synthetic
`allEpisodes` / `translations` payload, so nothing reaches the network and
the hook is inert in a shipped build by construction. The server is booted
through `conformance/helpers/real-server.ts` with readiness **on** (the
conformance suite passes it off; `serverArgs()` takes it as a parameter and
`test/conformance-harness.test.ts` pins both defaults). The fixtures are four
~24-minute still-image episodes at 720p and 360p plus one MKV, generated by
`npm run gen:syncplay-fixtures` into the gitignored `e2e-syncplay/.fixtures/`
(the specs generate them on first use); `e2e-syncplay/helpers/fixtures.ts`
holds the translation-id → file map, two translations per episode.

Every row writes per-run records to `test-results/syncplay-traces/<row>.jsonl`;
aggregate them with `jq`, never read them raw. The workflow
(`.github/workflows/syncplay-e2e.yml`) runs nightly, on dispatch and on PRs
touching the Syncplay client, and is `continue-on-error` until the non-✗ rows
have five green nightlies in a row. `test/syncplay-e2e-workflow.test.ts`
holds the layout, the pin and the `pipefail` step from `quality`.

Running Tier 2 locally needs a build, `ffmpeg` on `PATH`, `xvfb-run`, and the
server from the conformance provisioning line above:

```bash
npm run build
SYNCPLAY_SERVER_BIN=/path/to/venv/bin/syncplay-server npm run test:e2e:syncplay
SYNCPLAY_E2E_N=8 npm run test:e2e:syncplay -- -g E2   # one row, larger N
```

The row-to-file map. Rows the catalog lists that an older file already
covers are not redone:

| Rows | Tier 1 | Tier 2 |
| --- | --- | --- |
| E1, E2, E3, E5 position (#486, fixed by #493; Tier 1 pins one 900 ms-phase follow residual) | `syncplay-two-peer-next-episode.test.ts` | `episode.spec.ts` (E1, E6, E2's stale half) |
| E2 double advance (#487, fixed by #492; window moved to first frame + grace by #500; Tier 1 pins the swallowed presses, the component's grace-timer lifecycle is run from its own source in `player-lifecycle-scope.test.ts`) | `syncplay-two-peer-double-next.test.ts` | `episode.spec.ts` (E2's skip half, scored on `loadeddata` + `FOLLOW_GRACE_MS`) |
| E5 paused state: a paused room stays paused at 0 across Next/Prev (#496, fixed; Tier 1 pins the presser and follower orderings where the new element plays before a paused frame lands, the playing-room and pending-pause-hold controls, and a peer's Play before and after the consume, through a `live()` loop that models `canplay` and `timeupdate` and `PlayerView`'s registered `episode-start` play) | `syncplay-two-peer-episode-change.test.ts` (#496 block) | `episode.spec.ts` (E5: every scoreable run paused at ~0) |
| S1, S2, S9 (#488, fixed by #491; Tier 1 pins #491's 900 ms crossing cell) | `syncplay-seek-revert.test.ts` | `seek.spec.ts` (S1, S9) |
| S6 | — | `seek.spec.ts` |
| P1 | `syncplay-two-peer-playpause.test.ts` | `pause.spec.ts` |
| P2 (✗ band), P3, M8 | `syncplay-two-peer-interactions.test.ts` | — |
| P5, M1 | `syncplay-two-peer-adoption.test.ts`, `syncplay-two-peer-playpause.test.ts` | — |
| P6, P7, P8 | — | `pause.spec.ts` |
| P7f, P6f: pause, then a quality / translation switch 0 / 20 / 50 / 200 ms later, the gaps recorded per run; `SYNCPLAY_E2E_N` is the per-bucket N, default 10 (#498; P7f was ✗ before its fix) | `syncplay-two-peer-quality-switch.test.ts` | `pause.spec.ts` |
| P12 | the #350 block of `test/renderer/composables/use-syncplay-client.test.ts` | — |
| M3 | `syncplay-frozen-snapshot.test.ts` | — |

P7f's Tier 1 half needs an element that can start itself, which
`HarnessVideo` cannot by default. `autoplay: true` is the opt-in model of the
`<video>`'s bare `autoplay` attribute (#498): a load arms the can-autoplay
flag, `play()` and `pause()` clear it (`pause()` even on an already-paused
element, which fires nothing, the #348 disarm), and a `readyState` write
reaching HAVE_ENOUGH_DATA with it armed on a paused element starts playback
and queues `play` with no `play()` call. Off by default, because every older
fixture assumes an element that never starts itself. `HarnessVideo.delivered`
logs every event `tick()` hands out, which is what the file's model of
`PlayerView`'s `awaitingFirstAutostart` latch reads: set at construction (the
mount), cleared by the first delivered `play` or `pause`. The pre-start cases
(a switch before the first autostart, solo and in a live room) pin that the
disarm leaves a solo autostart alone and still disarms inside a session.
