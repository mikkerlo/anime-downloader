// Owner comparisons across layout majors (#713): a v1 owner is matched by the
// Shikimori user, a v2 owner only by a tracker account, and a claim names a v1
// owner only.
import { describe, expect, it } from 'vitest'
import {
  isOwnedBy,
  isTrackerOwner,
  ownerOf,
  sameOwner,
  shikimoriOwnerId
} from '../../../src/main/lib/shared-library/owner'

const V1 = { shikimoriId: 5, nickname: 'a' }
const ANILIST = { provider: 'anilist', userId: '5', nickname: 'b' }
const MAL = { provider: 'mal', userId: '5' }
const V2_SHIKIMORI = { provider: 'shikimori', userId: '5' }

const shikimori = (id: number | null) => ({ shikimoriUserId: id, trackerAccounts: [] })

describe('ownerOf', () => {
  it('normalizes both majors to (provider, userId)', () => {
    expect(ownerOf(V1)).toEqual({ provider: 'shikimori', userId: '5', nickname: 'a' })
    expect(ownerOf(ANILIST)).toEqual({ provider: 'anilist', userId: '5', nickname: 'b' })
    expect(ownerOf(MAL)).toEqual({ provider: 'mal', userId: '5' })
    expect(ownerOf(null)).toBeNull()
    expect(ownerOf(undefined)).toBeNull()
  })

  it('tells the majors apart by shape, not by provider', () => {
    expect(isTrackerOwner(V1)).toBe(false)
    expect(isTrackerOwner(V2_SHIKIMORI)).toBe(true)
    expect(isTrackerOwner(null)).toBe(false)
  })
})

describe('isOwnedBy', () => {
  it('a v1 owner: the Shikimori user with that id', () => {
    expect(isOwnedBy(V1, shikimori(5))).toBe(true)
    expect(isOwnedBy(V1, shikimori(6))).toBe(false)
    expect(isOwnedBy(V1, shikimori(null))).toBe(false)
  })

  it('a v2 owner is foreign to every Shikimori user, the numerically equal one included', () => {
    for (const owner of [ANILIST, MAL, V2_SHIKIMORI]) {
      expect(isOwnedBy(owner, shikimori(5))).toBe(false)
      expect(isOwnedBy(owner, shikimori(null))).toBe(false)
    }
  })

  it('a v2 owner: only the tracker account with the same provider and userId', () => {
    const anilist5 = {
      shikimoriUserId: null,
      trackerAccounts: [{ provider: 'anilist', userId: '5' }]
    }
    expect(isOwnedBy(ANILIST, anilist5)).toBe(true)
    expect(isOwnedBy(MAL, anilist5)).toBe(false)
    expect(
      isOwnedBy(ANILIST, {
        shikimoriUserId: null,
        trackerAccounts: [{ provider: 'anilist', userId: '6' }]
      })
    ).toBe(false)
    // An unknown provider is just another provider: foreign to everyone else.
    expect(isOwnedBy({ provider: 'kitsu', userId: '5' }, anilist5)).toBe(false)
  })

  it('a tracker account never matches a v1 owner', () => {
    expect(
      isOwnedBy(V1, {
        shikimoriUserId: null,
        trackerAccounts: [{ provider: 'shikimori', userId: '5' }]
      })
    ).toBe(false)
  })

  it('no owner is nobody’s', () => {
    expect(isOwnedBy(null, shikimori(5))).toBe(false)
  })
})

describe('sameOwner and shikimoriOwnerId', () => {
  it('two v2 owners with the same userId on different providers differ', () => {
    expect(sameOwner(ANILIST, MAL)).toBe(false)
    expect(sameOwner(ANILIST, { provider: 'anilist', userId: '5' })).toBe(true)
  })

  it('a v1 owner and a v2 Shikimori owner with the same id differ: the layout is part of it', () => {
    expect(sameOwner(V1, V2_SHIKIMORI)).toBe(false)
    expect(sameOwner(V1, { shikimoriId: 5 })).toBe(true)
    expect(sameOwner(null, null)).toBe(true)
    expect(sameOwner(null, V1)).toBe(false)
  })

  it('only a v1 owner has a Shikimori id to claim', () => {
    expect(shikimoriOwnerId(V1)).toBe(5)
    expect(shikimoriOwnerId(V2_SHIKIMORI)).toBeNull()
    expect(shikimoriOwnerId(ANILIST)).toBeNull()
    expect(shikimoriOwnerId(null)).toBeNull()
  })
})
