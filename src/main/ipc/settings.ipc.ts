import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import { ROOT_KEYS } from './storage.ipc'
import type { AppDeps } from './index'

/**
 * The keys `set-setting` refuses, derived from `ROOT_KEYS` rather than re-typed
 * (#450).
 *
 * `set-setting` writes whatever key the renderer names, which for these four is
 * a hole straight through the guard that owns them: each has a channel of its
 * own precisely because the store write is only half the operation. A bare
 * write moves the *effective* download root while `DownloadManager` keeps its
 * cached one — the split state #443 exists to remove, and `mkdirSync(…,
 * { recursive: true })` then recreates the abandoned root rather than failing,
 * so new files land where the UI never scans.
 *
 * Latent rather than live: #449 removed the last renderer caller (the
 * `autoSave('downloadDir', dir)` echo in `StorageTab.vue`). This stops the next
 * one. Spread from `ROOT_KEYS` so a fourth root key cannot be added to the
 * pickers' list and miss this one.
 */
const DENIED_KEYS = [...ROOT_KEYS, 'storageMode'] as const

/**
 * The channel that owns each refused write, named in the error so the mistake
 * is self-diagnosing from the renderer's console.
 *
 * `Record` over `DENIED_KEYS[number]` rather than a loose object: a key added
 * to `ROOT_KEYS` lands in `DENIED_KEYS` and leaves this record incomplete, so
 * `npm run typecheck` is what asks for its channel.
 */
const OWNING_CHANNEL: Readonly<Record<(typeof DENIED_KEYS)[number], string>> = {
  // Guarded by `hasRootBoundWork()` and re-synced through `getDownloadDir()`
  // rather than with the picked path (#447).
  downloadDir: 'download:pick-dir',
  // Same guard, same re-sync — `hotStorageDir` is the advanced-mode input to
  // `getDownloadDir()` (#447).
  hotStorageDir: 'storage:pick-hot-dir',
  // Denied for a *different* reason than the other two, and not the re-sync:
  // `storage:pick-cold-dir` never calls `resync()` and #449 deliberately
  // leaves it unguarded, because a cold dir is a move target and not an input
  // to `getDownloadDir()`. It is an input to `missingConfiguredRoot()`, so
  // clearing it has to go through `storage:clear-root`, which forces
  // `autoMoveToCold` off with it — a switch left disabled and still `true`
  // re-arms itself the moment a new cold dir is picked. Do not "simplify" this
  // entry away on the grounds that the picker is unguarded.
  coldStorageDir: 'storage:pick-cold-dir, or storage:clear-root to clear it',
  // Refused outright while the manager has root-bound work, then re-synced
  // (#443) — the mode is an input to `getDownloadDir()`.
  storageMode: 'storage:set-mode'
}

/**
 * Looked up by the key's **first path segment**, not by the whole key.
 *
 * The store resolves dot paths, and `writePath` replaces any non-object node it
 * walks through with a fresh object (`src/main/store/index.ts`, dot-prop
 * `setProperty` semantics). So `set('storageMode.x', 'advanced')` does not
 * write some harmless leaf beside the mode — it overwrites `storageMode`
 * itself with `{ x: 'advanced' }`, which is a write to a denied key with none
 * of the re-sync, the exact outcome this denylist exists to prevent. An
 * exact-key match let it straight through (review of #453).
 *
 * The first segment is what the write lands on, so it is what decides. It is a
 * `Map` read on that segment rather than a `startsWith` scan over the denied
 * keys because the two are not the same test: `storageModeExtra` begins with a
 * denied key's text and is a different key, which stays writable.
 */
const REFUSED: ReadonlyMap<string, string> = new Map(
  DENIED_KEYS.map((key): [string, string] => [key, OWNING_CHANNEL[key]])
)

export function register({ store, coldStorageService }: AppDeps): void {
  ipcMain.handle(CHANNELS.GET_SETTING, (_event, key: string) => {
    if (key === 'downloadDir') return coldStorageService.getDownloadDir()
    return store.get(key)
  })

  ipcMain.handle(CHANNELS.SET_SETTING, (_event, key: string, value: unknown) => {
    // Throws rather than warning, which is the plan review's call (#450): a
    // `console.warn` in main is invisible to someone working in the renderer,
    // and staying invisible is how the `autoSave('downloadDir')` echo survived
    // until #449. Throwing rejects the `invoke`, which surfaces as an
    // unhandled rejection at the `void` call sites and throws into the `await`
    // ones. Only these four keys — and the dot paths that land *on* them, see
    // `REFUSED` — ever throw, so no unrelated setting changes behaviour, and
    // the write side alone: `get-setting` still reads them all (the Storage
    // tab reads `storageMode` through it).
    const owner = REFUSED.get(key.split('.')[0])
    if (owner) throw new Error(`set-setting refuses '${key}' — use ${owner}`)
    store.set(key, value)
  })
}
