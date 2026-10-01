// The pin for the storage root key list (#454).
//
// `ROOT_KEYS` used to live in `src/main/ipc/storage.ipc.ts` with this assertion
// in `test/ipc/settings.ipc.test.ts`, because the denylist was the only thing
// that read it. It now feeds four sites across main, the service layer and the
// renderer, so the list moved to `src/shared/storage-roots.ts` and its pin moved
// next to it — the same arrangement `VIDEO_EXTS` has (`src/shared/episode-files.ts`
// + `test/lib/episode-files.test.ts`). `settings.ipc.test.ts` keeps only the
// `storageMode` exclusion, which is a fact about the *denylist*, not about this
// list.

import { describe, it, expect } from 'vitest'
import { ROOT_KEYS } from '../../src/shared/storage-roots'

describe('shared storage root keys (#454)', () => {
  it('locks the ambient `StorageRootKey` union to the runtime ROOT_KEYS list', () => {
    // `StorageRootKey` is ambient in a `.d.ts`, so there is no value to derive
    // the list from and nothing can import it either — this is the compile-time
    // stand-in for a runtime set-comparison, the same pattern `VIDEO_EXTS` /
    // `EpisodeFileType` use. Adding a fourth member to the union without adding
    // it to `ROOT_KEYS` (or the reverse) fails `npm run typecheck`, not just
    // this assertion.
    //
    // This is the assertion the `as const` on `ROOT_KEYS` exists for: with a
    // `readonly StorageRootKey[]` annotation instead, `ROOT_KEYS[number]` would
    // be `StorageRootKey` by declaration rather than by contents and the `Eq<>`
    // would hold no matter what the array actually held (#450).
    type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const rootKeysMatchUnion: Eq<(typeof ROOT_KEYS)[number], StorageRootKey> = true
    expect(rootKeysMatchUnion).toBe(true)
  })

  it('pins the declaration order the missing-root lookup reads', () => {
    // Not cosmetic. `missingConfiguredRoot()` answers with the *first* stored
    // root that is not on disk, walking this array, and `StorageTab.vue` maps
    // that path back to a key by walking it again — so a reorder here silently
    // changes which key the missing-root notice offers to clear.
    // `test/services/cold-storage.test.ts` covers the behavioural half with a
    // two-missing-roots case; this is the cheap value pin that names the order.
    expect([...ROOT_KEYS]).toEqual(['downloadDir', 'hotStorageDir', 'coldStorageDir'])
  })
})
