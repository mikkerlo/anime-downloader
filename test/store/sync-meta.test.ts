// `installId` and `syncMeta` (#572): the install id is written once, on the
// first boot after the upgrade, and nothing else is written at boot. Tombstones
// age out on the next `syncMeta` write, never at boot.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createStorageService } from '../../src/main/store'
import { ensureInstallId, stampRateClocks, updateSyncMeta } from '../../src/main/store/sync-meta'
import { TOMBSTONE_MAX_AGE_MS } from '../../src/main/lib/sync-state/gc'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 27)

const tombstone = (ageDays: number): SyncMembershipClock => ({
  deleted: true,
  at: NOW - ageDays * DAY,
  origin: 'install-b'
})

describe('ensureInstallId', () => {
  it('generates and persists an id when there is none, then returns it unchanged', () => {
    const store = new InMemoryStorage({ installId: '' })
    const generate = vi.fn(() => 'id-1')

    expect(ensureInstallId(store, generate)).toBe('id-1')
    expect(ensureInstallId(store, generate)).toBe('id-1')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(store.get('installId')).toBe('id-1')
  })

  it('generates a random UUID by default', () => {
    const store = new InMemoryStorage()
    expect(ensureInstallId(store)).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('boot writes', () => {
  // A real-shaped profile from before #572: the V2 migration has run, rows have
  // no `sync`, and neither new key exists yet.
  const PRE_UPGRADE = {
    watchProgressMigrationV2: true,
    watchProgress: {
      '5:1': { position: 0, duration: 1420, updatedAt: 1000, watched: true, watchedAt: 900 },
      '5:2': { position: 610, duration: 1420, updatedAt: 2000, watched: false, translationId: 7 }
    },
    library: { '5': { id: 5, title: 'Five' } },
    priorityAnimeIds: ['5'],
    shikimoriUserRates: [{ rate: { id: 1, target_id: 42, episodes: 3, status: 'watching' } }]
  }
  const DEFAULTS = {
    watchProgressMigrationV2: false,
    watchProgress: {} as Record<string, unknown>,
    library: {} as Record<string, unknown>,
    priorityAnimeIds: [] as string[],
    shikimoriUserRates: [] as unknown[],
    installId: '',
    syncMeta: { titles: {}, rates: {} } as SyncMeta
  }

  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-meta-boot-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** The store half of `bootstrap()`, in its order; returns the keys it wrote. */
  function boot(): { written: string[]; store: ReturnType<typeof createStorageService> } {
    const store = createStorageService(DEFAULTS, { cwd: dir })
    const set = vi.spyOn(store, 'set')
    store.migrateWatchProgressV2()
    store.ensureInstallId()
    store.flush()
    return { written: set.mock.calls.map(([key]) => key as string), store }
  }

  it('the first boot after the upgrade writes installId and nothing else; the next boot writes nothing', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(PRE_UPGRADE))

    const first = boot()
    expect(first.written).toEqual(['installId'])
    const id = first.store.get('installId')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.store.get('watchProgress')).toEqual(PRE_UPGRADE.watchProgress)

    const second = boot()
    expect(second.written).toEqual([])
    expect(second.store.get('installId')).toBe(id)
  })

  it('boot leaves an expired tombstone in place', () => {
    const syncMeta: SyncMeta = { titles: { '9': { starred: tombstone(400) } }, rates: {} }
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ ...PRE_UPGRADE, installId: 'install-a', syncMeta })
    )

    const { written, store } = boot()

    expect(written).toEqual([])
    expect(store.get('syncMeta')).toEqual(syncMeta)
  })
})

describe('updateSyncMeta — tombstone GC on the next write', () => {
  it('drops a 366-day-old tombstone and keeps a 364-day-old one', () => {
    const store = new InMemoryStorage({
      installId: 'install-a',
      syncMeta: {
        titles: {
          '1': { starred: tombstone(366), priority: tombstone(366) },
          '2': { starred: tombstone(364) },
          '3': { starred: { at: NOW - 400 * DAY, origin: 'install-b' }, priority: tombstone(366) }
        },
        rates: {}
      }
    })

    updateSyncMeta(store, () => {}, NOW)

    expect(store.get('syncMeta')).toEqual({
      titles: {
        '2': { starred: tombstone(364) },
        '3': { starred: { at: NOW - 400 * DAY, origin: 'install-b' } }
      },
      rates: {}
    })
  })

  it('the cut-off is a year exactly', () => {
    expect(TOMBSTONE_MAX_AGE_MS).toBe(365 * DAY)
  })

  it('keeps fields it does not know', () => {
    const store = new InMemoryStorage({
      syncMeta: { titles: {}, rates: {}, future: { x: 1 } }
    })
    updateSyncMeta(store, () => {}, NOW)
    expect(store.get('syncMeta')).toEqual({ titles: {}, rates: {}, future: { x: 1 } })
  })
})

describe('stampRateClocks — the owner', () => {
  const before = { episodes: 3, status: 'watching', score: 7, rewatches: 0 }
  const after = { ...before, episodes: 4 }

  it('defaults to the signed-in Shikimori user', () => {
    const store = new InMemoryStorage({ installId: 'install-a', shikimoriUser: { id: 7 } })
    stampRateClocks(store, 42, before, after, undefined, NOW)
    expect((store.get('syncMeta') as SyncMeta).rates).toEqual({
      '7:42': { episodes: { value: 4, at: NOW, origin: 'install-a' } }
    })
  })

  it('takes an owner the caller captured over the current user', () => {
    const store = new InMemoryStorage({ installId: 'install-a', shikimoriUser: { id: 8 } })
    stampRateClocks(store, 42, before, after, 7, NOW)
    expect(Object.keys((store.get('syncMeta') as SyncMeta).rates)).toEqual(['7:42'])
  })

  it('writes nothing with no owner, or with nothing changed', () => {
    const signedOut = new InMemoryStorage({ installId: 'install-a', shikimoriUser: null })
    stampRateClocks(signedOut, 42, before, after, undefined, NOW)
    expect(signedOut.get('syncMeta')).toBeUndefined()

    const unchanged = new InMemoryStorage({ installId: 'install-a', shikimoriUser: { id: 7 } })
    stampRateClocks(unchanged, 42, before, { ...before }, undefined, NOW)
    expect(unchanged.get('syncMeta')).toBeUndefined()
  })
})
