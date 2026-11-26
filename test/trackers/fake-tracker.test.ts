// `fake-tracker.ts` answers as its notes say (#689).
import { describe, it, expect } from 'vitest'
import {
  ANILIST_MEDIA_IDS,
  REPLIES,
  UNMAPPED_MAL_ID,
  createFakeTracker,
  type FakeAnilistRow,
  type FakeMalRow,
  type FakeShikiRow
} from '../helpers/fake-tracker'

const WATCHING = { episodes: 3, status: 'watching' as const, score: 7, rewatches: 0 }

describe.each(['shikimori', 'anilist', 'mal'] as const)('the %s personality', (id) => {
  it('auth() returns its own session, and upserts are recorded with it', async () => {
    const fake = createFakeTracker(id)
    const session = await fake.provider.auth()
    expect(session).toEqual({ token: `fake-access-token-${id}`, userId: 1 })
    await fake.provider.upsertEntry(session, { malId: 1, remoteId: null }, WATCHING, ['episodes'])
    expect(fake.upserts).toEqual([
      { session, ref: { malId: 1, remoteId: null }, values: WATCHING, changedFields: ['episodes'] }
    ])
    expect((await fake.provider.getEntry(session, { malId: 1, remoteId: null }))?.values).toEqual(
      WATCHING
    )
  })

  it('getUser accepts its own token only', async () => {
    const fake = createFakeTracker(id)
    await expect(fake.provider.getUser(fake.user.token)).resolves.toEqual({
      id: 1,
      nickname: `${id}-user`,
      avatar: null
    })
    await expect(fake.provider.getUser('someone-else')).rejects.toBeDefined()
  })

  it('injects each class, and its classifier names it', async () => {
    const fake = createFakeTracker(id)
    const session = await fake.provider.auth()
    for (const [reply, make] of Object.entries(REPLIES[id])) {
      fake.fail(reply as never, { member: 'getEntry' })
      const err = await fake.provider.getEntry(session, { malId: 1, remoteId: null }).then(
        () => null,
        (e: unknown) => e
      )
      expect(err, reply).not.toBeNull()
      expect(fake.provider.classifyError(err)).toBe(fake.provider.classifyError(make()))
    }
    // Each injection was used once.
    await expect(fake.provider.getEntry(session, { malId: 1, remoteId: null })).resolves.toBeNull()
  })

  it('a failure aimed at one member leaves the others alone', async () => {
    const fake = createFakeTracker(id)
    fake.fail('server' as never, { member: 'upsertEntry', times: 2 })
    const session = await fake.provider.auth()
    await expect(fake.provider.listEntries(session)).resolves.toEqual([])
    const write = () =>
      fake.provider.upsertEntry(session, { malId: 2, remoteId: null }, WATCHING, ['episodes'])
    await expect(write()).rejects.toBeDefined()
    await expect(write()).rejects.toBeDefined()
    await expect(write()).resolves.toMatchObject({ malId: 2 })
  })
})

describe('classes per personality', () => {
  const classes = (id: 'shikimori' | 'anilist' | 'mal') => {
    const fake = createFakeTracker(id)
    return Object.fromEntries(
      Object.entries(REPLIES[id]).map(([name, make]) => [name, fake.provider.classifyError(make())])
    )
  }

  it('Shikimori', () => {
    expect(classes('shikimori')).toEqual({
      network: 'network',
      auth: 'auth',
      'auth-expired': 'auth',
      'rate-limit': 'rate-limit',
      server: 'server',
      item: 'item'
    })
  })

  it('AniList: a 200 with errors, a 401, and a 403 that means the API is down', () => {
    expect(classes('anilist')).toEqual({
      network: 'network',
      auth: 'auth',
      'auth-200': 'auth',
      'rate-limit': 'rate-limit',
      'rate-limit-429': 'rate-limit',
      server: 'server',
      item: 'item'
    })
    expect(REPLIES.anilist['auth-200']().status).toBe(200)
    expect(REPLIES.anilist['rate-limit']().status).toBe(403)
  })

  it('MAL: the bad client id, and the two 403 bodies', () => {
    expect(classes('mal')).toEqual({
      network: 'network',
      auth: 'auth',
      config: 'config',
      'config-forbidden': 'config',
      'rate-limit': 'rate-limit',
      server: 'server',
      item: 'item'
    })
    expect(REPLIES.mal.config()).toMatchObject({ status: 400 })
    expect(REPLIES.mal['config-forbidden']().body).toContain('forbidden')
    expect(REPLIES.mal['rate-limit']()).toMatchObject({ status: 403 })
    expect(REPLIES.mal['rate-limit']().body).toContain('DoS detected')
  })
})

describe('native rows', () => {
  it('Shikimori: the anime_rates row model fake-shikimori.ts uses', async () => {
    const fake = createFakeTracker('shikimori')
    fake.set(9001, { episodes: 2, score: 6 })
    const [e] = await fake.provider.listEntries(await fake.provider.auth())
    const row = e.native as FakeShikiRow
    expect(row).toMatchObject({
      id: 90010,
      episodes: 2,
      score: 6,
      status: 'watching',
      rewatches: 0,
      target_type: 'Anime',
      anime: { id: 9001, name: '#9001' }
    })
    expect(typeof row.updated_at).toBe('string')
    expect(e.updatedAt).toBe(Date.parse(row.updated_at))
  })

  it('AniList: its own ids, a raw POINT_100 score, and one unmapped title', async () => {
    const fake = createFakeTracker('anilist')
    fake.set(1, { status: 'rewatching', episodes: 4 }, { scoreRaw: 85 })
    const session = await fake.provider.auth()
    const [e] = await fake.provider.listEntries(session)
    const row = e.native as FakeAnilistRow
    expect(row).toMatchObject({
      mediaId: ANILIST_MEDIA_IDS[1],
      status: 'REPEATING',
      score: 85,
      progress: 4,
      media: { idMal: 1 }
    })
    expect(e.values).toMatchObject({ status: 'rewatching', score: 9 })
    expect(e.remoteId).not.toBe(1)
    // Left at 9, the stored 85 is kept.
    await fake.provider.upsertEntry(session, { malId: 1, remoteId: e.remoteId }, e.values, [
      'episodes'
    ])
    expect((fake.native(1) as FakeAnilistRow).score).toBe(85)
    // The unmapped title has no AniList entry to read or write.
    const unmapped = { malId: UNMAPPED_MAL_ID, remoteId: null }
    const err = await fake.provider.getEntry(session, unmapped).catch((x: unknown) => x)
    expect(fake.provider.classifyError(err)).toBe('item')
    await expect(
      fake.provider.upsertEntry(session, unmapped, WATCHING, ['episodes'])
    ).rejects.toBeDefined()
  })

  it('MAL: a rewatch is watching with is_rewatching', async () => {
    const fake = createFakeTracker('mal')
    fake.set(5, { status: 'rewatching', episodes: 1, rewatches: 1 })
    const [e] = await fake.provider.listEntries(await fake.provider.auth())
    expect((e.native as FakeMalRow).list_status).toMatchObject({
      status: 'watching',
      is_rewatching: true,
      num_episodes_watched: 1,
      num_times_rewatched: 1
    })
    expect(e.values.status).toBe('rewatching')
  })
})
