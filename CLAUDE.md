# CLAUDE.md

## Project

Electron + Vue 3 + TypeScript desktop app for downloading anime. See `DESIGN.md` for architecture and `TODO.md` for planned work.

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
jj bookmark set main -r @
jj git push
```

- Never use `git commit` / `git push` — always use jj commands
- Bookmark `main` tracks the current working commit

## Commit & release workflow

When asked to "make a commit" or "make a cl":
1. `jj describe -m "message"` — describe the working copy
2. Bump version in `package.json` if asked (ask which bump if unclear)
3. Strike completed items in `TODO.md` if applicable
4. `jj bookmark set main -r @` then `jj git push`

CI auto-creates a GitHub release when `package.json` version changes on main.

## Code conventions

- All Vue components use `<script setup lang="ts">` with Composition API
- IPC pattern: `ipcMain.handle` in main → `contextBridge` in preload → `window.api.*` in renderer
- New IPC channels need updates in 4 files: `main/index.ts`, `preload/index.ts`, `preload/types.d.ts`, and the consuming component
- Keep `DESIGN.md` up to date when adding IPC handlers, settings, or changing architecture
- Don't add unnecessary comments, docstrings, or type annotations to unchanged code
