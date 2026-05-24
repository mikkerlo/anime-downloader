# GEMINI.md

## Project

Electron + Vue 3 + TypeScript desktop app for downloading anime. `DESIGN.md` is the architecture index — it links to per-subsystem pages under `docs/`. See GitHub Issues for planned work.

## Stack

- Electron 41, electron-vite 5, Vue 3 (Composition API, `<script setup>`), TypeScript 6
- electron-store for persistence, fluent-ffmpeg for merging, hand-rolled fetch (`src/main/ffmpeg-binaries.ts`) for ffmpeg auto-download
- Dark theme UI, no component library

## Dev commands

```bash
npm run dev          # Run app with hot reload
npm run build        # Compile to out/
npm run typecheck    # Type check
```

## Version control

This project uses **jj (Jujutsu)**, not git directly. The workflow for committing and pushing:

```bash
jj describe -m "Commit message here"
jj bookmark create <branch-name> -r @
jj git push -b <branch-name>
gh pr create --fill
```

- Never use `git commit` / `git push` — always use jj commands
- Always create a PR using `gh pr create` — do not push directly to main unless the user specifically asks you to.

## Commit & release workflow

When asked to "make a commit" or "make a cl":
1. `jj describe -m "message"` — describe the working copy (reference GitHub issues as needed)
2. Bump version in `package.json` if asked (ask which bump if unclear)
3. Create a branch, push, and open a PR:
   ```bash
   jj bookmark create <branch-name> -r @
   jj git push -b <branch-name>
   gh pr create --fill
   ```

CI auto-creates a GitHub release when `package.json` version changes on main.

## Code conventions

- All Vue components use `<script setup lang="ts">` with Composition API
- IPC pattern: `ipcMain.handle` in a `src/main/ipc/<domain>.ipc.ts` router → `contextBridge` in preload → `window.api.*` in renderer (or a Pinia store)
- **Adding a new IPC channel** (post-refactor epic #84):
  1. Add the channel name to `src/shared/ipc/channels.ts` (`CHANNELS` for request/response, `EVENT_CHANNELS` for `send`-direction broadcasts) — single source of truth, dereferenced by symbol on both sides; the drift test fails the build if it gets out of sync
  2. Add payload/return types to the relevant `src/shared/types/*.d.ts` (ambient — no import churn)
  3. Add the `ipcMain.handle` / broadcast in the matching `src/main/ipc/<domain>.ipc.ts` router, referencing `CHANNELS.X` by symbol
  4. Add the `window.api.<method>` line in `src/preload/index.ts` (uses the `CHANNELS.X` symbol) and its signature in `src/preload/types.d.ts`
  5. For `send`-direction broadcasts: use the `EventSubscriber<T>` contract — the preload returns an unsubscribe handle; never use `removeAllListeners` or `off*` (CI gate `npm run check:subscription-contract` enforces this)
  6. Consume from a component or Pinia store; cross-view broadcasts belong in the store, not in a component
- Renderer architecture: Pinia stores in `src/renderer/src/stores/`, composables in `src/renderer/src/composables/`, components organized as `views/` + `shared/` + per-feature folders (`detail/`, `player/`, `settings/`). See `docs/renderer.md` for the full inventory
- Keep `docs/<subsystem>.md` up to date when adding IPC handlers, settings, or changing architecture — the relevant page lives under `docs/` (e.g. `docs/ipc.md` for new channels, `docs/settings.md` for new electron-store keys). `DESIGN.md` itself is just the index
- Don't add unnecessary comments, docstrings, or type annotations to unchanged code

## Testing

Tests are required, not optional. The suite (Vitest unit + integration, Playwright e2e) plus a per-seam coverage gate run in CI's `quality` job on every PR — see `docs/testing.md` for the layers, layout, and thresholds.

- **Every new feature ships with tests that exercise it.** A feature PR with no test for the new behavior is incomplete.
- **Every change updates its tests in the same PR.** If you change behavior, update (or add) the tests that cover it — never leave them asserting the old behavior.
- **Prefer a test that captures the behavior difference.** Ideally add a case that fails on the old behavior and passes on the new one (a regression/characterization test), so the diff is self-documenting and the change can't silently revert. Bug fixes get a regression test that fails without the fix.
- Put tests next to their seam: main services/`lib` + API-client fixture replay + the IPC contract guard under `test/`; integration flows under `test/integration/` (via `test/helpers/app-harness.ts`); renderer stores/composables under `test/renderer/`; end-to-end flows under `e2e/`.
- Run `npm run test` (or `npm run test:coverage`) and `npm run test:e2e` locally before pushing. CI runs the full quality gate; a coverage-threshold regression (`vitest.config.ts`) fails the build.

## Issue / Plan Template

When writing plans for issues, use the following standardized structure:

```markdown
**Priority:** [High/Medium/Low] | **Effort:** [Small/Medium/Large]

## Motivation
*Why are we doing this? What user problem does it solve, or what technical debt does it address?*

## Approach & Architecture
*High-level technical approach. How does this fit into the existing architecture? Any new data sources, APIs, or dependencies?*

## UI / UX Considerations (If applicable)
*How does this affect the user interface? Are there new Vue components, layout changes, or user flow updates? (Provide mockups or references if available).*

## Implementation Plan
*Step-by-step technical plan, categorized by architectural boundaries.*

1. **Main Process (`src/main/`):**
   - [ ] Step 1...
2. **Preload & IPC (`src/preload/`, `src/shared/ipc/`):**
   - *Note: New IPC channels start in `src/shared/ipc/channels.ts` (single source of truth), then wire through `src/main/ipc/<domain>.ipc.ts` + `src/preload/index.ts` + `src/preload/types.d.ts`. See `docs/ipc.md`.*
   - [ ] Step 2...
3. **Renderer (`src/renderer/`):**
   - [ ] Step 3...

## Files to Touch
- **New:** `path/to/new-file.ts`
- **Modify:** `path/to/existing-file.vue`
- **Documentation:** the relevant `docs/<subsystem>.md` *(Required if IPC channels, settings, or architecture changed — `DESIGN.md` is just the index)*

## Testing Strategy
*Automated tests are required — list the unit / integration / e2e tests you will add or change to cover this work, ideally one that shows the behavior difference (fails on the old behavior, passes on the new). Then how it's verified manually: scenarios, platforms (Windows/Mac/Linux), edge cases.*

## Risks & Edge Cases
*Potential pitfalls, race conditions, performance impacts, or regressions to watch out for.*

## Out of Scope
*What are we deliberately NOT doing in this issue? (List ideas that should be tracked in separate issues).*
```
