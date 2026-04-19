# iPad Port Overview: The "Pure Streaming" Plan

This document outlines the goal of porting the Desktop (Electron) app to an iPad (Capacitor) app with a focus on streaming and lightweight offline support.

## Core Mandates
- **No FFmpeg:** Merging and MKV remuxing is disabled (iPad can't handle subprocesses).
- **Streaming First:** Native iPad `<video>` tag supports H.264/AAC MP4s directly from smotret-anime CDN.
- **Offline = MP4 only:** Downloaded files must be MP4 or WebM to play without native remuxing.
- **Subtitles:** Preserve full ASS styling via JASSUB (WASM).
- **Upscaling:** Keep Anime4K WebGPU shaders for M1/M2/M4 iPads.

## High-Level Tech Stack
| Feature | Desktop (Current) | iPad (Proposed) |
| :--- | :--- | :--- |
| **Runtime** | Electron (Node.js) | Capacitor (iPadOS WebView) |
| **Storage** | `electron-store` | `Capacitor SQLite` / `Preferences` |
| **API Proxy** | `ipcMain` + `fetch` | `Capacitor HTTP` (Native CORS bypass) |
| **Downloads** | `DownloadManager` (Node) | `Capacitor Background Downloader` |
| **Subtitles** | `libass-wasm` | `libass-wasm` (Same WASM, different pathing) |
| **Upscaling** | `WebGPU` (Desktop) | `WebGPU` (Experimental/Native Flag) |
