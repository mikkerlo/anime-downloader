# TODO

## Code Quality

- [ ] Duplicated `formatBytes`, `formatSpeed`, `formatEta` utilities in DownloadsView.vue and AnimeDetailView.vue — extract to shared module
- [ ] Anime name derivation (`titles?.romaji || titles?.ru || title`) repeated in 5+ places — extract to shared helper

## UX / Robustness

- [x] Show progress/message during ffmpeg+ffprobe download on first launch — currently the app appears frozen with no feedback, causing users to reboot
- [ ] Add "Retry all" button in DownloadsView for all failed downloads at once
- [ ] No confirmation dialogs for destructive actions (delete file, remove files from library, cancel all downloads)
- [ ] Download queue not persisted — app crash loses all queue state, no resume-on-restart
- [ ] Settings require manual Save button click — easy to forget after toggling auto-merge or changing codec
- [ ] No API token validation — error only surfaces on first failed download attempt
- [ ] Library load does sequential IPC round-trips per anime for starred/downloaded checks — could batch

## Feature Ideas

- [x] Offline library support — cache anime details (episodes, translations, poster) locally so downloaded anime are fully browsable offline. Show OFFLINE badge on anime detail page when serving cached data. Still fetch fresh data in background when online and update the view silently if successful.
- [ ] System notifications when downloads/merges complete (useful when app is in background)
- [ ] Download speed throttle / bandwidth limiting
- [ ] Episode range selection (e.g. episodes 1-12, "season 1" batching)
- [ ] Keyboard shortcuts (Escape to go back from detail view, etc.)
- [ ] Search history persistence across sessions
- [ ] Auto-update mechanism
