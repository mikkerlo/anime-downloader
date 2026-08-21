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
  axis, excludes file-less watchers from the election, and re-elects once a
  second — so "who the server says set the room" is a *result* rather than an
  input. A `doSeek` or a pause change takes the reference's other path instead:
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
