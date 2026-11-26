// A Shikimori-only start never touches safeStorage (#690): no Keychain or
// keyring prompt can come from a profile with no AniList or MAL sign-in.
//
// Composes the pieces `src/main/index.ts` builds (it boots the app when
// imported): the real store over `STORE_DEFAULTS` with the real write-through
// list in a temp dir, the safeStorage holder with a getter attached as
// `bootstrap()` does, the vault, and the settings router. #693 (T2c), #702
// (T6) and #703 (T7) extend this with their boot pieces.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { createStorageService } from '../../src/main/store'
import { STORE_DEFAULTS, WRITE_THROUGH_KEYS } from '../../src/main/store/defaults'
import { createCredentialVault, VAULT_KEYS } from '../../src/main/trackers/credential-vault'
import { getClientConfig } from '../../src/main/trackers/client-config'
import { register as registerSettings } from '../../src/main/ipc/settings.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import { useTempStoreDir } from '../helpers/temp-store-dir'

const SHIKI_CREDENTIALS = {
  access_token: 'shiki-access',
  refresh_token: 'shiki-refresh',
  token_type: 'Bearer',
  expires_in: 86400,
  created_at: 1_700_000_000
}
const SHIKI_USER = { id: 4242, nickname: 'akira', avatar: '' }

describe('a Shikimori-only boot', () => {
  const tmp = useTempStoreDir()

  beforeEach(() => {
    vi.clearAllMocks()
    // A 6.x profile signed in to Shikimori only: none of the tracker keys.
    fs.writeFileSync(
      tmp.cfg,
      JSON.stringify({
        shikimoriCredentials: SHIKI_CREDENTIALS,
        shikimoriUser: SHIKI_USER,
        shikimoriUpdateQueue: [],
        installId: 'pc-a'
      })
    )
  })

  function boot() {
    const store = createStorageService(STORE_DEFAULTS, {
      cwd: tmp.dir,
      writeThroughKeys: WRITE_THROUGH_KEYS
    })
    store.migrateWatchProgressV2()
    store.ensureInstallId()
    const fake = createFakeSafeStorage({ async: false, platform: 'darwin' })
    const vault = createCredentialVault({ store, safeStorage: fake.holder })
    registerSettings({
      store,
      credentialVault: vault,
      coldStorageService: { getDownloadDir: () => tmp.dir }
    } as unknown as AppDeps)
    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
    )
    const getSetting = async (key: string): Promise<unknown> =>
      handlers.get(CHANNELS.GET_SETTING)!({}, key)
    return { store, fake, vault, getSetting }
  }

  it('adds the tracker keys at their defaults and leaves Shikimori’s keys as they were', () => {
    const { store } = boot()
    store.flush()
    const disk = JSON.parse(fs.readFileSync(tmp.cfg, 'utf8'))
    expect(disk.shikimoriCredentials).toEqual(SHIKI_CREDENTIALS)
    expect(disk.shikimoriUser).toEqual(SHIKI_USER)
    for (const key of VAULT_KEYS) expect(disk[key], key).toBeNull()
    expect(disk.trackerPrimary).toBeNull()
    expect(fs.existsSync(path.join(tmp.dir, 'config.backup.json'))).toBe(true)
  })

  it('reads, has() and getClientConfig() on the three vault keys call neither the getter nor any member', async () => {
    const { store, fake, vault, getSetting } = boot()
    for (const key of VAULT_KEYS) {
      expect(await vault.read(key)).toEqual({ state: 'empty' })
      expect(await vault.has(key)).toBe(false)
      await expect(getSetting(key)).rejects.toThrow(/get-setting refuses/)
    }
    expect(getClientConfig(store)).toEqual({ clientId: null, hasSecret: false })
    expect(await getSetting('shikimoriUser')).toEqual(SHIKI_USER)
    expect(fake.getter).not.toHaveBeenCalled()
    expect(fake.touched).toEqual([])
    expect(fake.untouched()).toBe(true)
  })
})
