// Migration (#572 §2): lazy and lossless. A real-shaped legacy profile (before
// #572: no `sync` on any row, no `installId`, no `syncMeta`) projects every
// watch row, star, priority and rate as it is, and projecting writes nothing.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { InMemoryStorage } from '../../helpers/in-memory-storage'
import { projectSyncDoc } from '../../../src/main/lib/sync-state/project'
import { applySyncDoc } from '../../../src/main/lib/sync-state/apply'

type Profile = {
  watchProgress: Record<string, WatchProgressEntry>
  library: Record<string, AnimeSearchResult>
  priorityAnimeIds: string[]
  shikimoriUserRates: {
    rate: { target_id: number; episodes: number; status: string; score: number; rewatches: number }
    smotretAnime: { id: number }
  }[]
  dismissedContinueWatching: string[]
}

const PROFILE = JSON.parse(
  readFileSync(resolve(__dirname, '../../fixtures/sync-state/legacy-profile.json'), 'utf8')
) as Profile & Record<string, unknown>

const titleIds = [...new Set(Object.keys(PROFILE.watchProgress).map((k) => k.split(':')[0]))]
// Two thirds of the titles in scope, so out-of-scope rows are present too.
const scope = titleIds.filter((_, i) => i % 3 !== 2)

function load(): { store: InMemoryStorage; writes: string[] } {
  const store = new InMemoryStorage(structuredClone(PROFILE))
  const writes: string[] = []
  const set = store.set.bind(store)
  store.set = (key: string, value: unknown) => {
    writes.push(key)
    set(key, value)
  }
  return { store, writes }
}

describe('legacy profile → SyncDoc', () => {
  it('the fixture is real-shaped: a few hundred rows, with and without watchedAt, none with sync', () => {
    const rows = Object.values(PROFILE.watchProgress)
    expect(rows.length).toBeGreaterThan(250)
    expect(rows.some((r) => r.watched && r.watchedAt !== undefined)).toBe(true)
    expect(rows.some((r) => r.watched && r.watchedAt === undefined)).toBe(true)
    expect(rows.some((r) => r.sync !== undefined)).toBe(false)
  })

  it('projects every in-scope watch row losslessly, with legacy clocks', () => {
    const { store } = load()
    const doc = projectSyncDoc(store, scope, { resolveEpisodeFile: () => null })
    let checked = 0
    for (const [key, row] of Object.entries(PROFILE.watchProgress)) {
      const [id, ep] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
      const entry = doc.titles[id]?.watch?.[ep]
      if (!scope.includes(id)) {
        expect(entry).toBeUndefined()
        continue
      }
      checked++
      expect(entry).toEqual({
        position: {
          value: {
            position: row.position,
            duration: row.duration,
            ...(row.translationId !== undefined ? { translationId: row.translationId } : {})
          },
          at: row.updatedAt,
          origin: 'legacy'
        },
        watched: { value: !!row.watched, at: row.watchedAt ?? row.updatedAt, origin: 'legacy' },
        watchedAt: row.watchedAt ?? null
      })
    }
    expect(checked).toBeGreaterThan(150)
  })

  it('projects stars, priority, order, rates and dismissed keys as they are', () => {
    const { store } = load()
    const doc = projectSyncDoc(store, scope, { resolveEpisodeFile: () => null })
    for (const id of scope) {
      expect(!!doc.titles[id].starred).toBe(!!PROFILE.library[id])
      expect(!!doc.titles[id].priority).toBe(PROFILE.priorityAnimeIds.includes(id))
      const cached = PROFILE.shikimoriUserRates.find((r) => String(r.smotretAnime.id) === id)
      if (cached) {
        expect(doc.titles[id].rate).toMatchObject({
          malId: cached.rate.target_id,
          episodes: { value: cached.rate.episodes, origin: 'shikimori' },
          status: { value: cached.rate.status },
          score: { value: cached.rate.score },
          rewatches: { value: cached.rate.rewatches }
        })
      } else {
        expect(doc.titles[id].rate).toBeUndefined()
      }
      const dismissed = PROFILE.dismissedContinueWatching
        .filter((k) => k.startsWith(`${id}:`))
        .map((k) => k.slice(id.length + 1))
      expect(doc.titles[id].dismissed ?? []).toEqual(dismissed.sort())
    }
    expect(doc.priorityOrder.value).toEqual(
      PROFILE.priorityAnimeIds.filter((id) => scope.includes(id))
    )
    expect(doc.tombstones).toEqual({})
  })

  it('writes nothing: the store write count is 0', () => {
    const { store, writes } = load()
    projectSyncDoc(store, titleIds, { resolveEpisodeFile: () => null })
    expect(writes).toEqual([])
    expect(store.get('watchProgress')).toEqual(PROFILE.watchProgress)
  })
})

// The apply side of "lazy": S9's first merge on a pre-#572 profile applies a
// doc that, for everything unchanged, is the profile's own projection. That
// must not touch a legacy row (its `updatedAt` orders continue-watching and
// the resume pick) or stamp legacy clocks into `syncMeta`.
describe('legacy profile → SyncDoc → applySyncDoc', () => {
  it("applying the profile's own projection writes nothing", () => {
    const { store, writes } = load()
    const doc = projectSyncDoc(store, titleIds, { resolveEpisodeFile: () => null })

    const report = applySyncDoc(store, doc, titleIds, {
      now: () => Date.UTC(2030, 0, 1),
      localEpisodeFile: () => null,
      skipAlgorithm: {} as ShowSkipDetections['algorithm']
    })

    expect(writes).toEqual([])
    expect(report).toEqual({ applied: [], unapplied: [], clamped: [] })
    expect(store.get('watchProgress')).toEqual(PROFILE.watchProgress)
  })
})
