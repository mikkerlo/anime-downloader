// The `home:get-continue-watching` and `search:local` replies on a fixed
// Shikimori profile (#698, T4b). The replies in `test/fixtures/t4b-golden/`
// were recorded against 6.12.0's code, before either reader moved to the
// primary tracker, and every later change must give the same bytes. The
// profile carries the legacy rows: no `target_id`, a null `target_id`, no
// `updated_at`, an unparseable one and the epoch.
//
// `T4B_GOLDEN_RECORD=1` rewrites the replies; only the recording commit does.
import { describe, it, expect, beforeAll, afterAll, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { register as registerHome } from '../../src/main/ipc/home.ipc'
import { register as registerAnime } from '../../src/main/ipc/anime.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createRecentWatchIndex } from '../../src/main/lib/recent-watch'
import type { AttachedSnapshot } from '../../src/main/lib/local-search'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import type { AnimeDetail } from '../../src/main/smotret-api'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { shikimoriOnlyTrackers } from '../helpers/tracker-fan-out'

const DIR = path.resolve(__dirname, '../fixtures/t4b-golden')
const RECORD = process.env.T4B_GOLDEN_RECORD === '1'

const fixture = JSON.parse(fs.readFileSync(path.join(DIR, 'store.json'), 'utf8')) as {
  now: number
  store: Record<string, unknown>
  attached: AttachedSnapshot[]
}

const SEARCHES: [string, LocalSearchFilters?][] = [
  ['saga'],
  ['saga', { status: 'watching' }],
  ['saga', { status: 'completed' }],
  ['saga', { status: 'on_hold' }],
  ['saga', { status: 'planned' }],
  ['saga', { genre: 'Drama' }],
  ['omega'],
  ['s']
]

function resolvedDetail(id: number, title: string, poster: string): AnimeDetail {
  return {
    id,
    title,
    titles: { ru: `${title} (ru)`, romaji: title },
    posterUrlSmall: poster,
    posterUrl: poster,
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV',
    year: 2025,
    season: 'fall',
    descriptions: [],
    genres: [],
    episodes: [
      { id: 1, episodeInt: '4', episodeFull: `${title} — 4`, episodeType: 'tv', isActive: 1 }
    ]
  } as unknown as AnimeDetail
}

// What smotret answers for each title continue-watching asks about.
async function getAnime(id: number): Promise<{ data: AnimeDetail | null }> {
  switch (id) {
    case 107:
      return { data: resolvedDetail(107, 'Eta Saga', '') }
    case 109:
      return { data: resolvedDetail(109, 'Theta Saga', 'https://smotret.invalid/posters/109.jpg') }
    case 114:
      return { data: null }
    case 115:
      return {
        data: resolvedDetail(115, 'Omicron Saga', 'https://smotret.invalid/posters/115-fresh.jpg')
      }
    default:
      throw new Error(`no smotret answer for ${id}`)
  }
}

type Handler = (...args: unknown[]) => unknown

function harness(): { handler: (channel: string) => Handler; getAnimeCalls: number[] } {
  const store = new InMemoryStorage(structuredClone(fixture.store))
  const getAnimeCalls: number[] = []
  const recentWatch = createRecentWatchIndex({
    readWatchProgress: () => store.get('watchProgress') as Record<string, { updatedAt: number }>,
    now: () => fixture.now
  })
  // The production reader over the Shikimori instance, as `index.ts` wires it.
  const sync = createShikimoriSyncService({
    store: store as never,
    broadcast: () => {},
    syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
    animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
    ratesRefreshedChannel: EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED
  })
  const { trackerRates } = shikimoriOnlyTrackers(store as never, sync)
  const deps = {
    store,
    primaryEntries: () => trackerRates.primaryEntries(),
    smotretApi: {
      getAnime: (id: number) => {
        getAnimeCalls.push(id)
        return getAnime(id)
      }
    },
    rememberAnimeMeta: () => {},
    recentWatch,
    attachedLibraryService: { availableSnapshots: () => structuredClone(fixture.attached) }
  } as unknown as AppDeps
  ;(ipcMain.handle as Mock).mockClear()
  registerHome(deps)
  registerAnime(deps)
  const calls = (ipcMain.handle as Mock).mock.calls as [string, Handler][]
  return {
    handler: (channel) => calls.find(([c]) => c === channel)![1],
    getAnimeCalls
  }
}

function golden(name: string, value: unknown): void {
  const file = path.join(DIR, name)
  const text = JSON.stringify(value, null, 2) + '\n'
  if (RECORD) {
    fs.writeFileSync(file, text)
    return
  }
  expect(text).toBe(fs.readFileSync(file, 'utf8'))
}

beforeAll(() => {
  vi.useFakeTimers({ now: fixture.now, toFake: ['Date'] })
})

afterAll(() => {
  vi.useRealTimers()
})

describe('T4b golden: the Shikimori replies stay byte-identical (#698)', () => {
  it('home:get-continue-watching', async () => {
    const { handler, getAnimeCalls } = harness()
    const reply = await handler(CHANNELS.HOME_GET_CONTINUE_WATCHING)({})
    golden('continue-watching.json', { reply, getAnimeCalls })
  })

  it('search:local', async () => {
    const { handler } = harness()
    const search = handler(CHANNELS.SEARCH_LOCAL)
    const replies = SEARCHES.map(([query, filters]) => ({
      query,
      filters: filters ?? null,
      reply: search({}, query, filters)
    }))
    golden('search-local.json', replies)
  })
})
