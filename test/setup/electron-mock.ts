/**
 * Global Vitest mock for the `electron` module (Phase 7 PR 1, #140).
 *
 * Wired via `vitest.config.ts` → `test.setupFiles`. Provides the minimal
 * surface main-process services touch so any test that pulls `electron` in
 * (directly or transitively) doesn't have to re-implement a local stub.
 *
 * Per-test `vi.mock('electron', ...)` calls still override this — the global
 * mock is a sensible default, not a hard floor.
 */
import { vi } from 'vitest'

type Listener = (event: unknown, ...args: unknown[]) => void

// Renderer-side listener registry. Mirrors the per-test mock that
// `test/preload/subscribe.test.ts` used to carry; exposing __emit + __reset
// lets tests drive events deterministically.
const rendererListeners = new Map<string, Set<Listener>>()

export function __emit(channel: string, ...args: unknown[]): void {
  const bucket = rendererListeners.get(channel)
  if (!bucket) return
  for (const listener of [...bucket]) listener({}, ...args)
}

export function __reset(): void {
  rendererListeners.clear()
}

vi.mock('electron', () => {
  return {
    ipcRenderer: {
      on(channel: string, listener: Listener): void {
        let bucket = rendererListeners.get(channel)
        if (!bucket) {
          bucket = new Set()
          rendererListeners.set(channel, bucket)
        }
        bucket.add(listener)
      },
      removeListener(channel: string, listener: Listener): void {
        rendererListeners.get(channel)?.delete(listener)
      },
      removeAllListeners(channel: string): void {
        rendererListeners.get(channel)?.clear()
      },
      invoke: vi.fn(),
      send: vi.fn()
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn()
    },
    app: {
      getPath: vi.fn((name: string) => `/tmp/electron-mock/${name}`),
      getAppPath: vi.fn(() => '/tmp/electron-mock'),
      getName: vi.fn(() => 'anime-downloader-test'),
      getVersion: vi.fn(() => '0.0.0-test'),
      on: vi.fn(),
      once: vi.fn(),
      quit: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      commandLine: { appendSwitch: vi.fn() }
    },
    BrowserWindow: class {
      static getAllWindows = vi.fn(() => [] as unknown[])
      static getFocusedWindow = vi.fn(() => null)
      webContents = { send: vi.fn() }
      on = vi.fn()
      loadFile = vi.fn()
      loadURL = vi.fn()
      close = vi.fn()
    },
    Notification: class {
      static isSupported = vi.fn(() => true)
      show = vi.fn()
      on = vi.fn()
    },
    shell: {
      openExternal: vi.fn(),
      openPath: vi.fn(() => Promise.resolve('')),
      showItemInFolder: vi.fn(),
      trashItem: vi.fn(() => Promise.resolve())
    },
    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn(),
      registerStreamProtocol: vi.fn()
    },
    net: {
      fetch: vi.fn()
    },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn()
    }
  }
})
