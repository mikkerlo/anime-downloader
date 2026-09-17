# Testing

Two runners, split by what they touch (refactor epic #84, Phase 7):

```bash
npm run test            # Vitest: unit + integration (no Electron)
npm run test:watch      # Vitest in watch mode
npm run test:coverage   # Vitest + v8 coverage; enforces per-seam thresholds
npm run test:e2e        # Playwright: drives the built app in out/ (run `npm run build` first)
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
  `None` file as `file: {}` as the reference does. The **unknown-position** arm
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
- **Integration** (`test/integration/`) — multi-service flows (auto-download
  tick, Shikimori offline-queue drain) wired through `test/helpers/app-harness.ts`
  (in-memory store + broadcast spy + stub HTTP/download seams). Not a full `App`
  reconstruction — each test composes only what it needs.
- **In-process IPC loop** (`test/setup/electron-mock.ts` → `test/ipc/`) — the
  global `electron` mock can close the bridge on itself: `ipcMain.handle`
  registrations are always recorded, and `__enableIpcLoop()` makes
  `ipcRenderer.invoke` route into them and return the handler's result (a
  rejection if it throws, the way real `invoke` does). The main→renderer half
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
  `src/renderer/src/composables/use-syncplay-client.ts:1411` could drift from it
  and nothing would notice. Both peers now run the shipped rule, and mutating
  that literal in either direction reds the file.

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
  `play`/`pause`/`seeked` tasks — deliberately not the composable test file's
  `fakeVideo`, which models a static playhead for 205 single-frame cases.
  Callers own `vi.useFakeTimers()`; `advance()` steps the one shared clock in
  50 ms slices and drains microtasks between them, because Vue's scheduler
  flushes on microtasks rather than on the timer queue.
  `test/services/syncplay-two-peer-loop.test.ts` pins the harness itself and
  `syncplay-seek-crossfire.test.ts` is the first scenario on it.
- **End-to-end** (`e2e/`) — Playwright drives the built Electron app: a boot
  smoke (`e2e/smoke.spec.ts`) plus deterministic, network-free flows
  (`e2e/navigation.spec.ts`: sidebar navigation, settings persistence
  round-trip, keyboard shortcuts). Network/media-bound flows (search→enqueue,
  player seek, live Shikimori sync) are deliberately excluded to keep CI
  deterministic; their underlying logic is covered at the unit + integration
  layers.

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

## IPC contract guard

`test/ipc-channels.test.ts` asserts every `CHANNELS` / `EVENT_CHANNELS` entry is
referenced as a symbol on both sides, has a registered `ipcMain.handle`, and has
a matching preload binding — so deleting a handler or binding fails the build.

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

Two pinned counts are what give that teeth, for the reasons in *Structural
tests* above:

- **Suspicious landings, pinned at 0.** Every such landing on this tree was
  stale: #336 repaired all thirteen, and #344 repaired the two the narrowing
  above exposed — both anchors from
  `test/services/syncplay-mirror-election.test.ts` into `docs/syncplay.md`, one
  81 lines behind its subject and one 119. So the measured false-positive rate
  is zero. A deliberate landing raises the pin by one, with its reason in the
  commit message. What the pin does **not** cover is an anchor landing on a live
  code line: that is checked for existence only. The four same-file anchors in
  the `suspiciousLanding()` comment are the clearest case — all four target
  `if (…)` lines, invisible to blank, bare brace and comment line alike, and the
  two naming the consecutive bare-brace and comment-line predicates differ by
  one, so a single line inserted above the ladder re-points each at its
  neighbour's test, green and wrong. `resolved` counts anchors that resolve, not
  anchors that are checked.
- **Uncheckable anchors.** Bare basenames more than one tracked file carries
  (`syncplay.ts` is both `src/main/syncplay.ts` and
  `src/renderer/src/stores/syncplay.ts`) and pathless `:NNN` anchors that
  inherit their path from a neighbouring line. Neither can be resolved, so the
  pin bounds how much the gate is blind to. Adding one reds the build; the fix
  is almost always to give the anchor a resolvable path rather than raise the
  number.

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
