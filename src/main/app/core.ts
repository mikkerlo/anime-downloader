import { app, protocol } from 'electron'

export interface StartOptions {
  onReady: () => Promise<void> | void
  onBeforeQuit: () => void
}

/**
 * Owns the Electron-app lifecycle (refactor epic #84, Phase 3 slice 3a).
 *
 * Construction applies the early switches and scheme registration that must
 * land *before* `app.whenReady()` fires; `start()` then drives the ready/quit
 * events and hands off to the caller-provided `onReady` for the rest of the
 * boot. Subsequent Phase 3 slices migrate service construction and IPC router
 * wiring into this class so `src/main/index.ts` reduces to `new App().start()`.
 */
export class App {
  constructor() {
    // Enable WebGPU (Anime4K shaders) and platform HEVC decoding (HEVC MKV via MSE).
    // PlatformHEVCDecoderSupport gates Chromium's HEVC path in <video> and MSE;
    // without it, MediaSource.isTypeSupported('…hvc1…') returns false even on
    // systems that have a hardware decoder available.
    app.commandLine.appendSwitch('enable-unsafe-webgpu')
    app.commandLine.appendSwitch('enable-features', 'Vulkan,PlatformHEVCDecoderSupport')

    protocol.registerSchemesAsPrivileged([
      {
        scheme: 'anime-video',
        privileges: { stream: true, bypassCSP: true, supportFetchAPI: true }
      }
    ])

    // Suppress EPIPE errors from broken stdout/stderr pipes (common on WSL2).
    process.stdout?.on('error', () => {})
    process.stderr?.on('error', () => {})
  }

  async start(opts: StartOptions): Promise<void> {
    await app.whenReady()
    await opts.onReady()

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit()
      }
    })

    app.on('before-quit', () => {
      opts.onBeforeQuit()
    })
  }
}
