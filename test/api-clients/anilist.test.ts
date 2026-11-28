// AniList's client and provider (#703) against the fixtures under
// `test/fixtures/anilist/`: every query and mutation, the session's pinning,
// the cache-first `getAiringInfo`, and `mediaId` on `tracker:get-rate`. The
// fixtures are built from AniList's documented response shapes and the
// epic's live probe; `invalid-token-400` has the revoked-token shape #734's
// real-account check observed (2026-11-27), and #740's rows replay it.
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import {
  ALICE,
  anilistFixture,
  createAniListServer,
  createAniListWorld,
  createTestAniList,
  variableTypeError,
  type AniListServer,
  type AniListWorld
} from '../helpers/anilist-server'
import * as Q from '../../src/main/trackers/anilist/queries'
import {
  ENTRY_SELECTION,
  MEDIA_LIST,
  SAVE_MEDIA_LIST_ENTRY
} from '../../src/main/trackers/anilist/queries'
import { classifyAnilistError } from '../../src/main/trackers/anilist/classify'
import { AniListApiError, AniListSessionError } from '../../src/main/trackers/anilist/errors'
import { ANILIST_AUTHORIZE_URL } from '../../src/main/trackers/anilist/client'
import { jwtExpiry, type AniListListEntry } from '../../src/main/trackers/anilist/provider'
import { nextWatchedRate, type RateValues } from '../../src/main/lib/shikimori-rate'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import { createAniListSyncService } from '../../src/main/trackers/anilist/sync'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import type { AppDeps } from '../../src/main/ipc/index'

let server: AniListServer | null = null
afterEach(() => {
  server?.restore()
  server = null
})

const SESSION = { token: 'tok-alice', userId: ALICE.id }

function serve(route: Parameters<typeof createAniListServer>[0]): AniListServer {
  server = createAniListServer(route)
  return server
}

function serveWorld(opts: Parameters<typeof createAniListWorld>[0]): AniListWorld {
  const world = createAniListWorld(opts)
  server = world.server
  return world
}

/** A base64url JWT with the given payload (unsigned: only the payload is read). */
const jwt = (payload: object): string =>
  ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join(
    '.'
  )

describe('Viewer: the sign-in check', () => {
  it('stores nothing itself and returns the account with its score format, adult option and token expiry', async () => {
    const s = serve(() => ({ body: anilistFixture('viewer') }))
    const { provider, store } = await createTestAniList({ user: null, token: null })
    const token = jwt({ exp: 1_795_000_000, sub: '5001' })
    expect(provider.authFlow!.paste).toBe('token')
    expect(provider.authFlow!.begin()).toEqual({ authorizeUrl: ANILIST_AUTHORIZE_URL })
    expect(ANILIST_AUTHORIZE_URL).toBe(
      'https://anilist.co/api/v2/oauth/authorize?client_id=57991&response_type=token'
    )
    const out = await provider.authFlow!.exchange(token, null)
    expect(out).toEqual({
      credentials: { accessToken: token, expiresAt: 1_795_000_000_000 },
      user: {
        id: 5001,
        nickname: 'alice',
        avatar: 'https://s4.anilist.co/file/anilistcdn/user/avatar/medium/b5001.png',
        scoreFormat: 'POINT_100',
        displayAdultContent: false,
        tokenExpiresAt: 1_795_000_000_000
      }
    })
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatchObject({ operation: 'Viewer', token })
    expect(store.get('anilistUser')).toBeNull()
    expect(store.get('anilistCredentials')).toBeNull()
  })

  it('a token whose payload does not decode is still accepted, with no expiry', async () => {
    serve(() => ({ body: anilistFixture('viewer') }))
    const { provider } = await createTestAniList({ user: null, token: null })
    const out = await provider.authFlow!.exchange('not-a-jwt', null)
    expect(out.credentials).toEqual({ accessToken: 'not-a-jwt', expiresAt: null })
    expect(jwtExpiry('a.%%%.b')).toBeNull()
    expect(jwtExpiry(jwt({ sub: 1 }))).toBeNull()
  })
})

describe('MediaListCollection: the list read', () => {
  async function listed() {
    const chunks = [
      anilistFixture('media-list-collection-1'),
      anilistFixture('media-list-collection-2')
    ]
    const s = serve((call) => ({ body: chunks[(call.variables.chunk as number) - 1] }))
    const log = { log: vi.fn(), warn: vi.fn() }
    const t = await createTestAniList({
      provider: {
        log,
        lookupByMalIds: async (ids) =>
          Object.fromEntries(ids.map((id) => [id, { id: id * 100 } as never]))
      }
    })
    const entries = await t.provider.listEntries(SESSION)
    return { s, t, entries, log, chunks }
  }

  it('follows hasNextChunk, 500 per chunk, with the session’s user and token', async () => {
    const { s } = await listed()
    expect(s.calls.map((c) => [c.operation, c.variables, c.token])).toEqual([
      ['MediaListCollection', { userId: 5001, chunk: 1, perChunk: 500 }, 'tok-alice'],
      ['MediaListCollection', { userId: 5001, chunk: 2, perChunk: 500 }, 'tok-alice']
    ])
    expect(s.calls[0].query).toContain('forceSingleCompletedList: true')
    expect(s.calls[0].query).toContain('score(format: POINT_100)')
    expect(s.calls[0].query).not.toContain('isAdult')
  })

  it('skips custom lists, dedupes by mediaId, leaves out no-idMal entries and keeps the lowest media id of a shared idMal', async () => {
    const { entries, log } = await listed()
    expect(entries.map((e) => [e.malId, e.native.mediaId])).toEqual([
      [1, 101],
      [3, 103],
      [2, 102],
      [4, 104],
      [6, 206]
    ])
    expect(log.log).toHaveBeenCalledWith(
      '[anilist] list refresh: 5 entries; left out 1 with no MAL id and 1 sharing a MAL id'
    )
  })

  it('normalizes: POINT_100 scores, remoteId the entry id, updatedAt in ms, English title else romaji, an absolute poster', async () => {
    const { entries } = await listed()
    const [one, three, two] = entries
    expect(one).toMatchObject({
      trackerId: 'anilist',
      malId: 1,
      remoteId: 9001,
      values: { episodes: 7, status: 'watching', score: 9, rewatches: 0 },
      updatedAt: 1_764_000_000_000,
      anime: {
        title: 'Demon Slayer',
        poster: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101.jpg',
        // #707: `large` is the biggest cover the queries ask for.
        posterOriginal: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101.jpg',
        kind: 'TV',
        episodes: 26,
        episodesAired: 26,
        status: 'FINISHED'
      },
      smotretAnime: { id: 100 }
    })
    expect(three.values).toEqual({ episodes: 4, status: 'rewatching', score: 9, rewatches: 2 })
    expect(three.anime).toMatchObject({ episodes: null, episodesAired: 1100 })
    expect(two.anime.title).toBe('Romaji Only')
  })

  it('native is the MediaList row as read, deep-equal', async () => {
    const { entries, chunks } = await listed()
    const rows = chunks.flatMap(
      (c) =>
        (c as { data: { MediaListCollection: { lists: { entries: AniListListEntry[] }[] } } }).data
          .MediaListCollection.lists[0].entries
    )
    expect(entries[0].native).toEqual(rows.find((r) => r.id === 9001))
    expect(entries[3].native).toEqual(rows.find((r) => r.id === 9004))
  })

  it('seeds the id map from the list, the chosen entry of a shared idMal included', async () => {
    const { t } = await listed()
    expect(t.provider.idMap.known(1)).toBe(101)
    expect(t.provider.idMap.known(6)).toBe(206)
    expect(t.provider.idMap.known(9)).toBeUndefined()
  })

  it('a status filter maps to AniList’s status', async () => {
    const s = serve(() => ({ body: anilistFixture('media-list-collection-2') }))
    const { provider } = await createTestAniList()
    await provider.listEntries(SESSION, { status: 'planned' })
    expect(s.calls[0].variables.status).toBe('PLANNING')
  })
})

describe('MediaList: getEntry', () => {
  it('found: the entry, read on POINT_100, under the session’s user', async () => {
    const s = serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { body: anilistFixture('media-list') }
    )
    const { provider } = await createTestAniList()
    const entry = await provider.getEntry(SESSION, { malId: 1, remoteId: null })
    expect(entry).toEqual({
      trackerId: 'anilist',
      malId: 1,
      remoteId: 9001,
      values: { episodes: 7, status: 'watching', score: 9, rewatches: 0 },
      native: anilistFixture<{ data: { MediaList: unknown } }>('media-list').data.MediaList
    })
    const list = s.of('MediaList')[0]
    expect(list.variables).toEqual({ userId: 5001, mediaId: 101 })
    expect(list.query).toBe(MEDIA_LIST)
    expect(MEDIA_LIST).toContain(ENTRY_SELECTION)
    // The id lookup sends no token.
    expect(s.of('IdMap')[0].token).toBeNull()
  })

  it('not found (errors[].status 404): null, so the drain takes its create branch', async () => {
    serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { status: 404, body: anilistFixture('not-found-404') }
    )
    const { provider } = await createTestAniList()
    expect(await provider.getEntry(SESSION, { malId: 1, remoteId: null })).toBeNull()
  })

  it('a refused token is the session-gone error, with the refusal as its cause; so is the dead-token rejection after it (#740)', async () => {
    serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { status: 400, body: anilistFixture('invalid-token-400') }
    )
    const { provider } = await createTestAniList()
    const first = await provider.getEntry(SESSION, { malId: 1, remoteId: null }).catch((e) => e)
    expect(first).toBeInstanceOf(AniListSessionError)
    expect(provider.isSessionGone(first)).toBe(true)
    expect(first.cause).toBeInstanceOf(AniListApiError)
    expect(first.cause).toMatchObject({ status: 400, errorStatus: 400 })
    // The limiter now refuses the token without sending: a raw 401 underneath.
    const second = await provider.getEntry(SESSION, { malId: 1, remoteId: null }).catch((e) => e)
    expect(second).toBeInstanceOf(AniListSessionError)
    expect(second.cause).toMatchObject({ status: 401, body: '' })
    expect(server!.of('MediaList')).toHaveLength(1)
  })
})

describe('SaveMediaListEntry: upsertEntry', () => {
  const values: RateValues = { episodes: 8, status: 'watching', score: 8, rewatches: 0 }

  it('sends only the changed fields, and returns the entry with getEntry’s selection', async () => {
    const s = serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { body: anilistFixture('save-media-list-entry') }
    )
    const { provider } = await createTestAniList()
    const out = await provider.upsertEntry(SESSION, { malId: 1, remoteId: 9001 }, values, [
      'episodes'
    ])
    const save = s.of('SaveMediaListEntry')[0]
    expect(save.variables).toEqual({ mediaId: 101, progress: 8 })
    expect(save.token).toBe('tok-alice')
    expect(save.query).toBe(SAVE_MEDIA_LIST_ENTRY)
    expect(SAVE_MEDIA_LIST_ENTRY).toContain(
      'SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, scoreRaw: $scoreRaw, repeat: $repeat) { id status score(format: POINT_100) progress repeat updatedAt }'
    )
    // What the drain adopts: the stored POINT_100 score and the list-entry id.
    expect(out).toMatchObject({ remoteId: 9101, values: { episodes: 8, score: 8 } })
    expect(out.native).toEqual(
      anilistFixture<{ data: { SaveMediaListEntry: unknown } }>('save-media-list-entry').data
        .SaveMediaListEntry
    )
  })

  it('maps each field: status, progress, scoreRaw = appScore × 10, repeat', async () => {
    const s = serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { body: anilistFixture('save-media-list-entry') }
    )
    const { provider } = await createTestAniList()
    await provider.upsertEntry(
      SESSION,
      { malId: 1, remoteId: null },
      { episodes: 3, status: 'on_hold', score: 7, rewatches: 2 },
      ['episodes', 'status', 'score', 'rewatches']
    )
    expect(s.of('SaveMediaListEntry')[0].variables).toEqual({
      mediaId: 101,
      status: 'PAUSED',
      progress: 3,
      scoreRaw: 70,
      repeat: 2
    })
    expect(s.of('SaveMediaListEntry')[0].variables).not.toHaveProperty('score')
  })

  it('with nothing changed it writes nothing and reads the entry back', async () => {
    const s = serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { body: anilistFixture('media-list') }
    )
    const { provider } = await createTestAniList()
    const out = await provider.upsertEntry(SESSION, { malId: 1, remoteId: 9001 }, values, [])
    expect(s.of('SaveMediaListEntry')).toHaveLength(0)
    expect(out.remoteId).toBe(9001)
  })

  it('a 404 on SaveMediaListEntry is still item', async () => {
    serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { status: 404, body: { errors: [{ message: 'Not Found.', status: 404 }], data: null } }
    )
    const { provider } = await createTestAniList()
    const err = await provider
      .upsertEntry(SESSION, { malId: 1, remoteId: 9001 }, values, ['episodes'])
      .catch((e) => e)
    expect(err).toBeInstanceOf(AniListApiError)
    expect(classifyAnilistError(err)).toBe('item')
  })
})

describe('the rewatch round trip (§ 5)', () => {
  // The list fixture's REPEATING entry (repeat 2) and COMPLETED entry (repeat 1).
  async function roundTrip(shift: number) {
    const world = serveWorld({
      entries: [
        {
          id: 9003,
          mediaId: 103,
          idMal: 3,
          status: 'REPEATING',
          score: 90,
          progress: 4,
          repeat: 2,
          updatedAt: 1
        },
        {
          id: 9002,
          mediaId: 102,
          idMal: 2,
          status: 'COMPLETED',
          score: 70,
          progress: 12,
          repeat: 1,
          updatedAt: 1
        }
      ]
    })
    const { provider } = await createTestAniList({ provider: { repeatShift: shift } })
    const [a, b] = await provider.listEntries(SESSION)
    return { world, provider, repeating: a.malId === 3 ? a : b, completed: a.malId === 3 ? b : a }
  }

  for (const shift of [0, 1]) {
    it(`shift ${shift}: writing the normalized values back unchanged sends the fixture’s native repeat`, async () => {
      const { world, provider, repeating, completed } = await roundTrip(shift)
      expect(repeating.values.rewatches).toBe(2 + shift)
      expect(completed.values.rewatches).toBe(1)
      await provider.upsertEntry(SESSION, { malId: 3, remoteId: 9003 }, repeating.values, [
        'rewatches'
      ])
      await provider.upsertEntry(SESSION, { malId: 2, remoteId: 9002 }, completed.values, [
        'rewatches'
      ])
      expect(world.saves().map((v) => v.repeat)).toEqual([2, 1])
    })

    it(`shift ${shift}: a completed title that starts a rewatch, and a repeating one moved to COMPLETED`, async () => {
      const { world, provider, repeating, completed } = await roundTrip(shift)
      const rewatch = nextWatchedRate(completed.values, 1)!
      expect(rewatch).toMatchObject({ status: 'rewatching', rewatches: 2 })
      await provider.upsertEntry(SESSION, { malId: 2, remoteId: 9002 }, rewatch, [
        'status',
        'episodes',
        'rewatches'
      ])
      const done = { ...repeating.values, status: 'completed' as const }
      await provider.upsertEntry(SESSION, { malId: 3, remoteId: 9003 }, done, ['status'])
      // Count-at-start (shift 0): the app's count is AniList's. Count-at-completion
      // (shift 1): one less while REPEATING, and the status change carries it.
      expect(world.saves()[0].repeat).toBe(2 - shift)
      expect(world.saves()[1].repeat).toBe(shift === 0 ? undefined : 3)
    })
  }
})

describe('DeleteMediaListEntry', () => {
  it('deletes by the list-entry id, not the media id', async () => {
    const s = serve(() => ({ body: anilistFixture('delete-media-list-entry') }))
    const { provider } = await createTestAniList()
    await provider.deleteEntry!(SESSION, { malId: 1, remoteId: 9001 })
    expect(s.calls.map((c) => [c.operation, c.variables, c.token])).toEqual([
      ['DeleteMediaListEntry', { id: 9001 }, 'tok-alice']
    ])
  })

  it('a 404 means already gone: success', async () => {
    serve(() => ({ status: 404, body: anilistFixture('not-found-404') }))
    const { provider } = await createTestAniList()
    await expect(
      provider.deleteEntry!(SESSION, { malId: 1, remoteId: 9001 })
    ).resolves.toBeUndefined()
  })
})

// Live AniList validates argument nullability before running a document
// (#712's real-account check: `Following($userId: Int)` was a 400).
describe('variable types', () => {
  it('every document binds a non-null argument to a non-null variable', () => {
    const docs = Object.entries(Q).filter(
      (e): e is [string, string] =>
        typeof e[1] === 'string' && /^\s*(?:query|mutation)\s/.test(e[1])
    )
    expect(docs.map(([name]) => name)).toContain('FOLLOWING')
    for (const [name, doc] of docs) expect(variableTypeError(doc), name).toBeNull()
  })

  it('the fixture server answers a misused non-null argument with live AniList’s 400', async () => {
    const bad = 'query F($userId: Int) { Page { following(userId: $userId) { id } } }'
    expect(variableTypeError(bad)).toBe(
      'Variable "$userId" of type "Int" used in position expecting type "Int!".'
    )
    expect(variableTypeError('query F { Page { following { id } } }')).toMatch(/is required/)
    expect(
      variableTypeError('query F($userId: Int!) { Page { following(userId: $userId) { id } } }')
    ).toBeNull()
    const s = serve(() => ({ body: { data: {} } }))
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      body: JSON.stringify({ query: bad, variables: { userId: 1 } })
    })
    expect(res.status).toBe(400)
    expect(s.calls).toHaveLength(1)
  })
})

describe('capabilities', () => {
  it('Page.media(idMal_in): results out of order are matched on idMal, an adult title maps, nothing filters isAdult', async () => {
    const s = serve(() => ({ body: anilistFixture('page-media-idmal') }))
    const { provider } = await createTestAniList()
    const map = await provider.idMap.resolve([1, 3, 8, 77], { priority: 'interactive' })
    expect(Object.fromEntries(map)).toEqual({ 1: 101, 3: 103, 8: 901, 77: null })
    expect(s.calls[0].variables).toEqual({ ids: [1, 3, 8, 77] })
    expect(JSON.stringify(s.calls[0])).not.toMatch(/isAdult/)
  })

  it('getCalendar: Page.media(id_in), matched on id, adult titles filtered by displayAdultContent', async () => {
    const s = serve(() => ({ body: anilistFixture('calendar') }))
    const { provider, store } = await createTestAniList()
    const out = (await provider.getCalendar({ ids: [103, 207, 950] })) as { id: number }[]
    expect(out.map((m) => m.id)).toEqual([207, 103])
    expect(s.calls[0]).toMatchObject({ operation: 'Calendar', variables: { ids: [103, 207, 950] } })
    store.set('anilistUser', { ...ALICE, displayAdultContent: true })
    const all = (await provider.getCalendar({ ids: [103, 207, 950] })) as { id: number }[]
    expect(all.map((m) => m.id)).toEqual([207, 103, 950])
  })

  it('getRelated: Media.relations with MANGA edges dropped', async () => {
    serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { body: anilistFixture('relations') }
    )
    const { provider } = await createTestAniList()
    const edges = (await provider.getRelated({ malId: 1, remoteId: null })) as {
      relationType: string
      node: { id: number }
    }[]
    expect(edges.map((e) => [e.relationType, e.node.id])).toEqual([['SEQUEL', 111]])
  })

  it('getRelatedBatch: two ids out of order, matched on id, MANGA dropped, a node with no idMal kept raw', async () => {
    const s = serve(() => ({ body: anilistFixture('related-batch') }))
    const { provider } = await createTestAniList()
    const out = await provider.getRelatedBatch([101, 111], { priority: 'reconcile' })
    expect([...out.keys()].sort()).toEqual([101, 111])
    expect(out.get(111)!.relations.edges.map((e) => e.node.id)).toEqual([101, 777])
    expect(out.get(111)!.relations.edges[1].node).toMatchObject({ id: 777, idMal: null })
    expect(out.get(101)!.relations.edges.map((e) => e.node.id)).toEqual([111])
    expect(s.calls[0]).toMatchObject({ operation: 'RelatedBatch', variables: { ids: [101, 111] } })
  })

  it('getRecommendations: Media.recommendations, adult ones filtered by displayAdultContent', async () => {
    serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { body: anilistFixture('recommendations') }
    )
    const { provider } = await createTestAniList()
    const out = (await provider.getRecommendations([1])) as {
      seedMalId: number
      recommendations: { mediaRecommendation: { id: number } }[]
    }[]
    expect(out).toHaveLength(1)
    expect(out[0].seedMalId).toBe(1)
    expect(out[0].recommendations.map((n) => n.mediaRecommendation.id)).toEqual([301])
  })

  it('getFriendsRates: Page.mediaList(mediaId, isFollowing) with the AniList id and the session’s token', async () => {
    const s = serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { body: anilistFixture('friends-rates') }
    )
    const { provider } = await createTestAniList()
    const out = (await provider.getFriendsRates(SESSION, 1)) as { score: number }[]
    expect(out).toHaveLength(2)
    // POINT_100 as read; a 0 is unscored.
    expect(out.map((r) => r.score)).toEqual([85, 0])
    const call = s.of('FriendsRates')[0]
    expect(call.variables).toEqual({ mediaId: 101, page: 1 })
    expect(call.token).toBe('tok-alice')
    expect(call.query).toContain('mediaList(mediaId: $mediaId, isFollowing: true)')
    expect(call.query).toContain('score(format: POINT_100)')
    // One page of 50 (#712), though the fixture says there is another.
    expect(s.of('FriendsRates')).toHaveLength(1)
  })

  it('getFriendsRates for a title AniList doesn’t have: no request at all', async () => {
    const s = serve(() => ({ body: anilistFixture('friends-rates') }))
    const { provider } = await createTestAniList({
      seed: { anilistIdMap: { '1': { anilistId: null, at: Date.now() } } }
    })
    expect(await provider.getFriendsRates(SESSION, 1)).toEqual([])
    expect(s.calls).toEqual([])
  })

  it('getFriendsActivity: Page.activities(isFollowing, type_in: [ANIME_LIST]), one page, adult media filtered', async () => {
    const s = serve(() => ({ body: anilistFixture('activities') }))
    const { provider } = await createTestAniList()
    const out = (await provider.getFriendsActivity(SESSION)) as {
      id: number
      progress: string | null
    }[]
    expect(out.map((a) => a.id)).toEqual([7001, 7003])
    // `progress` is a string, a range kept as given.
    expect(out[1].progress).toBe('1 - 3')
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].variables).toEqual({ page: 1 })
    expect(s.calls[0].query).toContain('activities(isFollowing: true, type_in: [ANIME_LIST]')
    expect(s.calls[0].query).toContain('perPage: 50')
    expect(s.calls[0].token).toBe('tok-alice')
  })

  it('getFriends: Page.following(userId) over two pages, meanScore 0–100 normalized to 0–10', async () => {
    const s = serve((call) =>
      call.variables.page === 1
        ? { body: anilistFixture('following-1') }
        : { body: anilistFixture('following-2') }
    )
    const { provider } = await createTestAniList()
    const out = await provider.getFriends(SESSION)
    expect(out).toEqual([
      {
        id: 6001,
        nickname: 'bob',
        avatar: 'https://s4.anilist.co/file/anilistcdn/user/avatar/medium/b6001.png',
        titles: 312,
        mean: 7.84
      },
      { id: 6002, nickname: 'carol', avatar: '', titles: 0, mean: 0 },
      { id: 6003, nickname: 'dave', avatar: '', titles: 45, mean: 8.5 }
    ])
    expect(s.of('Following').map((c) => c.variables)).toEqual([
      { userId: ALICE.id, page: 1 },
      { userId: ALICE.id, page: 2 }
    ])
    expect(s.calls[0].token).toBe('tok-alice')
    expect(s.calls[0].query).toContain('following(userId: $userId')
    expect(s.calls[0].query).toContain('statistics { anime { count meanScore } }')
  })

  it('getFriends stops at 4 pages of 50 when a fifth is there, and logs the truncation', async () => {
    const page = (n: number) => ({
      data: {
        Page: {
          pageInfo: { hasNextPage: true },
          following: [{ id: 9000 + n, name: `u${n}`, avatar: null, statistics: null }]
        }
      }
    })
    const s = serve((call) => ({ body: page(call.variables.page as number) }))
    const warn = vi.fn()
    const { provider } = await createTestAniList({ provider: { log: { log: () => {}, warn } } })
    const out = await provider.getFriends(SESSION)
    expect(out.map((u) => u.id)).toEqual([9001, 9002, 9003, 9004])
    expect(s.of('Following')).toHaveLength(4)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/following: more than 200/)
  })

  it('the friends reads check `errors` on a 200', async () => {
    serve((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { status: 200, body: anilistFixture('error-on-200') }
    )
    const { provider } = await createTestAniList()
    for (const read of [
      () => provider.getFriends(SESSION),
      () => provider.getFriendsActivity(SESSION),
      () => provider.getFriendsRates(SESSION, 1)
    ]) {
      const err = await read().catch((e) => e)
      expect(err).toBeInstanceOf(AniListApiError)
      expect(err).toMatchObject({ status: 200, errorStatus: 500 })
    }
  })

  it('a 200 carrying errors rejects', async () => {
    serve(() => ({ status: 200, body: anilistFixture('error-on-200') }))
    const { provider } = await createTestAniList()
    const err = await provider.getCalendar({ ids: [1] }).catch((e) => e)
    expect(err).toBeInstanceOf(AniListApiError)
    expect(err).toMatchObject({ status: 200, errorStatus: 500 })
    expect(classifyAnilistError(err)).toBe('server')
  })
})

describe('the details prefetch and getDetails', () => {
  it('batches the list titles’ details by 50 at prefetch and stores them; never a title off the list', async () => {
    const s = serve(() => ({ body: anilistFixture('details') }))
    const rows = [1, 3].map((mal) => ({
      entry: {
        id: mal,
        mediaId: 100 + mal,
        status: 'CURRENT',
        score: 0,
        progress: 0,
        repeat: 0,
        updatedAt: 1,
        media: { id: 100 + mal, idMal: mal }
      },
      smotretAnime: null
    }))
    const { provider, store } = await createTestAniList({ seed: { anilistUserRates: rows } })
    await provider.prefetchDetails()
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatchObject({
      operation: 'Details',
      variables: { ids: [1, 3] },
      token: null
    })
    const details = store.get('anilistAnimeDetails') as Record<
      string,
      { description: string; genres: string[] }
    >
    expect(Object.keys(details).sort()).toEqual(['1', '3'])
    expect(details['3']).toMatchObject({
      description: 'Gol D. Roger was known as the Pirate King.',
      genres: ['Action', 'Adventure', 'Comedy'],
      episodesAired: 1100
    })
    expect(await provider.getDetails(1)).toMatchObject({ genres: ['Action', 'Supernatural'] })
    expect(s.calls).toHaveLength(1)
  })

  it('returns early while offline', async () => {
    const s = serve(() => ({ body: anilistFixture('details') }))
    const { provider } = await createTestAniList({
      seed: {
        anilistUserRates: [
          { entry: { id: 1, mediaId: 101, media: { id: 101, idMal: 1 } }, smotretAnime: null }
        ]
      },
      provider: { isOffline: () => true }
    })
    await provider.prefetchDetails()
    expect(s.calls).toHaveLength(0)
  })
})

describe('getAiringInfo is cache-first', () => {
  const row = {
    entry: {
      id: 9003,
      mediaId: 103,
      status: 'CURRENT',
      score: 0,
      progress: 0,
      repeat: 0,
      updatedAt: 1,
      media: {
        id: 103,
        idMal: 3,
        episodes: null,
        status: 'RELEASING',
        nextAiringEpisode: { episode: 13 }
      }
    },
    smotretAnime: null
  }

  it('an on-list title with a list cache younger than 6 h answers from it, with no request', async () => {
    const s = serve(() => ({ body: anilistFixture('airing') }))
    const { provider } = await createTestAniList({ seed: { anilistUserRates: [row] } })
    provider.markRatesFetched()
    expect(await provider.getAiringInfo(3)).toEqual({ episodesAired: 12, episodes: null })
    expect(s.calls).toHaveLength(0)
  })

  it('a list cache older than 6 h (or never refreshed) with no fresh details makes one request', async () => {
    const now = { t: 1_000_000_000_000 }
    const s = serve(() => ({
      body: {
        data: {
          Page: {
            media: [
              {
                id: 103,
                idMal: 3,
                episodes: null,
                status: 'RELEASING',
                nextAiringEpisode: { episode: 14 }
              }
            ]
          }
        }
      }
    }))
    const { provider } = await createTestAniList({
      seed: { anilistUserRates: [row] },
      provider: { now: () => now.t }
    })
    expect(await provider.getAiringInfo(3)).toEqual({ episodesAired: 13, episodes: null })
    expect(s.calls).toHaveLength(1)
    provider.markRatesFetched()
    now.t += 6 * 60 * 60 * 1000 + 1
    await provider.getAiringInfo(3)
    expect(s.calls).toHaveLength(2)
    expect(s.calls[1]).toMatchObject({ operation: 'Airing', variables: { ids: [3] }, token: null })
  })

  it('an off-list title makes one request', async () => {
    const s = serve(() => ({ body: anilistFixture('airing') }))
    const { provider } = await createTestAniList({ seed: { anilistUserRates: [row] } })
    provider.markRatesFetched()
    expect(await provider.getAiringInfo(40)).toEqual({ episodesAired: 7, episodes: null })
    expect(s.calls).toHaveLength(1)
  })

  it('aired: next − 1, else a FINISHED title’s total, else 0; an unmapped title is null', async () => {
    serve(() => ({
      body: {
        data: {
          Page: {
            media: [
              { id: 1, idMal: 91, episodes: 24, status: 'FINISHED', nextAiringEpisode: null },
              {
                id: 2,
                idMal: 92,
                episodes: 12,
                status: 'NOT_YET_RELEASED',
                nextAiringEpisode: null
              }
            ]
          }
        }
      }
    }))
    const { provider } = await createTestAniList()
    expect(await provider.getAiringInfo(91)).toEqual({ episodesAired: 24, episodes: 24 })
    expect(await provider.getAiringInfo(92)).toEqual({ episodesAired: 0, episodes: 12 })
    expect(await provider.getAiringInfo(93)).toBeNull()
  })
})

describe('the session', () => {
  it('auth() reads anilistUser before its first await: a switch to B during the vault read still yields A', async () => {
    let release!: () => void
    const t = await createTestAniList()
    const realRead = t.vault.read.bind(t.vault)
    const held = {
      read: vi.fn(async (key: never) => {
        await new Promise<void>((r) => (release = r))
        return realRead(key)
      }),
      commit: t.vault.commit.bind(t.vault)
    }
    const { createAniListProvider } = await import('../../src/main/trackers/anilist/provider')
    const provider = createAniListProvider({
      store: t.store as never,
      vault: held as never,
      limiter: t.limiter
    })
    const pending = provider.auth()
    t.store.set('anilistUser', { ...ALICE, id: 6002, nickname: 'bob' })
    release()
    expect(await pending).toEqual({ token: 'tok-alice', userId: 5001 })
  })

  it('a null user throws Not logged in to AniList; a cleared credential is the session-gone error', async () => {
    const t = await createTestAniList({ user: null })
    await expect(t.provider.auth()).rejects.toThrow('Not logged in to AniList')
    const u = await createTestAniList({ token: null })
    const err = await u.provider.auth().catch((e) => e)
    expect(u.provider.isSessionGone(err)).toBe(true)
    expect(classifyAnilistError(err)).toBe('auth')
  })

  it('the session is pinned: after a switch to B, A’s session still sends A’s token and user id', async () => {
    const s = serve((call) => {
      if (call.operation === 'IdMap')
        return { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
      if (call.operation === 'MediaList') return { body: anilistFixture('media-list') }
      return { body: anilistFixture('save-media-list-entry') }
    })
    const t = await createTestAniList()
    const sessionA = await t.provider.auth()
    t.store.set('anilistUser', { ...ALICE, id: 6002, nickname: 'bob' })
    await t.vault.write('anilistCredentials', { accessToken: 'tok-bob', expiresAt: null })
    await t.provider.getEntry(sessionA, { malId: 1, remoteId: null })
    await t.provider.upsertEntry(
      sessionA,
      { malId: 1, remoteId: 9001 },
      { episodes: 8, status: 'watching', score: 9, rewatches: 0 },
      ['episodes']
    )
    expect(s.of('MediaList')[0]).toMatchObject({ token: 'tok-alice', variables: { userId: 5001 } })
    expect(s.of('SaveMediaListEntry')[0].token).toBe('tok-alice')
  })
})

describe('tracker:get-rate carries AniList’s mediaId (§ 5)', () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>
  let world: AniListWorld

  beforeEach(async () => {
    world = serveWorld({
      entries: [
        {
          id: 9001,
          mediaId: 101,
          idMal: 1,
          status: 'CURRENT',
          score: 85,
          progress: 7,
          repeat: 0,
          updatedAt: 1
        }
      ],
      media: { 2: [] }
    })
    const t = await createTestAniList()
    const sync = createAniListSyncService(t.provider, {
      store: t.store as never,
      broadcast: () => {},
      syncStatusChannel: 's',
      offlineQueueChangedChannel: 'q',
      rateUpdatedChannel: 'r',
      ratesRefreshedChannel: 'rr'
    })
    const fan = createTrackerFanOut({
      store: t.store as never,
      trackers: [{ sync: sync as unknown as TrackerSyncService<unknown, unknown> }]
    })
    const trackerRates = createTrackerRates({ store: t.store as never, trackers: fan })
    ;(ipcMain.handle as unknown as Mock).mockClear()
    registerTrackers({
      store: t.store,
      trackerRates,
      trackerLifecycle: {},
      trackerAuth: {},
      trackerChoices: {},
      newTrackerCardsEnabled: true
    } as unknown as AppDeps)
    handlers = new Map((ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h]))
  })

  const getRate = (malId: number) =>
    handlers.get(CHANNELS.TRACKER_GET_RATE)!(
      {},
      'anilist',
      malId
    ) as Promise<TrackerRateResult | null>

  it('a mapped title carries the AniList media id', async () => {
    expect(await getRate(1)).toEqual({
      values: { episodes: 7, status: 'watching', score: 9, rewatches: 0 },
      stale: false,
      mediaId: 101
    })
  })

  it('an unmapped title (a negative entry) carries none, and reads as no row', async () => {
    // MAL 2's lookup omits it: a negative entry.
    expect(await getRate(2)).toEqual({ values: null, stale: false })
    expect(world.server.of('IdMap')).toHaveLength(1)
    // Asked again, the negative entry answers: no second lookup.
    expect(await getRate(2)).toEqual({ values: null, stale: false })
    expect(world.server.of('IdMap')).toHaveLength(1)
  })

  it('an unknown title (no id-map entry, read from the cache offline) carries none', async () => {
    const t = await createTestAniList({
      seed: {
        anilistUserRates: [
          {
            entry: {
              id: 9005,
              mediaId: 105,
              status: 'CURRENT',
              score: 0,
              progress: 2,
              repeat: 0,
              updatedAt: 1,
              media: { id: 105, idMal: 5 }
            },
            smotretAnime: null
          }
        ]
      }
    })
    const sync = createAniListSyncService(t.provider, {
      store: t.store as never,
      broadcast: () => {},
      syncStatusChannel: 's',
      offlineQueueChangedChannel: 'q',
      rateUpdatedChannel: 'r',
      ratesRefreshedChannel: 'rr'
    })
    const fan = createTrackerFanOut({
      store: t.store as never,
      trackers: [{ sync: sync as unknown as TrackerSyncService<unknown, unknown> }]
    })
    const trackerRates = createTrackerRates({
      store: t.store as never,
      trackers: fan,
      isOffline: () => true
    })
    ;(ipcMain.handle as unknown as Mock).mockClear()
    registerTrackers({
      store: t.store,
      trackerRates,
      newTrackerCardsEnabled: true
    } as unknown as AppDeps)
    const h = new Map((ipcMain.handle as unknown as Mock).mock.calls.map(([c, fn]) => [c, fn]))
    const out = (await h.get(CHANNELS.TRACKER_GET_RATE)!({}, 'anilist', 5)) as TrackerRateResult
    expect(out).toEqual({
      values: { episodes: 2, status: 'watching', score: 0, rewatches: 0 },
      stale: true
    })
  })
})

describe('tracker:get-rate on the read that finds the token refused (#740)', () => {
  /** The cached row: 3 episodes at 50, where the server has 7 at 85. */
  const CACHED = {
    entry: {
      id: 9001,
      mediaId: 101,
      status: 'CURRENT',
      score: 50,
      progress: 3,
      repeat: 0,
      updatedAt: 1,
      media: { id: 101, idMal: 1 }
    },
    smotretAnime: null
  }
  const CACHED_VALUES = { episodes: 3, status: 'watching', score: 5, rewatches: 0 }

  async function refusedRig(reply: { status: number; body: unknown }, cached: boolean) {
    const world = serveWorld({
      entries: [
        {
          id: 9001,
          mediaId: 101,
          idMal: 1,
          status: 'CURRENT',
          score: 85,
          progress: 7,
          repeat: 0,
          updatedAt: 1
        }
      ]
    })
    world.inject('MediaList', reply)
    const t = await createTestAniList({ seed: { anilistUserRates: cached ? [CACHED] : [] } })
    const sync = createAniListSyncService(t.provider, {
      store: t.store as never,
      broadcast: () => {},
      syncStatusChannel: 's',
      offlineQueueChangedChannel: 'q',
      rateUpdatedChannel: 'r',
      ratesRefreshedChannel: 'rr'
    })
    const fan = createTrackerFanOut({
      store: t.store as never,
      trackers: [{ sync: sync as unknown as TrackerSyncService<unknown, unknown> }]
    })
    const trackerRates = createTrackerRates({
      store: t.store as never,
      trackers: fan,
      isOffline: () => false
    })
    ;(ipcMain.handle as unknown as Mock).mockClear()
    registerTrackers({
      store: t.store,
      trackerRates,
      newTrackerCardsEnabled: true
    } as unknown as AppDeps)
    const h = new Map((ipcMain.handle as unknown as Mock).mock.calls.map(([c, fn]) => [c, fn]))
    const getRate = () =>
      h.get(CHANNELS.TRACKER_GET_RATE)!({}, 'anilist', 1) as Promise<TrackerRateResult | null>
    return { t, world, getRate }
  }

  const REFUSED = [
    ['HTTP 400 Invalid token', { status: 400, body: anilistFixture('invalid-token-400') }],
    ['HTTP 401', { status: 401, body: anilistFixture('invalid-token-401') }],
    [
      'auth-200 (a 200 whose errors[0].status is 401)',
      { status: 200, body: { errors: [{ message: 'Invalid token', status: 401 }], data: null } }
    ]
  ] as const

  it.each(REFUSED)(
    '%s, with a cached rate: answers stale from the cache and expires the session',
    async (_name, reply) => {
      const { t, world, getRate } = await refusedRig(reply, true)
      expect(await getRate()).toMatchObject({ values: CACHED_VALUES, stale: true })
      expect(world.server.of('MediaList')).toHaveLength(1)
      await vi.waitFor(() => expect(t.store.get('anilistSessionExpired')).toBe(true))
      expect(t.store.get('anilistCredentials')).toBeNull()
      expect(t.onSessionExpired).toHaveBeenCalledTimes(1)
    }
  )

  it('HTTP 400 Invalid token, with an empty cache: rejects with the session-gone error, not the raw refusal', async () => {
    const { getRate } = await refusedRig(
      { status: 400, body: anilistFixture('invalid-token-400') },
      false
    )
    const err = await getRate().catch((e) => e)
    expect(err).toBeInstanceOf(AniListSessionError)
    expect(err.message).toBe('AniList session expired — sign in again in Settings → Trackers')
    expect(err.cause).toBeInstanceOf(AniListApiError)
    expect(err.cause.message).toBe('AniList API error: 400 — Invalid token')
  })

  it.each([
    ['an item-class 400 (validation-400)', { status: 400, body: anilistFixture('validation-400') }],
    ['a server 5xx', { status: 500, body: { errors: [{ message: 'Internal Server Error' }] } }]
  ] as const)('%s still rejects, not stale, and the session stays', async (_name, reply) => {
    const { t, getRate } = await refusedRig(reply, true)
    const err = await getRate().catch((e) => e)
    expect(err).toBeInstanceOf(AniListApiError)
    expect(err).not.toBeInstanceOf(AniListSessionError)
    expect(err.status).toBe(reply.status)
    expect(t.store.get('anilistSessionExpired')).toBe(false)
    expect(t.onSessionExpired).not.toHaveBeenCalled()
  })
})
