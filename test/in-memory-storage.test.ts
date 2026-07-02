import { describe, it, expect } from 'vitest'
import { InMemoryStorage } from './helpers/in-memory-storage'

describe('InMemoryStorage', () => {
  it('returns the default value for a missing key', () => {
    const store = new InMemoryStorage()
    expect(store.get('missing', 'fallback')).toBe('fallback')
    expect(store.has('missing')).toBe(false)
  })

  it('stores, reads, and deletes typed values', () => {
    const store = new InMemoryStorage()
    store.set('token', 'abc')
    expect(store.get('token')).toBe('abc')
    expect(store.has('token')).toBe(true)

    store.delete('token')
    expect(store.has('token')).toBe(false)
  })

  it('seeds from an initial record and snapshots state', () => {
    const store = new InMemoryStorage({ a: 1, b: 2 })
    expect(store.get('a')).toBe(1)
    store.set('c', 3)
    expect(store.snapshot()).toEqual({ a: 1, b: 2, c: 3 })
    store.clear()
    expect(store.snapshot()).toEqual({})
  })

  it('resolves dot-notation sub-key reads like the real StorageService', () => {
    const store = new InMemoryStorage({ animeCache: { '42': { cachedAt: 7 } } })
    expect(store.get('animeCache.42')).toEqual({ cachedAt: 7 })
    expect(store.get('animeCache.42.cachedAt')).toBe(7)
    expect(store.get('animeCache.99')).toBeUndefined()
    expect(store.get('animeCache.99', 'fallback')).toBe('fallback')
    expect(store.get('animeCache.42.cachedAt.deeper')).toBeUndefined()
  })
})
