# Testing

Two runners, split by what they touch (refactor epic #84, Phase 7):

```bash
npm run test            # Vitest: unit + integration (no Electron, no network)
npm run test:watch      # Vitest in watch mode
npm run test:coverage   # Vitest + v8 coverage; enforces per-seam thresholds
npm run test:e2e        # Playwright: drives the built app in out/ (run `npm run build` first)
npm run test:contract   # Vitest: live API contract check (hits shikimori.one + smotret-anime.ru)
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

- **Live API contract** (`test/contract/`, separate `vitest.contract.config.ts`)
  — weekly probe against the real `shikimori.one` + `smotret-anime.ru` APIs,
  asserting our parsers' required fields are still present and the right
  primitive type. Excluded from `npm run test` so PRs stay offline; runs only
  via `npm run test:contract` or the `Live API contract check` GitHub workflow
  (`.github/workflows/contract-check.yml`, Mondays 06:00 UTC + manual dispatch).
  Anonymous endpoints only — no OAuth tokens in CI. Assertions are
  intentionally **loose** (parse succeeds, required fields non-null) so
  upstream adding new optional fields doesn't trip us. On failure the workflow
  opens or comments on a sticky issue tagged `contract-drift`; investigate by
  re-recording the affected fixture under `test/fixtures/` and updating the
  matching TypeScript interface in `src/main/shikimori.ts` or
  `src/main/smotret-api.ts`, then verify `npm run test:contract` passes
  locally before closing the issue. (#141)

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
