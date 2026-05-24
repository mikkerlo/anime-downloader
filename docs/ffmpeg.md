# FFmpeg

Both `ffmpeg` and `ffprobe` are auto-downloaded on first app launch via `src/main/ffmpeg-binaries.ts` to the app's userData directory. Platform is auto-detected. The two `.zip` archives are fetched (via node's built-in `fetch`) from `github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/`, extracted with the system `tar` (Windows 10 1803+ ships tar in PATH), and `chmod 0o755`'d into `app.getPath('userData')/ffmpeg/`. ffprobe is required for duration probing (used in merge progress calculation).

Available video codecs for merge (filtered by what ffmpeg reports):
- `copy` — no re-encode, fastest
- `libx265` — H.265 CPU
- `hevc_nvenc` — H.265 NVIDIA GPU
- `hevc_amf` — H.265 AMD GPU
- `hevc_qsv` — H.265 Intel QuickSync
- `hevc_videotoolbox` — H.265 macOS hardware

Merge progress is calculated from `timemark / probed_duration` (works for all codecs). Sequential merging enforced (one merge at a time). Active merge can be cancelled (kills ffmpeg, cleans partial output).
