# Auto-Update

Uses `electron-updater` with GitHub releases as the update source. The CI uploads `latest.yml` / `latest-linux.yml` / `latest-mac.yml` alongside platform artifacts — electron-updater reads these to determine available versions.

- `autoDownload = false` — user must explicitly click "Download update"
- Auto-checks on app launch if the last check was >24 hours ago (`lastUpdateCheck` setting)
- Manual check via Settings > General > "Check for updates" button
- Flow: check → show available version → download with progress bar → "Restart to update"
- Publish config in `package.json` points to `github:mikkerlo/anime-downloader`
