// Who writes a Shared Library (#584, #713): the claim comes from a v1 record
// only, and production actors present no tracker account.
import { describe, expect, it } from 'vitest'
import { buildActor } from '../../src/main/services/sync-runner/actor'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const LIB = '3b0e7a52-5c1f-4d8e-9a6b-2f4c8d1e7a90'

const record = (over: Partial<AttachedLibraryRecord>): AttachedLibraryRecord => ({
  root: '/drive/Lib',
  name: 'Lib',
  mode: 'metadata',
  owner: { shikimoriId: 5, nickname: 'a' },
  access: 'read-write',
  lastSeenAt: 0,
  lastSyncAt: null,
  ...over
})

const storeWith = (rec: AttachedLibraryRecord, user: { id: number } | null = null) =>
  new InMemoryStorage({ installId: 'pc', shikimoriUser: user, attachedLibraries: { [LIB]: rec } })

describe('buildActor', () => {
  it('a no-account PC carries a v1 record’s claim, and no tracker account', () => {
    const actor = buildActor(storeWith(record({ claim: { ownerId: 5, at: 1 } })), LIB, '7.0.0')
    expect(actor).toEqual({
      installId: 'pc',
      appVersion: '7.0.0',
      shikimoriUserId: null,
      claim: { libraryId: LIB, ownerId: 5 },
      trackerAccounts: []
    })
  })

  it('never builds a claim from a v2 record (owner: null, trackerOwner)', () => {
    const v2 = record({
      owner: null,
      trackerOwner: { provider: 'anilist', userId: '5' },
      claim: { ownerId: 5, at: 1 }
    })
    expect(buildActor(storeWith(v2), LIB, '7.0.0').claim).toBeNull()
  })

  it('a logged-in PC carries no claim', () => {
    const rec = record({ claim: { ownerId: 5, at: 1 } })
    expect(buildActor(storeWith(rec, { id: 5 }), LIB, '7.0.0')).toMatchObject({
      shikimoriUserId: 5,
      claim: null,
      trackerAccounts: []
    })
  })
})
