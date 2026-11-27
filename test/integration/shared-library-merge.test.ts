// Two PCs and one drive (#584): the owner's PC A exports, a claim PC B watches
// episodes 4–6 on it, the drive comes back to A, and A merges. Real stores,
// real Shared Library files, the real runner and drain, a fake Shikimori.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi
}))

import { cleanup } from '../helpers/shared-library'
import {
  ANILIST_5,
  ANIME,
  MAL,
  T0,
  cacheEntry,
  driveDoc,
  makeLibrary,
  makePc,
  progressRow,
  server,
  trackerActor,
  vals,
  writeDrive
} from '../helpers/sync-runner'
import { ANILIST_MEDIA_IDS } from '../helpers/fake-tracker'
import { ALICE, createAniListWorld } from '../helpers/anilist-server'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import { doc, rate, watch } from '../helpers/sync-merge'
import { readLibrary } from '../../src/main/lib/shared-library/read'
import { createCredentialVault } from '../../src/main/trackers/credential-vault'
import { createAniListProvider } from '../../src/main/trackers/anilist/provider'
import { createAniListLimiter } from '../../src/main/trackers/anilist/limiter'
import { deadTokenError } from '../../src/main/trackers/anilist/client'
import {
  createAniListSyncService,
  type AniListSyncService
} from '../../src/main/trackers/anilist/sync'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'

const ID = String(ANIME)
const rows = (eps: number[], at: number) =>
  Object.fromEntries(eps.map((e) => [`${ID}:${e}`, progressRow(true, at + e)]))

afterEach(() => {
  cleanup()
  server.reset()
})

describe('local ↔ Shared Library ↔ Shikimori across two PCs', () => {
  it('positions and watched combine, A raises to episode 6, and one score conflict is held', async () => {
    server.set(MAL, { episodes: 3, score: 6 }, T0)
    // 1. A exports: an empty-state library, filled by A's first merge.
    const { root, libraryId } = await makeLibrary()
    const a = makePc({
      installId: 'pc-a',
      store: {
        watchProgress: rows([1, 2, 3], T0),
        shikimoriUserRates: [cacheEntry(MAL, ANIME, vals({ episodes: 3, score: 6 }), T0)]
      }
    })
    await a.attach(root)
    const first = await a.runner.runAll('attach')
    expect(first.libraries[0]).toMatchObject({ drive: 'ok', shikimori: 'ok' })
    expect(Object.keys((await driveDoc(root))!.titles![ID].watch!)).toEqual(['1', '2', '3'])
    a.store.set('attachedLibraries', {})

    // 2. B claims it and watches 4–6.
    const b = makePc({ user: null, installId: 'pc-b' })
    await b.attach(root, { claim: true })
    await b.runner.runAll('attach')
    b.store.set('watchProgress', {
      ...(b.store.get('watchProgress') as object),
      ...rows([4, 5, 6], T0 + 5000)
    })
    await b.runner.runAll('manual')
    expect(Object.keys((await driveDoc(root))!.titles![ID].watch!).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6'
    ])
    expect(b.store.get('shikimoriUpdateQueue')).toEqual([])

    // Meanwhile the owner's other PC set score 8 on the drive (a claim PC can't edit a
    // score), and A set 7 on Shikimori.
    const now = (await driveDoc(root))! as SyncDoc
    now.titles[ID].rate!.score = { value: 8, at: T0 + 6000, origin: 'pc-a2' }
    await writeDrive(root, now)
    server.set(MAL, { score: 7 })
    a.store.set('shikimoriUserRates', [
      cacheEntry(MAL, ANIME, vals({ episodes: 3, score: 7 }), server.clock)
    ])

    // 3–4. The drive comes back to A, and A merges.
    await a.attach(root)
    const vs = vi.spyOn(a.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    await a.runner.runAll('plug')
    const wp = a.store.get('watchProgress') as Record<string, { watched: boolean }>
    expect([1, 2, 3, 4, 5, 6].every((e) => wp[`${ID}:${e}`]?.watched)).toBe(true)
    const q = a.store.get('shikimoriUpdateQueue') as {
      after: { episodes: number }
      fields: string[]
    }[]
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ after: { episodes: 6, score: 7 }, fields: ['episodes'] })
    const records = JSON.parse(
      fs.readFileSync(path.join(a.userData, 'sync-state', 'conflicts.json'), 'utf8')
    ).records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      animeId: ID,
      fieldPath: 'rate.score',
      parties: { local: 7, [`library:${libraryId}`]: 8 }
    })
    vs.mockRestore()
    await a.runner.runAll('manual')
    expect(
      JSON.parse(fs.readFileSync(path.join(a.userData, 'sync-state', 'conflicts.json'), 'utf8'))
        .records
    ).toHaveLength(1)
  })
})

describe('the real AniList provider, codec and drain as the owner tracker’s leg (#715)', () => {
  it('the leg reads the real cache rows, queues the raise, and the drain writes progress 6 and advances its base', async () => {
    const MEDIA = 109001
    const world = createAniListWorld({
      entries: [
        {
          id: 777,
          mediaId: MEDIA,
          idMal: MAL,
          status: 'CURRENT',
          score: 85,
          progress: 5,
          repeat: 0,
          updatedAt: 1
        }
      ]
    })
    try {
      const owner = { provider: 'anilist', userId: String(ALICE.id) }
      let sync!: AniListSyncService
      let vault!: ReturnType<typeof createCredentialVault>
      const pc = makePc({
        user: null,
        store: {
          watchProgress: rows([1, 2, 3, 4, 5], T0),
          anilistUser: ALICE,
          anilistUpdateQueue: [],
          anilistParkedQueues: {},
          anilistUserRates: []
        },
        wire: (store) => {
          vault = createCredentialVault({
            store,
            safeStorage: createFakeSafeStorage({ async: false }).holder,
            warn: () => {}
          })
          const provider = createAniListProvider({
            store: store as never,
            vault,
            limiter: createAniListLimiter({ deadTokenError }),
            onSessionExpired: () => {},
            log: { log: () => {}, warn: () => {} }
          })
          sync = createAniListSyncService(provider, {
            store: store as never,
            broadcast: () => {},
            syncStatusChannel: 's',
            offlineQueueChangedChannel: 'q',
            rateUpdatedChannel: 'r',
            ratesRefreshedChannel: 'f'
          })
          return {
            legs: [
              { sync: sync as unknown as TrackerSyncService<unknown, unknown>, provider } as never
            ]
          }
        }
      })
      await vault.write('anilistCredentials', { accessToken: 'tok-alice', expiresAt: null })
      await sync.refreshRates({ keepQueued: false })
      const W = (eps: number[], at: number, origin: string) =>
        Object.fromEntries(eps.map((e) => [String(e), watch(true, at + e, 0, origin)]))
      const { root, libraryId } = await makeLibrary({
        tracker: owner,
        doc: doc({
          [ID]: {
            watch: { ...W([1, 2, 3, 4, 5], T0, 'pc-owner'), ...W([6], T0 + 1000, 'pc-claim') },
            rate: rate({ episodes: 5, score: 9 }, T0, 'pc-owner', MAL)
          }
        })
      })
      await pc.attach(root)
      expect(pc.attached.get(libraryId)?.role).toBe('owner')
      await pc.bases.write(`library-${libraryId}`, {
        stateGeneration: (await readLibrary(root).then((r) =>
          r.status === 'ok' ? r.manifest.stateGeneration : null
        )) as number,
        doc: doc({
          [ID]: {
            watch: W([1, 2, 3, 4, 5], T0, 'pc-owner'),
            rate: rate({ episodes: 5, score: 9 }, T0, 'pc-owner', MAL)
          }
        })
      })
      const res = await pc.runner.runAll('manual')
      expect(res.libraries[0]).toMatchObject({
        drive: 'ok',
        tracker: { id: 'anilist', status: 'ok' }
      })
      await sync.drainNow()
      await pc.runner.quiesce()
      expect(world.entries.get(MEDIA)).toMatchObject({ progress: 6, score: 85 })
      // Only the changed field went out: the POINT_100 85 (an app 9) is never rewritten.
      expect(world.saves().at(-1)).toMatchObject({ mediaId: MEDIA, progress: 6 })
      expect(world.saves().at(-1)).not.toHaveProperty('scoreRaw')
      expect(
        fs.existsSync(path.join(pc.userData, 'sync-pending', `anilist-${ALICE.id}.json`))
      ).toBe(false)
      const base = await pc.bases.read(`anilist-${ALICE.id}`)
      expect(base!.doc.titles[ID].rate!.episodes).toMatchObject({ value: 6, origin: 'anilist' })
      expect(pc.store.get('shikimoriUpdateQueue')).toEqual([])
    } finally {
      world.server.restore()
    }
  })
})

describe('an AniList-owned library across an owner PC and a claim PC (#715)', () => {
  const KEY = `${ID}:1`
  const alRow = (episodes: number, at: number) => ({
    malId: MAL,
    remoteId: ANILIST_MEDIA_IDS[MAL] * 10,
    values: vals({ episodes }),
    updatedAt: at,
    smotretAnime: { id: ANIME }
  })
  const readRecords = (userData: string, file: string): SyncConflictRecord[] | null => {
    const p = path.join(userData, 'sync-state', file)
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).records : null
  }

  async function exportAndClaim() {
    const { root, libraryId } = await makeLibrary({ tracker: ANILIST_5 })
    const a = makePc({
      user: null,
      installId: 'pc-a',
      anilist: {},
      store: { watchProgress: rows([1, 2, 3], T0), anilistUserRates: [alRow(3, T0)] }
    })
    a.anilist!.fake.set(MAL, { episodes: 3 }, { at: T0 })
    await a.attach(root)
    const first = await a.runner.runAll('attach')
    expect(first.libraries[0]).toMatchObject({
      drive: 'ok',
      shikimori: 'skipped',
      tracker: { id: 'anilist', status: 'ok' }
    })
    a.store.set('attachedLibraries', {})
    // A no-account PC, with AniList's instance there as in `index.ts`, signed out.
    const b = makePc({ user: null, installId: 'pc-b', anilist: { user: null } })
    await b.attach(root, { claim: true })
    expect(b.attached.get(libraryId)?.role).toBe('claim')
    await b.runner.runAll('attach')
    return { root, libraryId, a, b }
  }

  it('the claim PC’s watches reach the drive, and the owner PC raises AniList, never Shikimori', async () => {
    const { root, a, b } = await exportAndClaim()
    b.store.set('watchProgress', {
      ...(b.store.get('watchProgress') as object),
      ...rows([4, 5, 6], T0 + 5000)
    })
    const rb = await b.runner.runAll('manual')
    expect(rb.libraries[0]).toMatchObject({
      drive: 'ok',
      tracker: { id: 'anilist', status: 'skipped', reason: 'claim' }
    })
    expect(Object.keys((await driveDoc(root))!.titles![ID].watch!).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6'
    ])
    expect(b.store.get('shikimoriUpdateQueue')).toEqual([])

    await a.attach(root)
    const drain = vi.spyOn(a.anilist!.sync, 'syncQueue').mockResolvedValue(undefined)
    await a.runner.runAll('plug')
    const q = a.store.get('anilistUpdateQueue') as {
      after: { episodes: number }
      fields: string[]
    }[]
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ after: { episodes: 6 }, fields: ['episodes'] })
    expect(a.store.get('shikimoriUpdateQueue')).toEqual([])
    drain.mockRestore()
    await a.anilist!.sync.drainNow()
    await a.runner.quiesce()
    expect(a.anilist!.fake.rows.get(MAL)!.values.episodes).toBe(6)
  })

  it('a watch conflict on the claim PC lands in conflicts-anilist.json; conflicts.json stays absent', async () => {
    const { root, b } = await exportAndClaim()
    // The owner's other PC re-watches episode 1 on the drive.
    const now = (await driveDoc(root))! as SyncDoc
    now.titles[ID].watch!['1'].watched = { value: true, at: T0 + 5000, origin: 'pc-a2' }
    await writeDrive(root, now, trackerActor(ANILIST_5, 'pc-a2'))
    // B unwatches episode 1 after its base.
    const wp = b.store.get('watchProgress') as Record<string, ReturnType<typeof progressRow>>
    b.store.set('watchProgress', {
      ...wp,
      [KEY]: {
        ...wp[KEY],
        watched: false,
        watchedAt: undefined,
        updatedAt: T0 + 6000,
        sync: { position: wp[KEY].sync.position, watched: { at: T0 + 6000, origin: 'pc-b' } }
      }
    })
    await b.runner.runAll('manual')
    const records = readRecords(b.userData, 'conflicts-anilist.json')
    expect(records).toEqual([
      expect.objectContaining({ ownerScope: ANILIST_5.userId, fieldPath: 'watch.1.watched' })
    ])
    expect(readRecords(b.userData, 'conflicts.json')).toBeNull()
  })
})
