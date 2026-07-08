# Auto-Update

Uses `electron-updater` with GitHub releases as the update source. The CI uploads `latest.yml` / `latest-linux.yml` / `latest-mac.yml` plus `*.blockmap` files (differential downloads) alongside platform artifacts — electron-updater reads these to determine available versions.

- `autoDownload = false` — user must explicitly click "Download update"
- Auto-checks on app launch if the last check was >24 hours ago (`lastUpdateCheck` setting)
- Manual check via Settings > General > "Check for updates" button; an available/downloading/ready update also surfaces in the sidebar banner (`SidebarUpdateBanner.vue`)
- Flow: check → show available version → download with progress bar → "Restart to update"
- Publish config in `package.json` points to `github:mikkerlo/anime-downloader`

## Per-platform support (#189)

| Build | Mechanism |
|---|---|
| Windows NSIS | electron-updater self-update (full flow above) |
| Windows portable | **Manual mode** — see below |
| Linux AppImage | electron-updater self-update |
| Linux deb | no self-update (electron-updater doesn't support deb); package manager territory |
| macOS zip/dmg | electron-updater (Squirrel.Mac) — **requires the signed + notarized build** (see `docs/build.md`); Squirrel refuses unsigned updates |

## Manual mode (Windows portable)

The portable exe has no installer for the updater to swap in, so `app.ipc.ts` detects it (`process.platform === 'win32' && PORTABLE_EXECUTABLE_DIR` — set by electron-builder's portable launcher) and routes the same three IPC channels differently:

- `UPDATE_CHECK` → `checkLatestRelease` (`src/main/lib/manual-update.ts`): native `fetch` of the GitHub `releases/latest` API, numeric version compare against `app.getVersion()`, broadcasts `{ status: 'available', version, manual: true }` or `{ status: 'up-to-date' }`.
- `UPDATE_DOWNLOAD` / `UPDATE_INSTALL` → `shell.openExternal(releasePageUrl)` — the renderer's action button reads `manual` and relabels to **"Open download page"** (GeneralTab + sidebar banner); `downloading`/`ready` states never occur in this mode.

The `manual?: boolean` flag lives on the shared `UpdateStatus` type (`src/shared/types/app.d.ts`) and the store-side `UiUpdateStatus` (`src/renderer/src/stores/settings.ts`).
