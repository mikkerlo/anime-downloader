# GEMINI.md

## Project

Electron + Vue 3 + TypeScript desktop app for downloading anime. See `DESIGN.md` for architecture and GitHub Issues for planned work.

## Stack

- Electron 41, electron-vite 5, Vue 3 (Composition API, `<script setup>`), TypeScript 6
- electron-store for persistence, fluent-ffmpeg for merging, ffbinaries for ffmpeg auto-download
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
- IPC pattern: `ipcMain.handle` in main → `contextBridge` in preload → `window.api.*` in renderer
- New IPC channels need updates in 4 files: `main/index.ts`, `preload/index.ts`, `preload/types.d.ts`, and the consuming component
- Keep `DESIGN.md` up to date when adding IPC handlers, settings, or changing architecture
- Don't add unnecessary comments, docstrings, or type annotations to unchanged code

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
2. **Preload & IPC (`src/preload/`):**
   - *Note: Remember to update both `preload/index.ts` and `preload/types.d.ts` for any new IPC channels.*
   - [ ] Step 2...
3. **Renderer (`src/renderer/`):**
   - [ ] Step 3...

## Files to Touch
- **New:** `path/to/new-file.ts`
- **Modify:** `path/to/existing-file.vue`
- **Documentation:** `DESIGN.md` *(Required if IPC channels, settings, or architecture changed)*

## Testing Strategy
*How will we verify this change works? What specific scenarios, platforms (Windows/Mac/Linux), or edge cases need manual testing?*

## Risks & Edge Cases
*Potential pitfalls, race conditions, performance impacts, or regressions to watch out for.*

## Out of Scope
*What are we deliberately NOT doing in this issue? (List ideas that should be tracked in separate issues).*
```
