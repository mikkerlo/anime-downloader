# Build

```bash
npm run dev          # Development with hot reload
npm run build        # Compile to out/
npm run pack:win     # Build + package Windows portable exe
npm run pack:linux   # Build + package Linux AppImage
npm run pack:mac     # Build + package macOS zip
```

Dependencies: electron-vite bundles everything except electron-store (excluded from externalization to handle ESM). FFmpeg + ffprobe downloaded at runtime by `src/main/ffmpeg-binaries.ts` (native `fetch` against the `ffbinaries-prebuilt` GitHub releases).
