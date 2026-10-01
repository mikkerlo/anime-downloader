// `set-setting` used to write any key the renderer named (#450).
//
// Four of those keys are storage roots, and each already has a channel of its
// own precisely because the store write is only half of the operation: the
// effective download root is a function of `storageMode` / `hotStorageDir` /
// `downloadDir`, while `DownloadManager` holds its root in a cached field that
// only a handful of handlers write. `set-setting` reached the store and nothing
// else, so one line of renderer code could leave the store saying "advanced"
// with the manager still pointed at the simple-mode root — the split state #443
// was filed to remove — and `mkdirSync(…, { recursive: true })` then recreates
// the abandoned root rather than failing, putting new files where the UI in the
// new mode never scans.
//
// Two decisions from the plan review are pinned below. The refusal **throws**
// rather than warning, because a `console.warn` in main is invisible to someone
// working in the renderer and staying invisible is how the
// `autoSave('downloadDir')` echo survived until #449 — so the error names the
// channel that owns the key, which is what the assertions here read. And the
// denylist is spread from `ROOT_KEYS` rather than re-typed, with the equality
// assertion at the bottom standing in for the runtime set-comparison the review
// turned down.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { register } from '../../src/main/ipc/settings.ipc'
import { ROOT_KEYS } from '../../src/main/ipc/storage.ipc'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import type { AppDeps } from '../../src/main/ipc/index'

interface Wiring {
  storageMode?: string
  downloadDir?: string
  hotStorageDir?: string
  coldStorageDir?: string
  token?: string
}

describe('settings IPC — set-setting root-key denylist (#450)', () => {
  let tmpRoot: string
  let hotDir: string
  let fallbackDir: string
  let store: InMemoryStorage
  let setDownloadDir: Mock
  let hasRootBoundWork: Mock
  let invoke: (channel: string, ...args: unknown[]) => Promise<unknown>

  function wire(wiring: Wiring = {}): void {
    ;(ipcMain.handle as Mock).mockClear()

    store = new InMemoryStorage({
      storageMode: wiring.storageMode ?? 'simple',
      downloadDir: wiring.downloadDir ?? hotDir,
      hotStorageDir: wiring.hotStorageDir ?? '',
      coldStorageDir: wiring.coldStorageDir ?? '',
      token: wiring.token ?? 'old-token'
    })

    const coldStorageService = createColdStorageService({
      store,
      downloadsFallbackDir: fallbackDir,
      sanitizeFilename: (s) => s,
      parseEpisodeFromFilename: () => null,
      scanEpisodeFiles: () => ({}),
      invalidateFileCache: () => {},
      broadcast: () => {},
      usageProgressChannel: 'usage-progress',
      cleanupPendingChannel: 'cleanup-pending',
      cleanupFinishedChannel: 'cleanup-finished',
      fileEpisodesChangedChannel: 'file-episodes-changed'
    })

    register({
      store,
      // Present so the assertions can say "the manager was not touched". The
      // handler never reaches for it, which is the whole defect: every other
      // writer of these keys calls `setDownloadDir(getDownloadDir())`.
      downloadManager: { setDownloadDir, hasRootBoundWork },
      coldStorageService
    } as unknown as AppDeps)

    const handlers = new Map<string, (...args: unknown[]) => unknown>(
      (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
    )
    invoke = async (channel, ...args) => handlers.get(channel)!({}, ...args)
  }

  const setSetting = (key: string, value: unknown): Promise<unknown> =>
    invoke(CHANNELS.SET_SETTING, key, value)

  const getSetting = (key: string): Promise<unknown> => invoke(CHANNELS.GET_SETTING, key)

  beforeEach(() => {
    vi.clearAllMocks()
    tmpRoot = fs.mkdtempSync(join(os.tmpdir(), 'settings-ipc-'))
    hotDir = join(tmpRoot, 'hot')
    fallbackDir = join(tmpRoot, 'downloads')
    for (const dir of [hotDir, fallbackDir]) fs.mkdirSync(dir, { recursive: true })
    setDownloadDir = vi.fn()
    hasRootBoundWork = vi.fn(() => false)
    wire()
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  // One row per denied key, each paired with the channel its refusal must name.
  // The pairing is the point of the message: a renderer that lands here learns
  // where to go from the console, which a silent `store.set` could not tell it.
  //
  // The last two rows are dot paths *under* a denied key, and they are denied
  // for the reason given at `REFUSED` in the handler: the store resolves dot
  // paths and replaces any non-object node on the way, so a write to
  // `storageMode.x` is a write to `storageMode`. One segment or three makes no
  // difference to that, which is why both depths are pinned.
  describe('refuses every root key and names the channel that owns it', () => {
    it.each([
      ['downloadDir', '/new/dl', /download:pick-dir/],
      ['hotStorageDir', '/new/hot', /storage:pick-hot-dir/],
      ['coldStorageDir', '/new/cold', /storage:clear-root/],
      ['storageMode', 'advanced', /storage:set-mode/],
      ['storageMode.x', 'advanced', /storage:set-mode/],
      ['storageMode.a.b', 'advanced', /storage:set-mode/]
    ] as const)('%s', async (key, value, owner) => {
      const before = store.get(key)

      await expect(setSetting(key, value)).rejects.toThrow(owner)

      // The refusal writes nothing — not the store, and not the manager, whose
      // cached root is what a half-applied move leaves stale.
      expect(store.get(key)).toBe(before)
      expect(setDownloadDir).not.toHaveBeenCalled()
    })

    it('names the key it refused, so the message identifies both ends', async () => {
      await expect(setSetting('storageMode', 'advanced')).rejects.toThrow(
        /set-setting refuses 'storageMode'/
      )
    })
  })

  // The behaviour-difference case, and the one that reds before the fix.
  //
  // Deliberately run with `hasRootBoundWork` left `false`: `set-setting` never
  // consults the predicate, so the split state is reachable with an empty
  // queue, and stubbing it `true` would make this look like a test of a guard
  // the handler does not touch.
  it('cannot move storageMode past the resolver, with no root-bound work at all', async () => {
    wire({ storageMode: 'simple', downloadDir: hotDir })

    // The outcome is captured rather than asserted first, so that the store
    // assertion below is the one that reds on the old code and the failure
    // message *is* the split state ("expected 'advanced' to be 'simple'")
    // rather than a bare "promise resolved instead of rejecting".
    const outcome = await setSetting('storageMode', 'advanced').then(
      () => 'resolved' as const,
      (err: unknown) => err as Error
    )

    // Before the fix the store read 'advanced' here while `setDownloadDir`
    // stayed un-called: the store in the new mode, the manager in the old one.
    expect(store.get('storageMode')).toBe('simple')
    expect(setDownloadDir).not.toHaveBeenCalled()
    expect(hasRootBoundWork).not.toHaveBeenCalled()
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toMatch(/storage:set-mode/)
  })

  // The same behaviour difference reached through a dot path, which an
  // exact-key denylist let through (review of #453:
  // https://github.com/mikkerlo/anime-downloader/pull/453#discussion_r4158357366).
  //
  // The assertion is on the *parent*, not on `storageMode.x`, because that is
  // where the damage lands: `writePath` replaces every non-object node it walks
  // through, so the string `'simple'` is overwritten by a fresh object and the
  // mode stops being a mode at all. Before the fix this read
  // `{ x: 'advanced' }` — the resolver's input turned into a shape
  // `getDownloadDir()` has no case for, with `DownloadManager` still cached on
  // the old root and no re-sync in sight.
  it('cannot clobber storageMode through a dot path under it', async () => {
    wire({ storageMode: 'simple', downloadDir: hotDir })

    const outcome = await setSetting('storageMode.x', 'advanced').then(
      () => 'resolved' as const,
      (err: unknown) => err as Error
    )

    expect(store.get('storageMode')).toBe('simple')
    expect(setDownloadDir).not.toHaveBeenCalled()
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toMatch(/storage:set-mode/)
  })

  // The denylist must not become a tax on the ~20 ordinary keys this channel
  // carries, which is the risk the issue names against any validation here.
  describe('leaves the common path alone', () => {
    it('writes an ordinary key', async () => {
      await expect(setSetting('token', 'new-token')).resolves.toBeUndefined()
      expect(store.get('token')).toBe('new-token')
    })

    it('writes a key that merely sits near the roots', async () => {
      await setSetting('autoMoveToCold', true)
      expect(store.get('autoMoveToCold')).toBe(true)
    })

    // Denying a dot path under a denied key must not become denying every dot
    // path: the lookup is on the first segment, so `syncplay.*` is ordinary.
    // This is the regression the dot-path fix could plausibly cause, and the
    // channel carries these — `syncplay.username` is written on every change
    // in the Syncplay tab.
    it('writes a dot-notation sub-key', async () => {
      await setSetting('syncplay.username', 'someone')
      expect(store.get('syncplay.username')).toBe('someone')
    })

    // The other half of "first segment", and the reason the lookup is a `Map`
    // read on `split('.')[0]` rather than a `startsWith` scan over the denied
    // keys: a key that merely begins with a denied key's *text* is a different
    // key and stays writable.
    it('writes a key whose name starts with a denied key', async () => {
      await setSetting('storageModeExtra', 'whatever')
      expect(store.get('storageModeExtra')).toBe('whatever')
      expect(store.get('storageMode')).toBe('simple')
    })
  })

  // The denylist is write-only. `StorageTab.vue` reads `storageMode` through
  // `get-setting` on every mount, so denying the read would break the tab that
  // owns the write — and docs/settings.md's "Still *read* with `get-setting`"
  // has to stay true.
  describe('denies writes only — get-setting still answers for every key', () => {
    it('reads back a denied key', async () => {
      wire({ storageMode: 'advanced', hotStorageDir: hotDir })

      expect(await getSetting('storageMode')).toBe('advanced')
      expect(await getSetting('hotStorageDir')).toBe(hotDir)
    })

    it('keeps resolving downloadDir through getDownloadDir()', async () => {
      // The pre-existing asymmetry the issue points at: the read side already
      // special-cases this key, which is how it was clear the write side had
      // simply forgotten.
      wire({ storageMode: 'advanced', downloadDir: '', hotStorageDir: hotDir })

      expect(await getSetting('downloadDir')).toBe(hotDir)
    })
  })

  it('locks the ambient `StorageRootKey` union to the runtime ROOT_KEYS list', () => {
    // The review's replacement for a runtime set-comparison. `StorageRootKey`
    // is ambient in a `.d.ts`, so there is no value to derive the denylist
    // from and nothing can import it either — this is the compile-time
    // stand-in, the same pattern `VIDEO_EXTS` / `EpisodeFileType` use in
    // `test/lib/episode-files.test.ts`. Adding a fourth member to the union
    // without adding it to `ROOT_KEYS` (or the reverse) fails
    // `npm run typecheck`, not just this assertion — and since the denylist is
    // `[...ROOT_KEYS, 'storageMode']`, a root key cannot reach the pickers'
    // guard and miss `set-setting`.
    type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const rootKeysMatchUnion: Eq<(typeof ROOT_KEYS)[number], StorageRootKey> = true
    expect(rootKeysMatchUnion).toBe(true)
    // `storageMode` sits outside that union by design — it is a mode, not a
    // path — so it is the one member of the denylist added by hand.
    expect(ROOT_KEYS).not.toContain('storageMode')
  })
})
