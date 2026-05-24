/**
 * Integration test harness (Phase 7 PR 3, #140).
 *
 * Builds the minimum surface — in-memory storage, broadcast spy, stub HTTP
 * clients, stub download manager — needed to drive multi-service flows
 * without booting Electron. Each integration test composes only what it
 * needs from these helpers.
 *
 * This is intentionally NOT a full `App` controller reconstruction. Wiring
 * every service + router into a single fake makes the harness as complex as
 * the production it stands in for. The helpers below are small, targeted,
 * and composable — each integration test wires what it needs explicitly.
 */
import { vi } from 'vitest'
import { InMemoryStorage } from './in-memory-storage'

export type BroadcastSpy = ReturnType<typeof vi.fn>

export interface Harness {
  store: InMemoryStorage
  broadcast: BroadcastSpy
  /** Returns the list of `(channel, ...args)` calls in arrival order. */
  broadcasts(): Array<{ channel: string; args: unknown[] }>
}

/**
 * Construct a fresh `Harness` with an empty in-memory store + a broadcast spy.
 * Tests then layer in services and stubs as needed.
 */
export function makeHarness(initialStore: Record<string, unknown> = {}): Harness {
  const store = new InMemoryStorage(initialStore)
  const broadcast = vi.fn()
  function broadcasts(): Array<{ channel: string; args: unknown[] }> {
    return broadcast.mock.calls.map(([channel, ...args]) => ({
      channel: channel as string,
      args
    }))
  }
  return { store, broadcast, broadcasts }
}

/**
 * Minimal stub for `SmotretApi`. Tests override the methods they care about;
 * un-overridden methods reject with a clear `not stubbed` error so missing
 * coverage is loud.
 */
export interface SmotretApiStub {
  searchAnime: ReturnType<typeof vi.fn>
  getAnime: ReturnType<typeof vi.fn>
  getEpisode: ReturnType<typeof vi.fn>
  getEmbed: ReturnType<typeof vi.fn>
  getSubtitlesUrl: ReturnType<typeof vi.fn>
  getFallbackVideoUrl: ReturnType<typeof vi.fn>
  fetchSubtitleContent: ReturnType<typeof vi.fn>
  fetchPoster: ReturnType<typeof vi.fn>
  validateToken: ReturnType<typeof vi.fn>
  lookupByMalIds: ReturnType<typeof vi.fn>
}

function notStubbed(name: string): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    throw new Error(`SmotretApi.${name} not stubbed for this integration test`)
  })
}

export function makeSmotretApiStub(): SmotretApiStub {
  return {
    searchAnime: notStubbed('searchAnime'),
    getAnime: notStubbed('getAnime'),
    getEpisode: notStubbed('getEpisode'),
    getEmbed: notStubbed('getEmbed'),
    getSubtitlesUrl: vi.fn((id: number) => `https://stub/subs/${id}`),
    getFallbackVideoUrl: vi.fn(
      (id: number, height: number) => `https://stub/fallback/${id}/${height}`
    ),
    fetchSubtitleContent: notStubbed('fetchSubtitleContent'),
    fetchPoster: notStubbed('fetchPoster'),
    validateToken: notStubbed('validateToken'),
    lookupByMalIds: notStubbed('lookupByMalIds')
  }
}

/**
 * Minimal stub for `DownloadManager`. Covers the surface auto-downloader +
 * shikimori-sync use; expand as more integration coverage lands.
 */
export interface DownloadManagerStub {
  enqueue: ReturnType<typeof vi.fn>
  getEpisodeGroups: ReturnType<typeof vi.fn>
}

export function makeDownloadManagerStub(
  initialGroups: Array<{ animeId: number; episodeInt: string }> = []
): DownloadManagerStub {
  return {
    enqueue: vi.fn(async () => undefined),
    getEpisodeGroups: vi.fn(() => initialGroups)
  }
}

/**
 * Minimal stub of the shikimori HTTP module (`src/main/shikimori.ts`).
 * Integration tests that exercise services depending on shikimori HTTP
 * should `vi.mock('../../src/main/shikimori', ...)` and route through this.
 */
export interface ShikimoriClientStub {
  ensureFreshToken: ReturnType<typeof vi.fn>
  getUser: ReturnType<typeof vi.fn>
  getUserRate: ReturnType<typeof vi.fn>
  createUserRate: ReturnType<typeof vi.fn>
  updateUserRate: ReturnType<typeof vi.fn>
  getUserAnimeRates: ReturnType<typeof vi.fn>
  getAnimeDetails: ReturnType<typeof vi.fn>
  getFriends: ReturnType<typeof vi.fn>
  getFriendsRatesForAnime: ReturnType<typeof vi.fn>
}

export function makeShikimoriClientStub(): ShikimoriClientStub {
  return {
    ensureFreshToken: vi.fn(async () => 'access-token'),
    getUser: vi.fn(async () => ({ id: 1, nickname: 'a', avatar: '' })),
    getUserRate: vi.fn(async () => null),
    createUserRate: vi.fn(),
    updateUserRate: vi.fn(),
    getUserAnimeRates: vi.fn(async () => []),
    getAnimeDetails: vi.fn(),
    getFriends: vi.fn(async () => []),
    getFriendsRatesForAnime: vi.fn(async () => [])
  }
}
