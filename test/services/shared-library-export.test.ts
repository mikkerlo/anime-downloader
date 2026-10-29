// The export service's units (#574): the plan (selection → files and missing
// items), the target table, the free-space check against an injected
// `statfs`, the per-file playback hold against a fake presence service, the
// naming of items appended to a library, and the `meta` re-export merge.

import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { fitsFreeSpace, requiredBytes } from '../../src/shared/shared-library-export'
import {
  UNKNOWN_FIELDS,
  serializeMeta,
  setUnknownFields
} from '../../src/main/lib/shared-library/format'
import { nameItems } from '../../src/main/lib/shared-library/naming'
import { LIBRARY_DIR, readMeta } from '../../src/main/lib/shared-library/read'
import { nodeFs } from '../../src/main/services/shared-library-export/copy'
import {
  BLOCKED_OWN_METADATA,
  STALE_EPISODE_LIST,
  classifyTarget
} from '../../src/main/services/shared-library-export/plan'
import {
  buildMeta,
  mergeMeta,
  writeTitleSnapshot
} from '../../src/main/services/shared-library-export/snapshot'
import { makeExportEnv, seedLibrary, sel, type ExportEnv } from '../helpers/shared-library-export'

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

describe('the target table', () => {
  const ME = 4242

  it('no library: a new one at <dir>/<name>', async () => {
    env = makeExportEnv()
    const t = await classifyTarget(env.drive, 'Trip', ME, exists)
    expect(t).toMatchObject({ kind: 'new', root: path.join(env.drive, 'Trip'), blocked: null })
  })

  it('the picked folder is itself a library: that library', async () => {
    env = makeExportEnv()
    const root = path.join(env.drive, 'Stick')
    await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Stick' })
    const t = await classifyTarget(root, 'whatever', ME, exists)
    expect(t).toMatchObject({ kind: 'add', root, libraryName: 'Stick' })
  })

  it('a Videos-only library: added to, by anyone, logged out included', async () => {
    env = makeExportEnv()
    await seedLibrary(path.join(env.drive, 'Trip'), { libraryId: OTHER_LIB, name: 'Trip' })
    for (const who of [ME, null]) {
      const t = await classifyTarget(env.drive, 'Trip', who, exists)
      expect(t.kind).toBe('add')
      expect(t.blocked).toBeNull()
    }
  })

  it('an own With metadata library: blocked', async () => {
    env = makeExportEnv()
    await seedLibrary(path.join(env.drive, 'Trip'), {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: { shikimoriId: ME, nickname: 'me' }
    })
    const t = await classifyTarget(env.drive, 'Trip', ME, exists)
    expect(t).toMatchObject({ kind: 'own-metadata', blocked: BLOCKED_OWN_METADATA })
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
      const t = await classifyTarget(env.drive, 'Trip', who, exists)
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
    const t = await classifyTarget(env.drive, 'Trip', ME, exists)
    expect(t).toMatchObject({
      kind: 'add',
      root: path.join(env.drive, 'Trip (5)'),
      ownerNickname: 'friend',
      blocked: null
    })
    expect(t.manifest?.libraryId).toBe('5a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')

    // With no Videos-only sibling, the first free name.
    fs.rmSync(path.join(env.drive, 'Trip (5)'), { recursive: true })
    const fresh = await classifyTarget(env.drive, 'Trip', ME, exists)
    expect(fresh).toMatchObject({ kind: 'foreign', root: path.join(env.drive, 'Trip (5)') })
  })

  it('a library this version can’t write: blocked with the reader’s message', async () => {
    env = makeExportEnv()
    const root = path.join(env.drive, 'Trip')
    fs.mkdirSync(path.join(root, LIBRARY_DIR), { recursive: true })
    fs.writeFileSync(
      path.join(root, LIBRARY_DIR, 'manifest.json'),
      JSON.stringify({ layoutVersion: 2, layoutMinor: 0, libraryId: OTHER_LIB })
    )
    const t = await classifyTarget(env.drive, 'Trip', ME, exists)
    expect(t.kind).toBe('read-only')
    expect(t.blocked).toMatch(/newer version/)
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
