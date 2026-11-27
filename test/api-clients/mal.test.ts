// MyAnimeList fixture replay (#702): the provider, its codec and the client,
// through the real `fetchWithTimeout`, against `test/fixtures/mal/` served by
// `fake-mal.ts`. In the `shikimori.test.ts` style.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import { api, installFakeMal, malFixture, oauth, type FakeMal } from '../helpers/fake-mal'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { createCredentialVault } from '../../src/main/trackers/credential-vault'
import { createMalClient } from '../../src/main/trackers/mal/client'
import { createMalAuth, type MalCredentials } from '../../src/main/trackers/mal/auth'
import {
  MAL_DETAILS_CACHE_MAX,
  MAL_REWATCH_SHIFT,
  createMalProvider,
  malRateCache,
  type MalListRow,
  type MalSession
} from '../../src/main/trackers/mal/provider'
import { nextWatchedRate, type RateValues } from '../../src/main/lib/shikimori-rate'
import { TrackerApiError } from '../../src/main/trackers/errors'
import { classifyMalError } from '../../src/main/trackers/mal/classify'

const USER = { id: 1234567, nickname: 'fake_mal_user', avatar: null }
const TOKEN = 'fake-access-token-mal-1'

let fake: FakeMal

beforeEach(() => {
  fake = installFakeMal()
})

afterEach(() => {
  fake.restore()
})

function rig(opts: { secret?: string } = {}) {
  const store = new InMemoryStorage({
    ...(structuredClone(STORE_DEFAULTS) as Record<string, unknown>),
    myanimelistUser: USER,
    myanimelistClientConfig: { clientId: 'cid-123' }
  })
  const safe = createFakeSafeStorage({ async: true })
  const vault = createCredentialVault({ store, safeStorage: safe.holder, warn: () => {} })
  const client = createMalClient({ spacingMs: 0, sleep: async () => {} })
  const auth = createMalAuth({ store, vault, client, generation: () => 0, port: 41753 })
  const provider = createMalProvider({
    store,
    client,
    auth,
    generation: () => 0,
    lookupByMalIds: async (ids) =>
      Object.fromEntries(ids.map((id) => [id, { id: id * 100, myAnimeListId: id }])) as never
  })
  const session: MalSession = { token: TOKEN, userId: USER.id, generation: 0 }
  return { store, vault, client, auth, provider, session, secret: opts.secret }
}

const listRows = (): MalListRow[] => [
  ...malFixture<{ data: MalListRow[] }>('animelist-page1.json').data,
  ...malFixture<{ data: MalListRow[] }>('animelist-page2.json').data
]

describe('listEntries', () => {
  beforeEach(() => {
    fake.on('GET', api('/users/@me/animelist'), (call) =>
      call.url.searchParams.get('offset') === '3'
        ? { json: malFixture('animelist-page2.json') }
        : { json: malFixture('animelist-page1.json') }
    )
  })

  it('names the fields, asks for 1000 rows with nsfw=true, and follows paging.next onto the stub', async () => {
    const r = rig()
    const entries = await r.provider.listEntries(r.session)
    const calls = fake.callsTo('GET', api('/users/@me/animelist'))
    expect(calls).toHaveLength(2)
    const first = calls[0].url.searchParams
    expect(first.get('fields')).toBe(
      'list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched,updated_at},num_episodes,status,media_type,main_picture'
    )
    expect(first.get('limit')).toBe('1000')
    expect(first.get('nsfw')).toBe('true')
    // The fixture's `paging.next` is on api.myanimelist.net: rebuilt from its offset, on the stub.
    expect(calls[1].url.origin).toBe('http://mal.test')
    expect(calls[1].url.searchParams.get('offset')).toBe('3')
    expect(calls[1].url.searchParams.get('nsfw')).toBe('true')
    expect(calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(entries.map((e) => e.malId)).toEqual([5114, 21, 1535, 52991])
  })

  it('normalizes each row, with native the row as read', async () => {
    const r = rig()
    const [fma, op, dn, frieren] = await r.provider.listEntries(r.session)
    expect(fma).toMatchObject({
      trackerId: 'mal',
      malId: 5114,
      remoteId: 5114,
      values: { episodes: 64, status: 'completed', score: 10, rewatches: 2 },
      updatedAt: Date.parse('2026-03-01T10:00:00+00:00'),
      anime: {
        title: 'Fullmetal Alchemist: Brotherhood',
        poster: 'https://cdn.myanimelist.net/images/anime/1208/94745l.jpg',
        kind: 'tv',
        episodes: 64,
        episodesAired: 64,
        status: 'finished_airing'
      },
      smotretAnime: { id: 511400 }
    })
    expect(fma.native).toEqual(listRows()[0])
    // `watching` + `is_rewatching` → `rewatching`, the native count shifted to count-at-start.
    expect(dn.values).toEqual({
      episodes: 5,
      status: 'rewatching',
      score: 9,
      rewatches: 1 + MAL_REWATCH_SHIFT
    })
    expect(dn.anime.poster).toBe('https://cdn.myanimelist.net/images/anime/1079/138100.jpg')
    expect(frieren.values).toEqual({ episodes: 0, status: 'planned', score: 0, rewatches: 0 })
    // MAL's 0 is "unknown".
    expect(op.anime.episodes).toBeNull()
  })

  // Mutation control: a codec that sets `episodesAired: null` always reds the first row.
  it('episodesAired: a finished title’s total, null for an airing one', async () => {
    const r = rig()
    const entries = await r.provider.listEntries(r.session)
    const byId = new Map(entries.map((e) => [e.malId, e]))
    expect(byId.get(5114)!.anime.episodesAired).toBe(64)
    expect(byId.get(21)!.anime.episodesAired).toBeNull()
  })

  it('filters by canonical status locally', async () => {
    const r = rig()
    const rewatching = await r.provider.listEntries(r.session, { status: 'rewatching' })
    expect(rewatching.map((e) => e.malId)).toEqual([1535])
  })
})

describe('the rate cache codec', () => {
  it('writes myanimelistUserRates from native, reads it back, and patches in MAL’s own form', async () => {
    fake.on('GET', api('/users/@me/animelist'), { json: malFixture('animelist-page2.json') })
    const r = rig()
    const entries = await r.provider.listEntries(r.session)
    const rows = malRateCache.fromEntries(entries)
    expect(rows[0]).toEqual({
      ...listRows()[3],
      smotretAnime: { id: 5299100, myAnimeListId: 52991 }
    })
    expect(malRateCache.read(rows[0])).toEqual({
      remoteId: 52991,
      values: { episodes: 0, status: 'planned', score: 0, rewatches: 0 }
    })
    const patched = malRateCache.patch(rows[0], {
      episodes: 3,
      status: 'rewatching',
      score: 7,
      rewatches: 2
    })
    expect(patched.list_status).toMatchObject({
      status: 'watching',
      is_rewatching: true,
      num_episodes_watched: 3,
      score: 7,
      num_times_rewatched: 2 - MAL_REWATCH_SHIFT
    })
    expect(malRateCache.entryOf(patched)).toMatchObject({
      trackerId: 'mal',
      malId: 52991,
      values: { episodes: 3, status: 'rewatching', score: 7, rewatches: 2 },
      anime: { poster: 'https://cdn.myanimelist.net/images/anime/1015/138006l.jpg' }
    })
    expect(malRateCache.entryOf(patched)).not.toHaveProperty('native')
  })
})

describe('getEntry', () => {
  it('reads my_list_status with nsfw=true; the entry’s native is it', async () => {
    fake.on('GET', api('/anime/5114'), { json: malFixture('anime-entry.json') })
    const r = rig()
    const entry = await r.provider.getEntry(r.session, { malId: 5114, remoteId: 5114 })
    const q = fake.calls[0].url.searchParams
    expect(q.get('fields')).toBe(
      'my_list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched,updated_at},num_episodes,status'
    )
    expect(q.get('nsfw')).toBe('true')
    expect(entry).toEqual({
      trackerId: 'mal',
      malId: 5114,
      remoteId: 5114,
      values: { episodes: 64, status: 'completed', score: 10, rewatches: 2 },
      native: malFixture<{ my_list_status: unknown }>('anime-entry.json').my_list_status
    })
  })

  it('no my_list_status is null: not on the list', async () => {
    fake.on('GET', api('/anime/52991'), { json: malFixture('anime-entry-not-listed.json') })
    const r = rig()
    expect(await r.provider.getEntry(r.session, { malId: 52991, remoteId: null })).toBeNull()
  })
})

describe('upsertEntry', () => {
  beforeEach(() => {
    fake.on('PATCH', /\/v2\/anime\/\d+\/my_list_status/, {
      json: malFixture('my-list-status.json')
    })
  })

  const values: RateValues = { episodes: 5, status: 'watching', score: 8, rewatches: 0 }

  it('an episode bump sends num_watched_episodes and nothing else, form-encoded', async () => {
    const r = rig()
    const entry = await r.provider.upsertEntry(r.session, { malId: 5114, remoteId: 5114 }, values, [
      'episodes'
    ])
    const call = fake.callsTo('PATCH', api('/anime/5114/my_list_status'))[0]
    expect(call.contentType).toBe('application/x-www-form-urlencoded')
    expect(call.form).toEqual({ num_watched_episodes: '5' })
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(entry.values).toEqual(values)
    expect(entry.native).toEqual(malFixture('my-list-status.json'))
  })

  it('a status change to rewatching sends status=watching&is_rewatching=true', async () => {
    const r = rig()
    await r.provider.upsertEntry(
      r.session,
      { malId: 5114, remoteId: 5114 },
      { ...values, status: 'rewatching', rewatches: 3 },
      ['status']
    )
    expect(fake.calls[0].form).toMatchObject({ status: 'watching', is_rewatching: 'true' })
    // The pair (with the count it moves) is one field: no episodes or score.
    expect(Object.keys(fake.calls[0].form!).sort()).toEqual(
      ['is_rewatching', 'num_times_rewatched', 'status']
        .slice(MAL_REWATCH_SHIFT === 0 ? 1 : 0)
        .sort()
    )
  })

  it.each([
    ['on_hold', 'on_hold'],
    ['dropped', 'dropped'],
    ['planned', 'plan_to_watch'],
    ['completed', 'completed'],
    ['watching', 'watching']
  ] as const)(
    'a rewatching entry moved to %s sends status=%s&is_rewatching=false',
    async (status, malStatus) => {
      const r = rig()
      await r.provider.upsertEntry(
        r.session,
        { malId: 1535, remoteId: 1535 },
        { episodes: 5, status, score: 9, rewatches: 2 },
        ['status']
      )
      expect(fake.calls[0].form).toMatchObject({ status: malStatus, is_rewatching: 'false' })
      expect(fake.calls[0].form).not.toHaveProperty('num_watched_episodes')
      expect(fake.calls[0].form).not.toHaveProperty('score')
    }
  )

  it('the create branch sends every intended field', async () => {
    const r = rig()
    await r.provider.upsertEntry(r.session, { malId: 52991, remoteId: null }, values, [
      'episodes',
      'status',
      'score',
      'rewatches'
    ])
    expect(fake.calls[0].form).toEqual({
      status: 'watching',
      is_rewatching: 'false',
      num_watched_episodes: '5',
      score: '8',
      num_times_rewatched: '0'
    })
  })

  it('no changed field makes no request', async () => {
    const r = rig()
    const entry = await r.provider.upsertEntry(
      r.session,
      { malId: 5114, remoteId: 5114 },
      values,
      []
    )
    expect(fake.calls).toHaveLength(0)
    expect(entry.values).toEqual(values)
  })
})

// #708's option A: one semantics (count-at-start) on the app side.
describe('the rewatch round trip', () => {
  function rowsById(): Map<number, MalListRow> {
    return new Map(listRows().map((r) => [r.node.id, r]))
  }

  beforeEach(() => {
    fake.on('GET', api('/users/@me/animelist'), (call) =>
      call.url.searchParams.get('offset') === '3'
        ? { json: malFixture('animelist-page2.json') }
        : { json: malFixture('animelist-page1.json') }
    )
    fake.on('PATCH', /my_list_status$/, { json: malFixture('my-list-status.json') })
  })

  // Mutation check: with a non-zero shift, drop the write translation and this reds.
  it('a rewatching and a completed entry written back unchanged send the fixture’s native count', async () => {
    const r = rig()
    const entries = await r.provider.listEntries(r.session)
    const native = rowsById()
    for (const malId of [1535, 5114]) {
      const e = entries.find((x) => x.malId === malId)!
      await r.provider.upsertEntry(r.session, { malId, remoteId: malId }, e.values, ['rewatches'])
      expect(fake.calls.at(-1)!.form!.num_times_rewatched).toBe(
        String(native.get(malId)!.list_status.num_times_rewatched)
      )
    }
  })

  it('a completed title starting a rewatch keeps MAL’s count; finishing the rewatch adds one', async () => {
    const r = rig()
    const entries = await r.provider.listEntries(r.session)
    const fma = entries.find((x) => x.malId === 5114)!
    // nextWatchedRate counts the rewatch at its start: 2 → 3.
    const started = nextWatchedRate(fma.values, 1)!
    expect(started).toMatchObject({ status: 'rewatching', rewatches: 3 })
    await r.provider.upsertEntry(r.session, { malId: 5114, remoteId: 5114 }, started, [
      'episodes',
      'status',
      'rewatches'
    ])
    expect(fake.calls.at(-1)!.form).toMatchObject({
      status: 'watching',
      is_rewatching: 'true',
      num_times_rewatched: String(3 - MAL_REWATCH_SHIFT)
    })
    // The rewatching title moved to completed: MAL now counts the finished rewatch.
    const dn = entries.find((x) => x.malId === 1535)!
    await r.provider.upsertEntry(
      r.session,
      { malId: 1535, remoteId: 1535 },
      { ...dn.values, status: 'completed', episodes: 37 },
      ['status', 'episodes']
    )
    expect(fake.calls.at(-1)!.form).toMatchObject({
      status: 'completed',
      is_rewatching: 'false',
      num_times_rewatched: String(dn.values.rewatches)
    })
  })
})

describe('deleteEntry', () => {
  it('DELETEs my_list_status; a 404 counts as already gone', async () => {
    fake.on('DELETE', api('/anime/5114/my_list_status'), { status: 200, text: '' })
    fake.on('DELETE', api('/anime/21/my_list_status'), {
      status: 404,
      json: malFixture('error-not-found.json')
    })
    fake.on('DELETE', api('/anime/1/my_list_status'), { status: 400, json: { error: 'bad' } })
    const r = rig()
    await r.provider.deleteEntry!(r.session, { malId: 5114, remoteId: 5114 })
    await r.provider.deleteEntry!(r.session, { malId: 21, remoteId: 21 })
    await expect(
      r.provider.deleteEntry!(r.session, { malId: 1, remoteId: 1 })
    ).rejects.toBeInstanceOf(TrackerApiError)
    expect(fake.callsTo('DELETE', /my_list_status/)).toHaveLength(3)
  })
})

describe('the capability reads (public, by id)', () => {
  it('getRelated asks for the title’s own kind and date beside related_anime, with the client header', async () => {
    fake.on('GET', api('/anime/5114'), { json: malFixture('related.json') })
    const r = rig()
    const related = await r.provider.getRelated!({ malId: 5114, remoteId: null })
    const call = fake.calls[0]
    expect(call.url.searchParams.get('fields')).toBe(
      'title,main_picture,media_type,start_date,related_anime'
    )
    expect(call.url.searchParams.get('nsfw')).toBe('true')
    expect(call.headers['x-mal-client-id']).toBe('cid-123')
    expect(call.headers.authorization).toBeUndefined()
    expect(related).toMatchObject({ id: 5114, media_type: 'tv', start_date: '2009-04-05' })
    expect((related as { related_anime: unknown[] }).related_anime).toEqual(
      malFixture<{ related_anime: unknown[] }>('related.json').related_anime
    )
  })

  it('getRecommendations reads each seed’s recommendations', async () => {
    fake.on('GET', /\/v2\/anime\/\d+$/, { json: malFixture('recommendations.json') })
    const r = rig()
    const recs = (await r.provider.getRecommendations!([5114, 21])) as {
      malId: number
      recommendations: unknown[]
    }[]
    expect(fake.calls.map((c) => c.url.pathname)).toEqual([api('/anime/5114'), api('/anime/21')])
    expect(fake.calls[0].url.searchParams.get('fields')).toBe('recommendations')
    expect(recs.map((x) => x.malId)).toEqual([5114, 21])
    expect(recs[0].recommendations).toHaveLength(2)
  })

  it('getDetails reads synopsis and genres with nsfw=true and caches them in myanimelistAnimeDetails', async () => {
    fake.on('GET', api('/anime/5114'), { json: malFixture('details.json') })
    const r = rig()
    const details = await r.provider.getDetails!(5114)
    const fields = fake.calls[0].url.searchParams.get('fields')!.split(',')
    expect(fields).toEqual(expect.arrayContaining(['synopsis', 'genres']))
    expect(fake.calls[0].url.searchParams.get('nsfw')).toBe('true')
    expect(details).toEqual(malFixture('details.json'))
    expect(r.store.get('myanimelistAnimeDetails')).toEqual({
      '5114': { details: malFixture('details.json'), fetchedAt: expect.any(Number) }
    })
  })

  // #733 review: every write rewrites the store file, so the cache is capped.
  it(`myanimelistAnimeDetails keeps the ${MAL_DETAILS_CACHE_MAX} most recently fetched titles`, async () => {
    fake.on('GET', /\/v2\/anime\/\d+$/, { json: malFixture('details.json') })
    const r = rig()
    // Full, oldest first by fetch time: ids 1..MAX, fetched at 1..MAX.
    const full = Object.fromEntries(
      Array.from({ length: MAL_DETAILS_CACHE_MAX }, (_, i) => [
        String(i + 1),
        { details: { id: i + 1 }, fetchedAt: i + 1 }
      ])
    )
    r.store.set('myanimelistAnimeDetails', full)
    await r.provider.getDetails!(5114)
    const cache = r.store.get('myanimelistAnimeDetails') as Record<string, unknown>
    expect(Object.keys(cache)).toHaveLength(MAL_DETAILS_CACHE_MAX)
    expect(cache).not.toHaveProperty('1')
    expect(cache).toHaveProperty('2')
    expect(cache).toHaveProperty('5114')
    // A refetch of a cached title replaces it and evicts nothing.
    await r.provider.getDetails!(2)
    const again = r.store.get('myanimelistAnimeDetails') as Record<string, { fetchedAt: number }>
    expect(Object.keys(again)).toHaveLength(MAL_DETAILS_CACHE_MAX)
    expect(again).toHaveProperty('3')
    expect(again['2'].fetchedAt).toBeGreaterThan(MAL_DETAILS_CACHE_MAX)
  })

  it('declares exactly the three capabilities it implements', () => {
    const { provider } = rig()
    expect(
      Object.entries(provider.capabilities)
        .filter(([, on]) => on)
        .map(([c]) => c)
    ).toEqual(['getRelated', 'getRecommendations', 'getDetails'])
  })
})

describe('/users/@me', () => {
  it('maps to TrackerUser', async () => {
    fake.on('GET', api('/users/@me'), { json: malFixture('users-me.json') })
    const r = rig()
    expect(await r.provider.getUser('fake-access-token-x')).toEqual({
      id: 1234567,
      nickname: 'fake_mal_user',
      avatar: 'https://cdn.myanimelist.net/images/userimages/1234567.jpg'
    })
    expect(fake.calls[0].headers.authorization).toBe('Bearer fake-access-token-x')
  })
})

describe('the token bodies', () => {
  async function exchangeWith(secret: string | null): Promise<Record<string, string>> {
    fake.on('POST', oauth('/token'), { json: malFixture('token.json') })
    fake.on('GET', api('/users/@me'), { json: malFixture('users-me.json') })
    const r = rig()
    if (secret) r.vault.commit('myanimelistClientSecret', await r.vault.encrypt(secret))
    const attempt = r.auth.flow.begin({ port: 41753 })
    const out = await r.auth.flow.exchange('the-code', attempt)
    expect((out.credentials as MalCredentials).access_token).toBe('fake-access-token-mal-1')
    const call = fake.callsTo('POST', oauth('/token'))[0]
    expect(call.contentType).toBe('application/x-www-form-urlencoded')
    return call.form!
  }

  it('the code exchange is form-encoded and carries no client_secret when none is saved', async () => {
    const form = await exchangeWith(null)
    expect(form).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'cid-123',
      code: 'the-code',
      redirect_uri: 'http://localhost:41753/callback'
    })
    expect(form.code_verifier).toHaveLength(128)
    expect(form).not.toHaveProperty('client_secret')
  })

  it('a saved secret is sent', async () => {
    expect((await exchangeWith('s3cret')).client_secret).toBe('s3cret')
  })
})

describe('the client', () => {
  it('backs off on a transient answer and spaces requests', async () => {
    let n = 0
    fake.on('GET', api('/anime/1'), () =>
      ++n < 3 ? { status: 429, text: '' } : { json: { id: 1 } }
    )
    const sleeps: number[] = []
    let clock = 0
    const client = createMalClient({
      spacingMs: 1000,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
      now: () => clock
    })
    const res = await client.request({ url: 'http://mal.test/v2/anime/1' })
    expect(res.body).toEqual({ id: 1 })
    expect(fake.calls).toHaveLength(3)
    // 2 s, then 4 s, before the retries (each at least the spacing).
    expect(sleeps).toEqual([2000, 4000])
  })

  it('gives up after 3 retries with the status, and a DoS 403 counts as transient', async () => {
    fake.on('GET', api('/anime/1'), { status: 403, text: '<p>DoS detected</p>' })
    const client = createMalClient({ spacingMs: 0, sleep: async () => {} })
    const err = await client.request({ url: 'http://mal.test/v2/anime/1' }).catch((e) => e)
    expect(err).toBeInstanceOf(TrackerApiError)
    expect((err as TrackerApiError).status).toBe(403)
    expect(fake.calls).toHaveLength(4)
  })

  it('a config 403 is not retried', async () => {
    fake.on('GET', api('/anime/1'), { status: 403, json: malFixture('error-forbidden.json') })
    const client = createMalClient({ spacingMs: 0, sleep: async () => {} })
    await expect(client.request({ url: 'http://mal.test/v2/anime/1' })).rejects.toBeInstanceOf(
      TrackerApiError
    )
    expect(fake.calls).toHaveLength(1)
  })

  // #733 review: a non-JSON 2xx used to throw a bare SyntaxError (`item`: dropped).
  it('a 2xx whose body isn’t JSON is a server-class TrackerApiError with the scrubbed body', async () => {
    fake.on('GET', api('/anime/1'), { status: 200, text: '<html>Akamai interstitial</html>' })
    const client = createMalClient({ spacingMs: 0, sleep: async () => {} })
    const err = await client.request({ url: 'http://mal.test/v2/anime/1' }).catch((e) => e)
    expect(err).toBeInstanceOf(TrackerApiError)
    expect(classifyMalError(err)).toBe('server')
    expect((err as TrackerApiError).body).toContain('Akamai interstitial')
  })
})
