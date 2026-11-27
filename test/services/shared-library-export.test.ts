// The export service's units (#574): the plan (selection → files and missing
// items), the target table, the free-space check against an injected
// `statfs`, the per-file playback hold against a fake presence service, the
// naming of items appended to a library, and the `meta` re-export merge.

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  OWNER_NOT_OFFERED,
  SEPARATE_NEWER_MINOR,
  fitsFreeSpace,
  requiredBytes
} from '../../src/shared/shared-library-export'
import { renderIndexHtml } from '../../src/main/lib/shared-library/index-html'

// The real page; the spy sees the job's in-memory base after each checkpoint (#713).
vi.mock('../../src/main/lib/shared-library/index-html', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/lib/shared-library/index-html')>()
  return { ...real, renderIndexHtml: vi.fn(real.renderIndexHtml) }
})
import {
  LAYOUT_MINORS,
  UNKNOWN_FIELDS,
  serializeMeta,
  setUnknownFields
} from '../../src/main/lib/shared-library/format'
import { nameItems } from '../../src/main/lib/shared-library/naming'
import { LIBRARY_DIR, readMeta } from '../../src/main/lib/shared-library/read'
import { JOBS_DIR } from '../../src/main/services/shared-library-export'
import { nodeFs } from '../../src/main/services/shared-library-export/copy'
import type { JobRecord } from '../../src/main/services/shared-library-export/job'
import {
  STALE_EPISODE_LIST,
  classifyTarget,
  type ClassifyWho
} from '../../src/main/services/shared-library-export/plan'
import {
  buildMeta,
  mergeMeta,
  writeTitleSnapshot
} from '../../src/main/services/shared-library-export/snapshot'
import {
  makeExportEnv,
  scan,
  seedLibrary,
  sel,
  type ExportEnv
} from '../helpers/shared-library-export'

const OTHER_LIB = '9c2d4e6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f'

let env: ExportEnv
afterEach(() => env?.cleanup())

const exists = async (p: string): Promise<boolean> => fs.existsSync(p)

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('the plan: selection → files and missing items', () => {
  it('resolves hot, cold and an unmerged pair, and lists missing and busy items', async () => {
    env = makeExportEnv({
      mergeStatus: (tid) => (tid === 14 ? 'merging' : tid === 15 ? 'deferred' : null)
    })
    env.addEpisode({ animeId: 7, title: 'Show', episodeInt: '1', translationId: 11 })
    env.addEpisode({ animeId: 7, title: 'Show', episodeInt: '2', translationId: 12, where: 'cold' })
    env.addEpisode({
      animeId: 7,
      title: 'Show',
      episodeInt: '3',
      translationId: 13,
      ext: 'mp4',
      subtitle: true
    })
    env.addEpisode({ animeId: 7, title: 'Show', episodeInt: '4', translationId: 14 })
    env.addEpisode({ animeId: 7, title: 'Show', episodeInt: '5', translationId: 15 })
    const gone = env.addEpisode({ animeId: 7, title: 'Show', episodeInt: '6', translationId: 16 })
    fs.unlinkSync(gone.video)
    env.store.set('animeCache', {
      7: {
        animeDetail: {
          id: 7,
          episodes: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
            id: n,
            episodeInt: String(n),
            episodeFull: `${n} серия`,
            episodeType: 'tv',
            isActive: 1
          }))
        }
      }
    })

    const plan = await env.svc.plan({ animeIds: [7], target: null, name: '' })
    expect(plan.target).toBeNull()
    expect(plan.titles).toHaveLength(1)
    const t = plan.titles[0]
    expect(t.name).toBe('Show')
    const eps = t.translations.flatMap((tr) => tr.episodes)
    const state = Object.fromEntries(eps.map((e) => [e.episodeInt, e.state]))
    expect(state).toEqual({
      '1': 'ready',
      '2': 'ready',
      '3': 'ready',
      '4': 'busy',
      '5': 'busy',
      '6': 'missing'
    })
    const three = eps.find((e) => e.episodeInt === '3')!
    expect(three.unmerged).toBe(true)
    expect(three.size).toBe(
      fs.statSync(path.join(env.hot, 'Show', 'Show - 03 [Studio].mp4')).size +
        fs.statSync(path.join(env.hot, 'Show', 'Show - 03 [Studio].ass')).size
    )
    expect(eps.find((e) => e.episodeInt === '2')!.size).toBe(
      fs.statSync(path.join(env.cold, 'Show', 'Show - 02 [Studio].mkv')).size
    )
    expect(eps.find((e) => e.episodeInt === '1')!.label).toBe('1 серия')
    // No cached translations for it: it can't be pre-fetched (#577).
    expect(t.notDownloaded).toEqual([
      { episodeInt: '7', label: '7 серия', options: [], unavailable: STALE_EPISODE_LIST }
    ])

    // A start copies only the ready ones and counts the rest as missing.
    const r = await env.svc.start({
      selection: sel(...eps.map((e) => e.key)),
      target: env.drive,
      name: 'Lib'
    })
    if (!r.ok) throw new Error(r.reason)
    expect(r.job.filesTotal).toBe(4)
    expect(r.job.missing).toBe(3)
    await env.svc.settled(r.job.jobId)
  })

  it('every downloaded title when animeIds is null, sorted by name', async () => {
    env = makeExportEnv()
    env.addEpisode({ animeId: 2, title: 'Zeta', episodeInt: '1', translationId: 21 })
    env.addEpisode({ animeId: 1, title: 'Alpha', episodeInt: '1', translationId: 11 })
    const plan = await env.svc.plan({ animeIds: null, target: null, name: '' })
    expect(plan.titles.map((t) => t.name)).toEqual(['Alpha', 'Zeta'])
  })
})

describe('titles with no downloadedAnime record (#655)', () => {
  const dropRecord = (id: number): void => {
    const anime = env.store.get('downloadedAnime') as Record<string, unknown>
    delete anime[id]
    env.store.set('downloadedAnime', anime)
  }
  const record = (id: number, romaji: string): AnimeSearchResult => ({
    id,
    title: romaji,
    titles: { romaji },
    posterUrlSmall: '',
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV Series',
    year: 2024,
    season: 'spring'
  })

  it('a title whose record is gone but recentAnimeMeta names it: listed under its name, its files ready, and exported', async () => {
    env = makeExportEnv()
    env.addEpisode({ animeId: 1, title: 'Alpha', episodeInt: '1', translationId: 11 })
    const gamma = env.addEpisode({ animeId: 9, title: 'Gamma', episodeInt: '1', translationId: 91 })
    dropRecord(9)
    env.store.set('recentAnimeMeta', { 9: record(9, 'Gamma') })

    const plan = await env.svc.plan({ animeIds: null, target: null, name: '' })
    expect(plan.titles.map((t) => t.name)).toEqual(['Alpha', 'Gamma'])
    const ep = plan.titles[1].translations[0].episodes[0]
    expect(ep).toMatchObject({
      key: gamma.key,
      state: 'ready',
      size: fs.statSync(gamma.video).size
    })

    const r = await env.svc.start({ selection: sel(gamma.key), target: env.drive, name: 'Lib' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.job.filesTotal).toBe(1)
    expect(r.job.missing).toBe(0)
    await env.svc.settled(r.job.jobId)
    const copied = Object.keys(scan(path.join(env.drive, 'Lib'))).filter(
      (p) => !p.startsWith(LIBRARY_DIR)
    )
    expect(copied).toHaveLength(1)
    expect(copied[0].split(path.sep)[0]).toBe('Gamma')
    const job = JSON.parse(
      fs.readFileSync(path.join(env.userData, JOBS_DIR, `${r.job.jobId}.json`), 'utf8')
    ) as JobRecord
    expect(job.titles).toEqual([{ animeId: 9, name: 'Gamma' }])
  })

  it('a title deleted from the Library (record and folder gone, entries left): not listed', async () => {
    env = makeExportEnv()
    env.addEpisode({ animeId: 1, title: 'Alpha', episodeInt: '1', translationId: 11 })
    env.addEpisode({ animeId: 5, title: 'Deleted', episodeInt: '1', translationId: 51 })
    env.addEpisode({ animeId: 5, title: 'Deleted', episodeInt: '2', translationId: 51 })
    fs.rmSync(path.join(env.hot, 'Deleted'), { recursive: true })
    dropRecord(5)

    const plan = await env.svc.plan({ animeIds: null, target: null, name: '' })
    expect(plan.titles.map((t) => t.animeId)).toEqual([1])
  })

  it('a record-less starred title with cached details: its stale entry becomes a not-downloaded episode', async () => {
    env = makeExportEnv()
    env.store.set('library', { 6: record(6, 'Starred') })
    env.store.set('animeCache', {
      6: {
        animeDetail: {
          ...record(6, 'Starred'),
          episodes: [1, 2].map((n) => ({
            id: 600 + n,
            episodeInt: String(n),
            episodeFull: `${n} серия`,
            episodeType: 'tv',
            isActive: 1
          }))
        }
      }
    })
    env.store.set('downloadedEpisodes', {
      '6:1:61': { translationType: 'subRu', author: 'Studio', quality: 720, translationId: 61 }
    })

    const plan = await env.svc.plan({ animeIds: null, target: null, name: '' })
    expect(plan.titles).toHaveLength(1)
    expect(plan.titles[0]).toMatchObject({ animeId: 6, name: 'Starred', translations: [] })
    expect(plan.titles[0].notDownloaded.map((e) => e.episodeInt)).toEqual(['1', '2'])
  })

  it('a record-less title renamed since it was cached (#674): its file under the recentAnimeMeta name is ready, and exported under that folder', async () => {
    env = makeExportEnv()
    const old = env.addEpisode({
      animeId: 9,
      title: 'Old Name',
      episodeInt: '1',
      translationId: 91
    })
    dropRecord(9)
    env.store.set('recentAnimeMeta', { 9: record(9, 'Old Name') })
    env.store.set('animeCache', {
      9: {
        animeDetail: {
          ...record(9, 'New Name'),
          episodes: [
            { id: 901, episodeInt: '1', episodeFull: '1 серия', episodeType: 'tv', isActive: 1 }
          ]
        }
      }
    })

    const plan = await env.svc.plan({ animeIds: null, target: null, name: '' })
    expect(plan.titles).toHaveLength(1)
    expect(plan.titles[0]).toMatchObject({ animeId: 9, name: 'New Name', notDownloaded: [] })
    expect(plan.titles[0].translations.flatMap((t) => t.episodes)).toEqual([
      expect.objectContaining({ key: old.key, state: 'ready', size: fs.statSync(old.video).size })
    ])

    const r = await env.svc.start({ selection: sel(old.key), target: env.drive, name: 'Lib' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.job.missing).toBe(0)
    await env.svc.settled(r.job.jobId)
    const copied = Object.keys(scan(path.join(env.drive, 'Lib'))).filter(
      (p) => !p.startsWith(LIBRARY_DIR)
    )
    expect(copied).toHaveLength(1)
    expect(copied[0].split(path.sep)[0]).toBe('Old Name')
  })

  // #676: auto-downloads land under the subscription's `animeName`, which no
  // record holds once every record is renamed.
  const subscribe = (id: number, animeName: string): void => {
    env.store.set('autoDownloadSubscriptions', {
      [id]: {
        animeId: id,
        malId: id * 10,
        animeName,
        subscribedAt: 0,
        lastEnqueuedEpisodeInt: 0,
        lastCheckedAt: 0,
        initialEpisodesAired: 0
      } satisfies AutoDownloadSubscription
    })
  }
  const cachedAs = (id: number, romaji: string, eps: string[]): void => {
    env.store.set('animeCache', {
      [id]: {
        animeDetail: {
          ...record(id, romaji),
          episodes: eps.map((n) => ({
            id: id * 100 + Number(n),
            episodeInt: n,
            episodeFull: `${n} серия`,
            episodeType: 'tv',
            isActive: 1
          }))
        }
      }
    })
  }
  const copiedTops = async (keys: string[]): Promise<string[]> => {
    const r = await env.svc.start({ selection: sel(...keys), target: env.drive, name: 'Lib' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.job.missing).toBe(0)
    await env.svc.settled(r.job.jobId)
    return Object.keys(scan(path.join(env.drive, 'Lib')))
      .filter((p) => !p.startsWith(LIBRARY_DIR))
      .map((p) => p.split(path.sep)[0])
      .sort()
  }

  it('a record-less title auto-downloaded under its subscription name, every record renamed since (#676): ready, and exported under the subscription folder', async () => {
    env = makeExportEnv()
    const old = env.addEpisode({
      animeId: 9,
      title: 'Old Name',
      episodeInt: '1',
      translationId: 91
    })
    dropRecord(9)
    env.store.set('recentAnimeMeta', { 9: record(9, 'New Name') })
    cachedAs(9, 'New Name', ['1'])
    subscribe(9, 'Old Name')

    const plan = await env.svc.plan({ animeIds: null, target: null, name: '' })
    expect(plan.titles).toHaveLength(1)
    expect(plan.titles[0]).toMatchObject({ animeId: 9, name: 'New Name', notDownloaded: [] })
    expect(plan.titles[0].translations.flatMap((t) => t.episodes)).toEqual([
      expect.objectContaining({ key: old.key, state: 'ready', size: fs.statSync(old.video).size })
    ])

    expect(await copiedTops([old.key])).toEqual(['Old Name'])
  })

  it('a recorded title renamed since: an episode under the subscription name and one under the record name are both ready, each exported under its own folder (#676)', async () => {
    env = makeExportEnv()
    const old = env.addEpisode({
      animeId: 9,
      title: 'Old Name',
      episodeInt: '1',
      translationId: 91
    })
    const now = env.addEpisode({
      animeId: 9,
      title: 'New Name',
      episodeInt: '2',
      translationId: 91
    })
    env.store.set('downloadedAnime', { 9: record(9, 'New Name') })
    env.store.set('recentAnimeMeta', { 9: record(9, 'New Name') })
    cachedAs(9, 'New Name', ['1', '2'])
    subscribe(9, 'Old Name')

    const plan = await env.svc.plan({ animeIds: null, target: null, name: '' })
    expect(plan.titles).toHaveLength(1)
    expect(plan.titles[0]).toMatchObject({ animeId: 9, name: 'New Name', notDownloaded: [] })
    expect(plan.titles[0].translations.flatMap((t) => t.episodes)).toEqual([
      expect.objectContaining({ key: old.key, state: 'ready', size: fs.statSync(old.video).size }),
      expect.objectContaining({ key: now.key, state: 'ready', size: fs.statSync(now.video).size })
    ])

    expect(await copiedTops([old.key, now.key])).toEqual(['New Name', 'Old Name'])
  })

  it('the subscription name alone is never the first name: a title with no record name stays out of the tree (#676)', async () => {
    env = makeExportEnv()
    env.addEpisode({ animeId: 9, title: 'Old Name', episodeInt: '1', translationId: 91 })
    dropRecord(9)
    env.store.set('recentAnimeMeta', {})
    env.store.set('animeCache', {})
    subscribe(9, 'Old Name')

    const plan = await env.svc.plan({ animeIds: null, target: null, name: '' })
    expect(plan.titles).toEqual([])
  })
})

/** A Shikimori-only PC (#714's `ClassifyWho`), or one logged out with `null`. */
const shikiOnly = (id: number | null): ClassifyWho =>
  id === null
    ? { accounts: { shikimoriUserId: null, trackerAccounts: [] }, owner: null, keep: [] }
    : {
        accounts: {
          shikimoriUserId: id,
          trackerAccounts: [{ provider: 'shikimori', userId: String(id) }]
        },
        owner: { shikimoriId: id, nickname: 'me' },
        keep: [{ shikimoriId: id, nickname: 'me' }]
      }

describe('the target table', () => {
  const ME = 4242

  it('no library: a new one at <dir>/<name>', async () => {
    env = makeExportEnv()
    const t = await classifyTarget(env.drive, 'Trip', shikiOnly(ME), exists)
    expect(t).toMatchObject({ kind: 'new', root: path.join(env.drive, 'Trip'), blocked: null })
  })

  it('the picked folder is itself a library: that library', async () => {
    env = makeExportEnv()
    const root = path.join(env.drive, 'Stick')
    await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Stick' })
    const t = await classifyTarget(root, 'whatever', shikiOnly(ME), exists)
    expect(t).toMatchObject({ kind: 'add', root, libraryName: 'Stick' })
  })

  it('a Videos-only library: added to, by anyone, logged out included', async () => {
    env = makeExportEnv()
    await seedLibrary(path.join(env.drive, 'Trip'), { libraryId: OTHER_LIB, name: 'Trip' })
    for (const who of [ME, null]) {
      const t = await classifyTarget(env.drive, 'Trip', shikiOnly(who), exists)
      expect(t.kind).toBe('add')
      expect(t.blocked).toBeNull()
    }
  })

  it('an own With metadata library: routed to With metadata in either mode (#586)', async () => {
    env = makeExportEnv()
    await seedLibrary(path.join(env.drive, 'Trip'), {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: { shikimoriId: ME, nickname: 'me' }
    })
    for (const mode of ['videos', 'metadata'] as const) {
      const t = await classifyTarget(env.drive, 'Trip', shikiOnly(ME), exists, { mode })
      expect(t).toMatchObject({ kind: 'own-metadata', mode: 'metadata', blocked: null })
      expect(t.manifest?.libraryId).toBe(OTHER_LIB)
    }
  })

  it('a Videos-only library With metadata: an upgrade, for any logged-in user (#586)', async () => {
    env = makeExportEnv()
    await seedLibrary(path.join(env.drive, 'Trip'), { libraryId: OTHER_LIB, name: 'Trip' })
    const t = await classifyTarget(env.drive, 'Trip', shikiOnly(ME), exists, { mode: 'metadata' })
    expect(t).toMatchObject({ kind: 'upgrade', mode: 'metadata', blocked: null })
    expect(t.manifest?.libraryId).toBe(OTHER_LIB)
  })

  it('a library this PC claimed: never written, in either mode; a sibling (#586)', async () => {
    env = makeExportEnv()
    await seedLibrary(path.join(env.drive, 'Trip'), {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: { shikimoriId: 777, nickname: 'friend' }
    })
    const claimed = (id: string): boolean => id === OTHER_LIB
    for (const [who, mode] of [
      [null, 'videos'],
      [ME, 'metadata']
    ] as const) {
      const t = await classifyTarget(env.drive, 'Trip', shikiOnly(who), exists, { mode, claimed })
      expect(t).toMatchObject({
        kind: 'claimed',
        mode,
        ownerNickname: 'friend',
        root: path.join(env.drive, 'Trip (2)'),
        manifest: null
      })
    }
    // Not claimed here: foreign.
    const t = await classifyTarget(env.drive, 'Trip', shikiOnly(ME), exists, { mode: 'metadata' })
    expect(t.kind).toBe('foreign')
  })

  it('With metadata next to a foreign library: an earlier own sibling is added to, a Videos-only one upgraded (#586)', async () => {
    env = makeExportEnv()
    await seedLibrary(path.join(env.drive, 'Trip'), {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: { shikimoriId: 777, nickname: 'friend' }
    })
    await seedLibrary(path.join(env.drive, 'Trip (2)'), {
      libraryId: '2a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      name: 'Trip',
      owner: { shikimoriId: ME, nickname: 'me' }
    })
    const own = await classifyTarget(env.drive, 'Trip', shikiOnly(ME), exists, { mode: 'metadata' })
    expect(own).toMatchObject({
      kind: 'own-metadata',
      root: path.join(env.drive, 'Trip (2)'),
      ownerNickname: 'friend'
    })
    // In Videos only, the own sibling is skipped as before (#574).
    const videos = await classifyTarget(env.drive, 'Trip', shikiOnly(ME), exists, {
      mode: 'videos'
    })
    expect(videos).toMatchObject({ kind: 'foreign', root: path.join(env.drive, 'Trip (3)') })

    fs.rmSync(path.join(env.drive, 'Trip (2)'), { recursive: true })
    await seedLibrary(path.join(env.drive, 'Trip (2)'), {
      libraryId: '2a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      name: 'Trip'
    })
    const up = await classifyTarget(env.drive, 'Trip', shikiOnly(ME), exists, { mode: 'metadata' })
    expect(up).toMatchObject({ kind: 'upgrade', root: path.join(env.drive, 'Trip (2)') })
  })

  it('a With metadata library with any other owner (or seen logged out): a sibling', async () => {
    env = makeExportEnv()
    await seedLibrary(path.join(env.drive, 'Trip'), {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: { shikimoriId: 777, nickname: 'friend' }
    })
    fs.mkdirSync(path.join(env.drive, 'Trip (2)'))
    for (const who of [ME, null]) {
      const t = await classifyTarget(env.drive, 'Trip', shikiOnly(who), exists)
      expect(t).toMatchObject({
        kind: 'foreign',
        ownerNickname: 'friend',
        root: path.join(env.drive, 'Trip (3)'),
        blocked: null
      })
    }
  })

  it('next to a foreign library: the first Videos-only sibling in name order is added to; others are skipped', async () => {
    env = makeExportEnv()
    const friend = { shikimoriId: 777, nickname: 'friend' }
    await seedLibrary(path.join(env.drive, 'Trip'), {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: friend
    })
    // (2) another foreign library, (3) a plain folder, (4) this user's own
    // With metadata library, (5) a Videos-only library: (5) is the one.
    await seedLibrary(path.join(env.drive, 'Trip (2)'), {
      libraryId: '2a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      name: 'Trip',
      owner: { shikimoriId: 888, nickname: 'other' }
    })
    fs.mkdirSync(path.join(env.drive, 'Trip (3)'))
    await seedLibrary(path.join(env.drive, 'Trip (4)'), {
      libraryId: '4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      name: 'Trip',
      owner: { shikimoriId: ME, nickname: 'me' }
    })
    await seedLibrary(path.join(env.drive, 'Trip (5)'), {
      libraryId: '5a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      name: 'Trip'
    })
    const t = await classifyTarget(env.drive, 'Trip', shikiOnly(ME), exists)
    expect(t).toMatchObject({
      kind: 'add',
      root: path.join(env.drive, 'Trip (5)'),
      ownerNickname: 'friend',
      blocked: null
    })
    expect(t.manifest?.libraryId).toBe('5a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')

    // With no Videos-only sibling, the first free name.
    fs.rmSync(path.join(env.drive, 'Trip (5)'), { recursive: true })
    const fresh = await classifyTarget(env.drive, 'Trip', shikiOnly(ME), exists)
    expect(fresh).toMatchObject({ kind: 'foreign', root: path.join(env.drive, 'Trip (5)') })
  })

  it('a library this version can’t write: blocked with the reader’s message', async () => {
    env = makeExportEnv()
    const root = path.join(env.drive, 'Trip')
    fs.mkdirSync(path.join(root, LIBRARY_DIR), { recursive: true })
    fs.writeFileSync(
      path.join(root, LIBRARY_DIR, 'manifest.json'),
      JSON.stringify({ layoutVersion: 3, layoutMinor: 0, libraryId: OTHER_LIB })
    )
    const t = await classifyTarget(env.drive, 'Trip', shikiOnly(ME), exists)
    expect(t.kind).toBe('read-only')
    expect(t.blocked).toMatch(/newer version/)
  })
})

describe('a layout v2 library (#713)', () => {
  const ME = 4242
  // The v2 `userId` equals this PC's Shikimori id numerically: still foreign.
  const ALICE = { provider: 'anilist', userId: String(ME), nickname: 'alice' }

  it('is foreign for a Shikimori PC and an account-less one, in either mode: a sibling', async () => {
    env = makeExportEnv()
    await seedLibrary(path.join(env.drive, 'Trip'), {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: ALICE
    })
    for (const who of [ME, null]) {
      for (const mode of ['videos', 'metadata'] as const) {
        const t = await classifyTarget(env.drive, 'Trip', shikiOnly(who), exists, { mode })
        expect(t, `${who} ${mode}`).toMatchObject({
          kind: 'foreign',
          ownerNickname: 'alice',
          root: path.join(env.drive, 'Trip (2)'),
          blocked: null,
          manifest: null
        })
      }
    }
  })

  it('an account-less Videos only export goes to the sibling and never writes the v2 library', async () => {
    env = makeExportEnv()
    const v2 = path.join(env.drive, 'Trip')
    await seedLibrary(v2, { libraryId: OTHER_LIB, name: 'Trip', owner: ALICE })
    const before = scan(v2)
    const { key } = env.addEpisode({
      animeId: 7,
      title: 'Show',
      episodeInt: '1',
      translationId: 11
    })
    const res = await env.svc.start({ selection: sel(key), target: env.drive, name: 'Trip' })
    expect(res.ok).toBe(true)
    if (res.ok) await env.svc.settled(res.job.jobId)
    expect(scan(v2)).toEqual(before)
    expect(fs.existsSync(path.join(env.drive, 'Trip (2)', LIBRARY_DIR, 'manifest.json'))).toBe(true)
  })

  it('the job’s in-memory base after each checkpoint is layoutVersionFor(owner): 1 in this slice', async () => {
    env = makeExportEnv()
    const spy = vi.mocked(renderIndexHtml)
    spy.mockClear()
    const keys = ['1', '2', '3'].map(
      (ep) => env.addEpisode({ animeId: 7, title: 'Show', episodeInt: ep, translationId: 11 }).key
    )
    const res = await env.svc.start({ selection: sel(...keys), target: env.drive, name: 'Lib' })
    expect(res.ok).toBe(true)
    if (res.ok) await env.svc.settled(res.job.jobId)
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    for (const [base] of spy.mock.calls) expect(base.layoutVersion).toBe(1)
  })
})

describe('the export owner picker (#714)', () => {
  const ME = { id: 4242, nickname: 'me', avatar: null }
  const AL = { id: 9, nickname: 'al', avatar: null }
  const FRIEND_LIB = '7a7b7c7d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'
  const stateOk = async (t: { libraryId: string }) =>
    ({
      libraryId: t.libraryId,
      drive: 'ok',
      shikimori: 'skipped',
      counts: { applied: 0, conflicts: 0, clamped: 0 },
      waitingMalIds: [],
      rewatchesSuperseded: 0
    }) as SyncLibraryResult

  /**
   * A Shikimori + AniList PC, AniList primary. `seam` offers AniList as an
   * owner too, as #715 will; the actor then holds both accounts.
   */
  function pc(seam: boolean, users: { shikimori?: boolean; anilist?: boolean } = {}): void {
    const shikimori = users.shikimori ?? true
    const anilist = users.anilist ?? true
    const accounts = [
      ...(shikimori ? [{ provider: 'shikimori', userId: String(ME.id) }] : []),
      ...(anilist ? [{ provider: 'anilist', userId: String(AL.id) }] : [])
    ]
    env = makeExportEnv(
      {
        ...(seam ? { ownerProviders: ['shikimori', 'anilist'] as const } : {}),
        writeLibraryState: stateOk,
        actor: () => ({
          installId: 'pc-export',
          appVersion: '7.0.0',
          shikimoriUserId: shikimori ? ME.id : null,
          claim: null,
          trackerAccounts: accounts
        })
      },
      { shikimoriUser: shikimori ? ME : null }
    )
    if (anilist) env.store.set('anilistUser', AL)
    env.store.set('trackerPrimary', anilist ? 'anilist' : 'shikimori')
  }
  const episode = (): string =>
    env.addEpisode({ animeId: 7, title: 'Show', episodeInt: '1', translationId: 11 }).key
  const plan = (over: Partial<ExportPlanRequest> = {}) =>
    env.svc.plan({ animeIds: [7], target: env.drive, name: 'Trip', mode: 'metadata', ...over })
  const manifestAt = (root: string) =>
    JSON.parse(fs.readFileSync(path.join(root, LIBRARY_DIR, 'manifest.json'), 'utf8'))
  async function startOk(req: Partial<ExportStartRequest>): Promise<void> {
    const res = await env.svc.start({
      selection: sel(episode()),
      target: env.drive,
      name: 'Trip',
      mode: 'metadata',
      ...req
    })
    if (!res.ok) throw new Error(res.reason)
    await env.svc.settled(res.job.jobId)
  }

  it('until #715 the plan offers Shikimori only, and defaults to it even with AniList primary', async () => {
    pc(false)
    const p = await env.svc.plan({ animeIds: [7], target: null, name: '' })
    expect(p).toMatchObject({
      canExportMetadata: true,
      nickname: 'me',
      owners: [{ provider: 'shikimori', nickname: 'me', olderVersions: true }],
      defaultOwner: 'shikimori'
    })
    // An AniList-only PC can't export With metadata yet.
    pc(false, { shikimori: false })
    expect(await env.svc.plan({ animeIds: [7], target: null, name: '' })).toMatchObject({
      canExportMetadata: false,
      nickname: null,
      owners: [],
      defaultOwner: null
    })
  })

  it('with AniList offered (the #715 seam): both owners, the primary first by default, the older-versions flag on Shikimori only', async () => {
    pc(true)
    const p = await env.svc.plan({ animeIds: [7], target: null, name: '' })
    expect(p.owners).toEqual([
      { provider: 'shikimori', nickname: 'me', olderVersions: true },
      { provider: 'anilist', nickname: 'al', olderVersions: false }
    ])
    expect(p).toMatchObject({ defaultOwner: 'anilist', nickname: 'al' })
  })

  it('a re-export keeps the existing owner: an own Shikimori library with no pick is own-metadata, its owner reported and kept', async () => {
    pc(true)
    const root = path.join(env.drive, 'Trip')
    await seedLibrary(root, {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: { shikimoriId: ME.id, nickname: 'me' }
    })
    const p = await plan()
    expect(p.target).toMatchObject({
      kind: 'own-metadata',
      root,
      owner: { provider: 'shikimori', nickname: 'me' }
    })
    await startOk({})
    expect(manifestAt(root).owner).toEqual({ shikimoriId: ME.id, nickname: 'me' })
    expect(manifestAt(root).layoutVersion).toBe(1)
  })

  it('picking AniList on the own Shikimori library: other-owner, a sibling for AniList, never the Shikimori sibling', async () => {
    pc(true)
    const root = path.join(env.drive, 'Trip')
    await seedLibrary(root, {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: { shikimoriId: ME.id, nickname: 'me' }
    })
    // A Shikimori-owned sibling isn't AniList's own: skipped.
    await seedLibrary(path.join(env.drive, 'Trip (2)'), {
      libraryId: FRIEND_LIB,
      name: 'Trip',
      owner: { shikimoriId: ME.id, nickname: 'me' }
    })
    const p = await plan({ target: root, owner: 'anilist' })
    expect(p.target).toMatchObject({
      kind: 'other-owner',
      root: path.join(env.drive, 'Trip (3)'),
      ownerNickname: 'me',
      owner: { provider: 'shikimori', nickname: 'me' }
    })
    await startOk({ target: root, owner: 'anilist' })
    expect(manifestAt(path.join(env.drive, 'Trip (3)'))).toMatchObject({
      layoutVersion: 2,
      owner: { provider: 'anilist', userId: '9', nickname: 'al' }
    })
    expect(manifestAt(root).owner).toEqual({ shikimoriId: ME.id, nickname: 'me' })
  })

  it('the default name follows the pick; a different pick on a parent folder with the default name is a plain new', async () => {
    pc(true)
    await seedLibrary(path.join(env.drive, 'Anime Library (me)'), {
      libraryId: OTHER_LIB,
      name: 'Anime Library (me)',
      owner: { shikimoriId: ME.id, nickname: 'me' }
    })
    const al = await plan({ name: '', owner: 'anilist' })
    expect(al.target).toMatchObject({
      kind: 'new',
      root: path.join(env.drive, 'Anime Library (al)'),
      libraryName: 'Anime Library (al)'
    })
    const shiki = await plan({ name: '', owner: 'shikimori' })
    expect(shiki.target).toMatchObject({ kind: 'own-metadata', libraryName: 'Anime Library (me)' })
  })

  it('export → separate → re-export: the second plan is own-metadata on <name> (2), with no takeover', async () => {
    pc(true)
    const videos = path.join(env.drive, 'Trip')
    await seedLibrary(videos, { libraryId: OTHER_LIB, name: 'Trip' })
    const before = scan(videos)
    const first = await plan({ owner: 'anilist' })
    expect(first.target).toMatchObject({ kind: 'upgrade', root: videos })
    const separate = await plan({ owner: 'anilist', sibling: true })
    expect(separate.target).toMatchObject({ kind: 'new', root: path.join(env.drive, 'Trip (2)') })
    await startOk({ owner: 'anilist', sibling: true })
    expect(scan(videos)).toEqual(before)
    const again = await plan({ owner: 'anilist' })
    expect(again.target).toMatchObject({
      kind: 'own-metadata',
      root: path.join(env.drive, 'Trip (2)'),
      owner: { provider: 'anilist', nickname: 'al' }
    })
    // A Shikimori pick still takes the Videos-only library over, with today's warning.
    expect((await plan({ owner: 'shikimori' })).target).toMatchObject({
      kind: 'upgrade',
      root: videos
    })
  })

  it('"separate" never hands back a Videos-only (2) as another upgrade', async () => {
    pc(true)
    await seedLibrary(path.join(env.drive, 'Trip'), { libraryId: OTHER_LIB, name: 'Trip' })
    await seedLibrary(path.join(env.drive, 'Trip (2)'), { libraryId: FRIEND_LIB, name: 'Trip' })
    const p = await plan({ owner: 'anilist', sibling: true })
    expect(p.target).toMatchObject({ kind: 'new', root: path.join(env.drive, 'Trip (3)') })
  })

  it('a takeover T13a’s minor check would refuse goes straight to the separate path, and start never reaches the takeover', async () => {
    pc(true)
    const videos = path.join(env.drive, 'Trip')
    await seedLibrary(videos, { libraryId: OTHER_LIB, name: 'Trip' })
    const file = path.join(videos, LIBRARY_DIR, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...m, layoutMinor: LAYOUT_MINORS[1] + 1 }))
    const before = scan(videos)
    const p = await plan({ owner: 'anilist' })
    expect(p.target).toMatchObject({
      kind: 'new',
      root: path.join(env.drive, 'Trip (2)'),
      separateReason: SEPARATE_NEWER_MINOR
    })
    await startOk({ owner: 'anilist', confirmTakeover: true })
    expect(scan(videos)).toEqual(before)
    expect(manifestAt(path.join(env.drive, 'Trip (2)')).owner).toMatchObject({
      provider: 'anilist'
    })
    // A Shikimori takeover keeps v1, so the minor doesn't stop it.
    expect((await plan({ owner: 'shikimori' })).target).toMatchObject({
      kind: 'upgrade',
      root: videos
    })
  })

  // PR #730 review: gated on the library, not the request. A Videos only
  // export at an own v2 library went to `own-metadata`: written on a
  // Shikimori + AniList PC, refused ("Log in to Shikimori…") on an AniList-only one.
  it.each([
    ['Shikimori + AniList', {}],
    ['AniList only', { shikimori: false }]
  ] as const)(
    '%s PC, Videos only at an own v2 AniList library: other-owner next to it, the v2 library byte-identical',
    async (_l, users) => {
      pc(false, users)
      const v2 = path.join(env.drive, 'Trip')
      await seedLibrary(v2, {
        libraryId: OTHER_LIB,
        name: 'Trip',
        owner: { provider: 'anilist', userId: String(AL.id), nickname: 'al' }
      })
      const before = scan(v2)
      const p = await plan({ target: v2, mode: 'videos' })
      expect(p.target).toMatchObject({
        kind: 'other-owner',
        mode: 'videos',
        root: path.join(env.drive, 'Trip (2)'),
        ownerNickname: 'al',
        owner: { provider: 'anilist', nickname: 'al' }
      })
      await startOk({ target: v2, mode: 'videos' })
      expect(scan(v2)).toEqual(before)
      expect(manifestAt(path.join(env.drive, 'Trip (2)'))).toMatchObject({
        layoutVersion: 1,
        mode: 'videos',
        owner: null
      })
    }
  )

  it('start refuses an owner that isn’t offered, or isn’t connected', async () => {
    pc(false)
    const res = await env.svc.start({
      selection: sel(episode()),
      target: env.drive,
      name: 'Trip',
      mode: 'metadata',
      owner: 'anilist'
    })
    expect(res).toEqual({ ok: false, reason: OWNER_NOT_OFFERED })
    pc(true, { anilist: false })
    expect(
      await env.svc.start({
        selection: sel(episode()),
        target: env.drive,
        name: 'Trip',
        mode: 'metadata',
        owner: 'anilist'
      })
    ).toEqual({ ok: false, reason: OWNER_NOT_OFFERED })
  })
})

describe('the free-space check', () => {
  it('needs the bytes plus a 1% margin', () => {
    expect(requiredBytes(1000)).toBe(1010)
    expect(fitsFreeSpace(1000, 1010)).toBe(true)
    expect(fitsFreeSpace(1000, 1009)).toBe(false)
    expect(fitsFreeSpace(1000, null)).toBe(true)
  })

  it('plan reports statfs free space, and start refuses a selection that does not fit', async () => {
    let free = 0
    env = makeExportEnv({
      xfs: { statfs: async () => ({ bavail: free, bsize: 1 }) }
    })
    const { key, video } = env.addEpisode({
      animeId: 7,
      title: 'Show',
      episodeInt: '1',
      translationId: 11
    })
    const size = fs.statSync(video).size
    free = requiredBytes(size) - 1
    const plan = await env.svc.plan({ animeIds: [7], target: env.drive, name: 'Lib' })
    expect(plan.target?.free).toBe(free)
    const refused = await env.svc.start({ selection: sel(key), target: env.drive, name: 'Lib' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toMatch(/Not enough free space/)
    expect(fs.existsSync(path.join(env.drive, 'Lib'))).toBe(false)

    free = requiredBytes(size)
    const ok = await env.svc.start({ selection: sel(key), target: env.drive, name: 'Lib' })
    expect(ok.ok).toBe(true)
    if (ok.ok) await env.svc.settled(ok.job.jobId)
  })
})

describe('the per-file playback hold (fake presence)', () => {
  it('finishes the file in flight, holds the next, and resumes on one release emit', async () => {
    env = makeExportEnv({
      xfs: {
        open: async (p, flags) => {
          const h = await nodeFs.open(p, flags)
          if (!/Show - 02 .*\.anime-dl-tmp$/.test(p)) return h
          return {
            ...h,
            write: async (buf) => {
              // The player opens while file 2 is copying.
              env.presence.open = true
              await h.write(buf)
            }
          }
        }
      }
    })
    const keys = [1, 2, 3].map(
      (n) =>
        env.addEpisode({ animeId: 7, title: 'Show', episodeInt: String(n), translationId: 10 + n })
          .key
    )
    let mergesResumed = 0
    env.presence.onRelease(() => mergesResumed++)
    expect(env.presence.release.size()).toBe(1)

    const r = await env.svc.start({ selection: sel(...keys), target: env.drive, name: 'Lib' })
    if (!r.ok) throw new Error(r.reason)
    await until(() => env.svc.list()[0].status === 'held', 'the hold')
    const root = path.join(env.drive, 'Lib', 'Show')
    // File 2 completed; file 3 didn't start.
    expect(fs.existsSync(path.join(root, 'Show - 02 [Studio].mkv'))).toBe(true)
    expect(fs.readdirSync(root).filter((f) => f.includes('Show - 03'))).toEqual([])
    expect(env.svc.list()[0].filesDone).toBe(2)
    expect(env.presence.release.size()).toBe(2)

    env.presence.open = false
    env.presence.release.emit()
    await env.svc.settled(r.job.jobId)
    expect(env.svc.list()[0].status).toBe('completed')
    expect(fs.existsSync(path.join(root, 'Show - 03 [Studio].mkv'))).toBe(true)
    expect(mergesResumed).toBe(1)
    // The job's listener is gone once it ends.
    expect(env.presence.release.size()).toBe(1)
  })

  it('a user pause while held removes the listener too', async () => {
    env = makeExportEnv()
    const { key } = env.addEpisode({
      animeId: 7,
      title: 'Show',
      episodeInt: '1',
      translationId: 11
    })
    env.presence.open = true
    const r = await env.svc.start({ selection: sel(key), target: env.drive, name: 'Lib' })
    if (!r.ok) throw new Error(r.reason)
    await until(() => env.svc.list()[0].status === 'held', 'the hold')
    expect(env.presence.release.size()).toBe(1)
    await env.svc.pause(r.job.jobId)
    expect(env.svc.list()[0].status).toBe('paused')
    expect(env.presence.release.size()).toBe(0)
  })
})

describe('naming items appended to a library', () => {
  it('an existing item counts as an earlier item for case collisions, and keeps its name', () => {
    const input = {
      animeId: 7,
      episodeInt: '1',
      translationId: 12,
      title: 'Show',
      author: 'Studio',
      ext: '.mkv'
    }
    const [plain] = nameItems([input])
    expect(plain.path).toBe('Show/Show - 01 [Studio].mkv')
    const [named] = nameItems([input], [{ path: 'Show/SHOW - 01 [STUDIO].mkv' }])
    expect(named.path).not.toBe(plain.path)
    expect(named.path.toUpperCase()).not.toBe('SHOW/SHOW - 01 [STUDIO].MKV')
    expect(named.renamed).toBe(true)
  })
})

describe('the meta snapshot on re-export', () => {
  const detail = {
    id: 7,
    title: 'Show',
    titles: { romaji: 'Show', ru: 'Шоу' },
    posterUrlSmall: 'https://example.invalid/7.jpg',
    numberOfEpisodes: 2,
    type: 'tv',
    typeTitle: 'TV',
    year: 2024,
    season: 'spring',
    posterUrl: '',
    descriptions: [],
    genres: [{ id: 1, title: 'Action' }],
    episodes: [{ id: 1, episodeInt: '1', episodeFull: '1 серия', episodeType: 'tv', isActive: 1 }],
    myAnimeListId: 99
  } as AnimeDetail

  it('merges known fields over a known-major file and keeps its unknown fields at every level', async () => {
    env = makeExportEnv()
    const root = path.join(env.drive, 'Lib')
    await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Lib' })
    const metaDir = path.join(root, LIBRARY_DIR, 'meta')
    fs.mkdirSync(metaDir)
    fs.writeFileSync(
      path.join(metaDir, '7.json'),
      JSON.stringify({
        animeId: 7,
        year: 1999,
        futureTop: { a: 1 },
        titles: { en: 'Old', futureTitles: true },
        searchResult: { ...detail, year: 1999, futureSearch: 'keep' }
      })
    )
    const local = buildMeta(7, detail, null)
    expect(await writeTitleSnapshot(nodeFs, root, local, null)).toBe('merged')
    const raw = JSON.parse(fs.readFileSync(path.join(metaDir, '7.json'), 'utf8'))
    expect(raw.year).toBe(2024)
    expect(raw.futureTop).toEqual({ a: 1 })
    expect(raw.titles).toEqual({ ru: 'Шоу', romaji: 'Show', en: 'Old', futureTitles: true })
    expect(raw.searchResult.year).toBe(2024)
    expect(raw.searchResult.futureSearch).toBe('keep')
    expect(raw.malId).toBe(99)
    const read = await readMeta(root, 7)
    expect(read.status).toBe('ok')
  })

  it('writes a new meta file and copies the poster from poster-cache', async () => {
    env = makeExportEnv()
    const root = path.join(env.drive, 'Lib')
    await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Lib' })
    const poster = path.join(env.userData, 'poster.jpg')
    fs.writeFileSync(poster, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
    expect(await writeTitleSnapshot(nodeFs, root, buildMeta(7, detail, null), poster)).toBe(
      'written'
    )
    expect(fs.readFileSync(path.join(root, LIBRARY_DIR, 'posters', '7.jpg'))).toEqual(
      fs.readFileSync(poster)
    )
    const read = await readMeta(root, 7)
    expect(read.status).toBe('ok')
    if (read.status === 'ok') {
      expect(read.meta.genres).toEqual([{ id: 1, title: 'Action' }])
      expect(read.meta.episodes).toEqual([{ episodeInt: '1', episodeFull: '1 серия' }])
    }
    // No poster in the cache: no poster file, and no failure.
    expect(
      await writeTitleSnapshot(nodeFs, root, buildMeta(8, null, null), path.join(env.dir, 'none'))
    ).toBe('written')
    expect(fs.existsSync(path.join(root, LIBRARY_DIR, 'posters', '8.jpg'))).toBe(false)
  })

  // #684: a poster cached before the fix can be smotret's "site moved" page.
  it('skips a cached poster that is not an image, and still writes the meta', async () => {
    env = makeExportEnv()
    const root = path.join(env.drive, 'Lib')
    await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Lib' })
    const poster = path.join(env.userData, 'poster.jpg')
    fs.writeFileSync(poster, '<!DOCTYPE html><html><head><title>Адрес сайта изменился! - Anime 365')
    expect(await writeTitleSnapshot(nodeFs, root, buildMeta(7, detail, null), poster)).toBe(
      'written'
    )
    expect(fs.existsSync(path.join(root, LIBRARY_DIR, 'posters', '7.jpg'))).toBe(false)
    expect((await readMeta(root, 7)).status).toBe('ok')
  })

  it('leaves a meta file over its 1 MB cap alone', async () => {
    env = makeExportEnv()
    const root = path.join(env.drive, 'Lib')
    await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Lib' })
    const metaDir = path.join(root, LIBRARY_DIR, 'meta')
    fs.mkdirSync(metaDir)
    const big = path.join(metaDir, '7.json')
    const fd = fs.openSync(big, 'w')
    fs.ftruncateSync(fd, 1024 * 1024 + 1)
    fs.closeSync(fd)
    const before = fs.statSync(big)
    expect(await writeTitleSnapshot(nodeFs, root, buildMeta(7, detail, null), null)).toBe(
      'kept-over-cap'
    )
    const after = fs.statSync(big)
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs])
  })

  it('mergeMeta carries the bag from the existing object, not the local one', () => {
    const existing = { animeId: 7, year: 1 } as SharedLibraryMeta
    setUnknownFields(existing, { future: 1 })
    const local = { animeId: 7, year: 2 } as SharedLibraryMeta
    setUnknownFields(local, { leaked: 1 })
    const out = mergeMeta(existing, local)
    expect((out as unknown as Record<symbol, unknown>)[UNKNOWN_FIELDS]).toEqual({ future: 1 })
    expect(JSON.parse(serializeMeta(out))).toEqual({ animeId: 7, year: 2, future: 1 })
  })
})
