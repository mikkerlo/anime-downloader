// The Syncplay server password is owned by main (#216). Before this, the two
// join flows sent no password at all, so password-protected servers killed the
// session right after Hello.
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import { SyncplayPasswordVault, SYNCPLAY_PASSWORD_KEY } from '../../src/main/syncplay-credentials'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { register } from '../../src/main/ipc/syncplay.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { InMemoryStorage } from '../helpers/in-memory-storage'

vi.mock('../../src/main/syncplay', () => ({
  syncplay: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    setFile: vi.fn(),
    sendLocalState: vi.fn(),
    updateSnapshot: vi.fn(),
    setReady: vi.fn(),
    getStatus: vi.fn(() => ({ state: 'idle' })),
    getRoomUsers: vi.fn(() => [])
  }
}))

import { syncplay } from '../../src/main/syncplay'

describe('SyncplayPasswordVault', () => {
  let store: InMemoryStorage

  beforeEach(() => {
    store = new InMemoryStorage()
  })

  it('persists under its own key, not inside the syncplay settings object', () => {
    store.set('syncplay', { lastHost: 'syncplay.pl' })
    const vault = new SyncplayPasswordVault(store)
    vault.set('hunter2')

    expect(store.get(SYNCPLAY_PASSWORD_KEY)).toBe('hunter2')
    // The renderer overwrites `syncplay` wholesale on every settings save, so a
    // password living in there would be silently dropped.
    expect(JSON.stringify(store.get('syncplay'))).not.toContain('hunter2')
  })

  it('round-trips through a fresh vault (app restart)', () => {
    new SyncplayPasswordVault(store).set('hunter2')

    const reopened = new SyncplayPasswordVault(store)
    expect(reopened.get()).toBe('hunter2')
    expect(reopened.has()).toBe(true)
  })

  it('reports no password for a missing or non-string value', () => {
    const vault = new SyncplayPasswordVault(store)
    expect(vault.get()).toBe('')
    expect(vault.has()).toBe(false)

    store.set(SYNCPLAY_PASSWORD_KEY, 42)
    expect(vault.get()).toBe('')
  })

  it('clears on empty input and via clear()', () => {
    const vault = new SyncplayPasswordVault(store)
    vault.set('hunter2')

    vault.set('')
    expect(vault.has()).toBe(false)
    expect(store.get(SYNCPLAY_PASSWORD_KEY)).toBe('')

    vault.set('hunter2')
    vault.clear()
    expect(new SyncplayPasswordVault(store).has()).toBe(false)
  })
})

describe('syncplay:connect password injection (#216)', () => {
  const connectCfg = {
    host: 'syncplay.test',
    port: 8999,
    room: 'r',
    username: 'u',
    autoReconnect: true
  }

  const registerRouter = (): {
    invoke: (channel: string, ...args: unknown[]) => unknown
    store: InMemoryStorage
  } => {
    const store = new InMemoryStorage()
    store.set('syncplay', {})
    register({ store } as unknown as AppDeps)
    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
    )
    return {
      invoke: (channel, ...args) => handlers.get(channel)!({}, ...args),
      store
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The regression: WatchTogetherView and the in-player join send no password
  // field, so without injection they connect unauthenticated and the server
  // drops them with "password required".
  it('injects the stored password when the caller sends none', () => {
    const { invoke } = registerRouter()
    invoke(CHANNELS.SYNCPLAY_SET_PASSWORD, 'hunter2')

    invoke(CHANNELS.SYNCPLAY_CONNECT, connectCfg)

    expect(vi.mocked(syncplay.connect)).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'hunter2', host: 'syncplay.test' })
    )
  })

  it('leaves the password undefined when none is stored', () => {
    const { invoke } = registerRouter()

    invoke(CHANNELS.SYNCPLAY_CONNECT, connectCfg)

    expect(vi.mocked(syncplay.connect)).toHaveBeenCalledWith(
      expect.objectContaining({ password: undefined })
    )
  })

  it('prefers an explicitly supplied password over the stored one', () => {
    const { invoke } = registerRouter()
    invoke(CHANNELS.SYNCPLAY_SET_PASSWORD, 'stored')

    invoke(CHANNELS.SYNCPLAY_CONNECT, { ...connectCfg, password: 'explicit' })

    expect(vi.mocked(syncplay.connect)).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'explicit' })
    )
  })

  it('never writes the password into the syncplay settings object', () => {
    const { invoke, store } = registerRouter()
    invoke(CHANNELS.SYNCPLAY_SET_PASSWORD, 'hunter2')

    invoke(CHANNELS.SYNCPLAY_CONNECT, { ...connectCfg, password: 'hunter2' })

    // The renderer overwrites this object wholesale on every settings save, so
    // the credential must live under its own key.
    expect(JSON.stringify(store.get('syncplay'))).not.toContain('hunter2')
    expect(invoke(CHANNELS.SYNCPLAY_HAS_PASSWORD)).toBe(true)
  })
})
