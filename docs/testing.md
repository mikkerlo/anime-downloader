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
  `test/services/syncplay-mirror-drift.test.ts`, #279).

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
