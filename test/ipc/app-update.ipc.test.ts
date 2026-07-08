// Behavior split of the update IPC handlers (#189): auto mode drives
// electron-updater; a Windows portable build (PORTABLE_EXECUTABLE_DIR set)
// must instead check GitHub for a newer release and open the release page —
// it can never call into electron-updater's download/install machinery.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { ipcMain, shell, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { register } from '../../src/main/ipc/app.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { InMemoryStorage } from '../helpers/in-memory-storage'

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn(),
    checkForUpdates: vi.fn(async () => ({})),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn()
  }
}))

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** Registers the router against a fresh store and returns the captured handlers + a broadcast spy. */
function registerRouter(): {
  invoke: (channel: string) => Promise<unknown>
  send: Mock
  store: InMemoryStorage
} {
  const send = vi.fn()
  ;(BrowserWindow.getAllWindows as Mock).mockReturnValue([{ webContents: { send } }])
  const store = new InMemoryStorage()
  // Suppress the boot-time check so each test drives handlers explicitly.
  store.set('lastUpdateCheck', Date.now())
  register({ store } as unknown as AppDeps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
  )
  return {
    invoke: async (channel) => handlers.get(channel)!({}),
    send,
    store
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  delete process.env.PORTABLE_EXECUTABLE_DIR
  vi.unstubAllGlobals()
})

describe('update IPC — auto mode (installed builds)', () => {
  it('check/download/install drive electron-updater and never open a browser', async () => {
    const { invoke } = registerRouter()

    await invoke(CHANNELS.UPDATE_CHECK)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)

    await invoke(CHANNELS.UPDATE_DOWNLOAD)
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)

    await invoke(CHANNELS.UPDATE_INSTALL)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)

    expect(shell.openExternal).not.toHaveBeenCalled()
  })
})

describe('update IPC — manual mode (Windows portable)', () => {
  beforeEach(() => {
    setPlatform('win32')
    process.env.PORTABLE_EXECUTABLE_DIR = 'C:\\Users\\x\\AppData\\Local\\Temp'
  })

  function stubLatestRelease(tag: string, url: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: tag, html_url: url })
      }))
    )
  }

  it('check broadcasts a manual "available" status from the GitHub API, not electron-updater', async () => {
    stubLatestRelease('v99.0.0', 'https://example.test/releases/tag/v99.0.0')
    const { invoke, send } = registerRouter()

    await invoke(CHANNELS.UPDATE_CHECK)

    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.UPDATE_STATUS, {
      status: 'available',
      version: '99.0.0',
      manual: true
    })
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('download and install open the release page instead of self-updating', async () => {
    stubLatestRelease('v99.0.0', 'https://example.test/releases/tag/v99.0.0')
    const { invoke } = registerRouter()
    await invoke(CHANNELS.UPDATE_CHECK)

    await invoke(CHANNELS.UPDATE_DOWNLOAD)
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.test/releases/tag/v99.0.0')
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()

    await invoke(CHANNELS.UPDATE_INSTALL)
    expect(shell.openExternal).toHaveBeenCalledTimes(2)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('check broadcasts up-to-date and stamps lastUpdateCheck when nothing newer exists', async () => {
    stubLatestRelease('v0.0.0', 'https://example.test/releases/tag/v0.0.0')
    const { invoke, send, store } = registerRouter()
    const before = store.get('lastUpdateCheck') as number

    await invoke(CHANNELS.UPDATE_CHECK)

    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.UPDATE_STATUS, { status: 'up-to-date' })
    expect((store.get('lastUpdateCheck') as number) >= before).toBe(true)
  })

  it('a failed GitHub check broadcasts an error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    )
    const { invoke, send } = registerRouter()

    await invoke(CHANNELS.UPDATE_CHECK)

    expect(send).toHaveBeenCalledWith(
      EVENT_CHANNELS.UPDATE_STATUS,
      expect.objectContaining({ status: 'error' })
    )
  })
})
