// Single source of truth for the `electron-store` keys that name a storage root
// (#454) — the runtime counterpart of the ambient `StorageRootKey` union, which
// a `.d.ts` cannot derive because it cannot import.
//
// It lives in `src/shared/` rather than in `src/main/ipc/storage.ipc.ts`, where
// #450 first hoisted it to module scope, because four sites now need the list
// and they cannot all reach that module:
//
//   - `storage:clear-root` validates its argument against it (`storage.ipc.ts`)
//   - `set-setting`'s denylist is `[...ROOT_KEYS, 'storageMode']`
//     (`settings.ipc.ts`)
//   - `missingConfiguredRoot()` walks it (`services/cold-storage/index.ts`)
//   - the Storage tab maps `missingRoot` back to its key
//     (`components/settings/StorageTab.vue`)
//
// The third is why the move happened. `cold-storage` is a service that `ipc/`
// depends on, and importing `ROOT_KEYS` from `storage.ipc.ts` would invert that
// layering — it would pull `ipcMain`, `dialog` and `BrowserWindow` into a module
// the tests construct directly through `createColdStorageService`. The fourth is
// in the renderer, which cannot see `src/main/` at all. A module neither side
// owns is the only place all four can read one list from, so **nothing with an
// `electron` import may ever land in this file**.
//
// `src/shared/shikimori.ts` and `src/shared/episode-files.ts` are the precedent
// for a runtime constant shared by main, preload and the renderer; a `.d.ts`
// beside `StorageRootKey` would emit no value.

/**
 * The storage root keys, in the order `missingConfiguredRoot()` reports them.
 *
 * **The order is load-bearing.** `missingConfiguredRoot()` answers with the
 * *first* stored root that is not on disk, and `StorageTab.vue` maps that path
 * back to a key by walking this same list — so reordering it changes which key
 * the missing-root notice offers to clear. `test/services/cold-storage.test.ts`
 * pins the two-missing-roots case that reordering would otherwise slip past.
 *
 * `as const` rather than a `readonly StorageRootKey[]` annotation: the
 * annotation would erase the literals and make the equality assertion in
 * `test/shared/storage-roots.test.ts` vacuous, since `ROOT_KEYS[number]` would
 * be `StorageRootKey` by declaration instead of by contents (#450).
 */
export const ROOT_KEYS = ['downloadDir', 'hotStorageDir', 'coldStorageDir'] as const
