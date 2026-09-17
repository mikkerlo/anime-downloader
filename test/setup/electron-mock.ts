/**
 * Global Vitest mock for the `electron` module (Phase 7 PR 1, #140).
 *
 * Wired via `vitest.config.ts` → `test.setupFiles`. Provides the minimal
 * surface main-process services touch so any test that pulls `electron` in
 * (directly or transitively) doesn't have to re-implement a local stub.
 *
 * Per-test `vi.mock('electron', ...)` calls still override this — the global
 * mock is a sensible default, not a hard floor. That applies to the invoke
 * loop below as well: a test file that declares its own `electron` factory
 * replaces this module wholesale, so `__enableIpcLoop()` imported from here
 * would arm a registry nothing in that file ever writes to. Such a file has to
 * build its own loop, or drop its factory and use this one.
 */
import { vi } from 'vitest'

type Listener = (event: unknown, ...args: unknown[]) => void
type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

// Renderer-side listener registry. Mirrors the per-test mock that
// `test/preload/subscribe.test.ts` used to carry; exposing __emit + __reset
// lets tests drive events deterministically.
const rendererListeners = new Map<string, Set<Listener>>()

// Main-side `ipcMain.handle` registry. Always recorded — `handle` stays a
// `vi.fn()` with an implementation, so `(ipcMain.handle as Mock).mock.calls`
// keeps working for the tests that read registrations off the spy directly
// (`test/services/syncplay-password-vault.test.ts`).
const mainHandlers = new Map<string, InvokeHandler>()

// Off by default. Routing `invoke` into the registry changes what ~790 existing
// cases get back from a bare `ipcRenderer.invoke` spy (`undefined`) into either
// a handler's return value or a rejection, so the loop is opt-in per test file.
let ipcLoopEnabled = false

export function __emit(channel: string, ...args: unknown[]): void {
  const bucket = rendererListeners.get(channel)
  if (!bucket) return
  for (const listener of [...bucket]) listener({}, ...args)
}

/**
 * Close the renderer→main half of the bridge for this test: `ipcRenderer.invoke`
 * starts routing into whatever `ipcMain.handle` registered, instead of
 * resolving `undefined`. The main→renderer half is already closed — a
 * broadcaster that calls `__emit` reaches every `ipcRenderer.on` subscriber.
 *
 * Not a full IPC emulation: arguments and return values are passed by
 * reference, where real IPC structured-clones them. A test that cares about
 * clone semantics (functions, class instances, cycles) is not covered here.
 */
export function __enableIpcLoop(): void {
  ipcLoopEnabled = true
}

export function __disableIpcLoop(): void {
  ipcLoopEnabled = false
}

/** Channels with a registered handler, in registration order. */
export function __registeredChannels(): string[] {
  return [...mainHandlers.keys()]
}

/** Clears both registries and disarms the loop. */
export function __reset(): void {
  rendererListeners.clear()
  mainHandlers.clear()
  ipcLoopEnabled = false
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
      // Still a spy (call assertions keep working); the implementation is inert
      // until a test calls `__enableIpcLoop()`.
      invoke: vi.fn((channel: string, ...args: unknown[]) => {
        if (!ipcLoopEnabled) return undefined
        const handler = mainHandlers.get(channel)
        // Real `invoke` always returns a promise, and a synchronous throw in the
        // handler comes back to the renderer as a rejection — so the whole call
        // runs inside one.
        //
        // Both rejection paths take the same wrapper on purpose. In Electron the
        // no-handler error is raised in main and travels back through the very
        // same renderer-side wrapper as a handler throw, so what a renderer sees
        // is `Error invoking remote method '<channel>': <Name>: <message>` in
        // both cases. Since the point of the loop is that a test can assert what
        // the renderer actually sees, the mock owes it that shape.
        const asRemoteError = (err: unknown): Error =>
          new Error(
            `Error invoking remote method '${channel}': ` +
              (err instanceof Error ? `${err.name}: ${err.message}` : String(err))
          )
        return (async () => {
          if (!handler) throw asRemoteError(new Error(`No handler registered for '${channel}'`))
          try {
            return await handler({}, ...args)
          } catch (err) {
            throw asRemoteError(err)
          }
        })()
      }),
      send: vi.fn()
    },
    contextBridge: {
      // `src/preload/index.ts` only reaches for this when `process.contextIsolated`
      // is set, which it is not under Vitest — the preload takes its `window.api`
      // branch instead. Present so importing the preload can never crash on a
      // missing export.
      exposeInMainWorld: vi.fn((key: string, value: unknown) => {
        ;(globalThis as Record<string, unknown>)[key] = value
      })
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: InvokeHandler) => {
        mainHandlers.set(channel, handler)
      }),
      on: vi.fn(),
      removeHandler: vi.fn((channel: string) => {
        mainHandlers.delete(channel)
      }),
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
