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

  it('a logged-in PC carries no claim, and presents its Shikimori account (#714)', () => {
    const rec = record({ claim: { ownerId: 5, at: 1 } })
    expect(buildActor(storeWith(rec, { id: 5 }), LIB, '7.0.0')).toMatchObject({
      shikimoriUserId: 5,
      claim: null,
      trackerAccounts: [{ provider: 'shikimori', userId: '5' }]
    })
  })
})

describe('buildActor (#714): every connected account, a claim only with none', () => {
  it.each(['anilistUser', 'myanimelistUser'])(
    'only %s set, plus a leftover claim on the record: claim null',
    (key) => {
      for (const rec of [
        record({ claim: { ownerId: 5, at: 1 } }),
        record({
          owner: null,
          trackerOwner: { provider: 'anilist', userId: '5' },
          trackerClaim: { provider: 'anilist', userId: '5', at: 1 }
        })
      ]) {
        const store = storeWith(rec)
        store.set(key, { id: 5, nickname: 'x', avatar: null })
        expect(buildActor(store, LIB, '7.0.0').claim).toBeNull()
      }
    }
  )

  it('with no account: a v1 claim is { libraryId, ownerId }, a v2 trackerClaim { libraryId, provider, userId }', () => {
    const v1 = buildActor(storeWith(record({ claim: { ownerId: 5, at: 1 } })), LIB, '7.0.0')
    expect(v1.claim).toEqual({ libraryId: LIB, ownerId: 5 })
    const v2 = record({
      owner: null,
      trackerOwner: { provider: 'anilist', userId: '5' },
      trackerClaim: { provider: 'anilist', userId: '5', at: 1 }
    })
    expect(buildActor(storeWith(v2), LIB, '7.0.0').claim).toEqual({
      libraryId: LIB,
      provider: 'anilist',
      userId: '5'
    })
  })

  it('presents every connected account in tracker order; shikimoriUserId is the Shikimori one only', () => {
    const store = storeWith(record({}))
    store.set('myanimelistUser', { id: 7, nickname: 'm', avatar: null })
    store.set('anilistUser', { id: 6, nickname: 'a', avatar: null })
    expect(buildActor(store, LIB, '7.0.0')).toMatchObject({
      shikimoriUserId: null,
      trackerAccounts: [
        { provider: 'anilist', userId: '6' },
        { provider: 'mal', userId: '7' }
      ]
    })
  })
})
