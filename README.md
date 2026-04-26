# Anime DL

[![Ready for Implementation](https://img.shields.io/badge/Issues-Ready%20for%20Implementation-2cbe4e?style=flat-square&logo=github)](https://github.com/mikkerlo/anime-downloader/issues?q=is%3Aopen+is%3Aissue+label%3A%22Ready+for+implementation%22)

Desktop app for downloading anime episodes from [smotret-anime.ru](https://smotret-anime.ru) (anime365).

Built with Electron, Vue 3, and TypeScript.

## Features

- Search and browse anime catalog
- Per-episode translation selector with multiple types (subtitles, voice, raw)
- Download video + subtitles with resume support
- Automatic merging into MKV via ffmpeg (downloaded automatically on first launch)
- Re-encoding support (H.265 CPU/GPU)
- Library with starred and downloaded anime tracking
- Cross-platform (Windows, macOS, Linux)

## Requirements

- Node.js 18+
- npm

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build              # compile to out/
npm run pack:win           # Windows portable exe
npm run pack:linux         # Linux AppImage
npm run pack:mac           # macOS zip
```

## Configuration

On first launch, set your smotret-anime.ru API token in **Settings > General**. The token is required for downloading episodes.

FFmpeg is downloaded automatically to the app data directory on first run.

## Project Structure

```
src/
  main/           Electron main process (downloads, merging, API proxy)
  preload/        IPC bridge (contextBridge)
  renderer/       Vue 3 frontend (search, library, downloads, settings)
```

See [DESIGN.md](DESIGN.md) for detailed architecture documentation.

## License

ISC
