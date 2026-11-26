// A Shikimori-only start never touches safeStorage (#690): no Keychain or
// keyring prompt can come from a profile with no AniList or MAL sign-in.
//
// Composes the pieces `src/main/index.ts` builds (it boots the app when
// imported): the real store over `STORE_DEFAULTS` with the real write-through
// list in a temp dir, the safeStorage holder with a getter attached as
// `bootstrap()` does, the vault, and the settings router, then #693 (T2c)'s
// boot drain and online kick-off list. #702 (T6) and #703 (T7) extend this
// with their boot pieces.
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
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createOfflineKickoff } from '../../src/main/services/offline/kickoff'
import { bootDrain, edgeTrackers, kickoffTrackers } from '../../src/main/services/trackers/edges'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import { shikimoriOnlyFanOut } from '../helpers/tracker-fan-out'
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

  // #693: the boot drain and the online kick-off's tracker list, as
  // `bootstrap()` builds them over the fan-out's sync services.
  function trackerEdges(store: ReturnType<typeof boot>['store']) {
    const sync = createShikimoriSyncService({
      store,
      broadcast: () => {},
      syncStatusChannel: 's',
      offlineQueueChangedChannel: 'q',
      rateUpdatedChannel: 'r',
      animeDetailsUpdatedChannel: 'd',
      isOffline: () => false
    })
    const fan = shikimoriOnlyFanOut(store, sync)
    const timer = vi.spyOn(sync.tracker, 'startSyncTimer')
    const drain = vi.spyOn(sync.tracker, 'syncQueue')
    const prefetch = vi.fn(async () => undefined)
    const kickoff = createOfflineKickoff({
      trackers: () => kickoffTrackers(store, fan.syncServices(), prefetch),
      suspendDownloads: vi.fn(),
      resumeDownloads: vi.fn(),
      suspendSyncplay: vi.fn(),
      resumeSyncplay: vi.fn(),
      retryBinaries: vi.fn(),
      runAutoDownloadTick: vi.fn()
    })
    return {
      timer,
      drain,
      bootDrain: () => bootDrain(edgeTrackers(store, fan.syncServices())),
      onOnline: () => kickoff.onOnline(),
      stop: () => {
        kickoff.onOffline()
        sync.tracker.stopSyncTimer()
      }
    }
  }

  it('the boot drain and the online kick-off touch no safeStorage either', async () => {
    const { store, fake } = boot()
    const edges = trackerEdges(store)
    try {
      edges.bootDrain()
      edges.onOnline()
      await Promise.resolve()
      // An empty queue: no timer at boot; the online edge still kicks Shikimori's drain.
      expect(edges.timer).not.toHaveBeenCalled()
      expect(edges.drain).toHaveBeenCalledTimes(1)
    } finally {
      edges.stop()
    }
    expect(fake.getter).not.toHaveBeenCalled()
    expect(fake.untouched()).toBe(true)
  })

  it('signed out with a non-empty live queue: boot still starts Shikimori’s timer and kicks its drain, as on 6.0.21', async () => {
    fs.writeFileSync(
      tmp.cfg,
      JSON.stringify({
        shikimoriCredentials: null,
        shikimoriUser: null,
        shikimoriUpdateQueue: [
          {
            malId: 10,
            rateId: null,
            queuedAt: 1,
            before: { episodes: 0, status: 'watching', score: 0, rewatches: 0 },
            after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
          }
        ],
        installId: 'pc-a'
      })
    )
    const { store, fake } = boot()
    const edges = trackerEdges(store)
    try {
      edges.bootDrain()
      expect(edges.timer).toHaveBeenCalledTimes(1)
      expect(edges.drain).toHaveBeenCalledTimes(1)
      edges.onOnline()
      expect(edges.drain).toHaveBeenCalledTimes(2)
    } finally {
      edges.stop()
    }
    // The drain returned at its own signed-out guard: the queue is kept.
    expect(store.get('shikimoriUpdateQueue')).toHaveLength(1)
    expect(fake.untouched()).toBe(true)
  })
})
