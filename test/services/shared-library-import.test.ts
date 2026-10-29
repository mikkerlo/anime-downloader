// Copy to this PC from a Shared Library (#579), against the real service, S5's
// reader and the real copy helpers, in temp dirs: the plan, the duplicate
// prompt, kill and resume, the playback hold, and never writing to the drive.

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { nodeFs, TMP_SUFFIX, type ExportFs } from '../../src/main/lib/shared-library/copy'
import { UNSAFE_NAME } from '../../src/main/lib/shared-library/local-name'
import { createPlayerPresenceService } from '../../src/main/services/player-presence'
import { KEPT_LOCAL, STILL_BUSY } from '../../src/main/services/shared-library-import/job'
import { fsWritesUnder, mtimeSnapshot } from '../helpers/attached-library'
import {
  FIXTURE_LIBRARY_ID,
  FRIEREN,
  FRIEREN_ASS,
  FRIEREN_MP4,
  MESHI,
  MESHI_MKV,
  keys,
  makeImportEnv,
  setMetaTitle,
  until,
  type ImportEnv
} from '../helpers/shared-library-import'

let env: ImportEnv
afterEach(() => {
  vi.restoreAllMocks()
  env?.cleanup()
})

const FRIEREN_DIR = 'Sousou no Frieren'
const FRIEREN_FILE = 'Sousou no Frieren - 01 [Crunchyroll]'
const MESHI_FILE = 'Dungeon Meshi - 01 [AniLibria]'

async function startOk(e: ImportEnv, ks: string[], destination: ImportDestination = 'hot') {
  const r = await e.svc.start({
    libraryId: FIXTURE_LIBRARY_ID,
    selection: keys(...ks),
    destination
  })
  if (!r.ok) throw new Error(`start refused: ${r.reason}`)
  return r.job
}

const job = (e: ImportEnv): ImportJobView => e.svc.list()[0]
const read = <T>(key: string): T => env.store.get<T>(key) as T

/** A local file in the hot root, under the title's local folder. */
function localFile(e: ImportEnv, dir: string, name: string, bytes: number | string): string {
  const p = path.join(e.hot, dir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof bytes === 'string' ? bytes : Buffer.alloc(bytes, 7))
  return p
}

function entry(translationId: number, author: string): object {
  return { translationType: 'subRu', author, quality: 720, translationId }
}

describe('the plan', () => {
  it('lists the library’s titles under this PC’s names, sized from the drive', async () => {
    env = makeImportEnv()
    const plan = await env.svc.plan({ libraryId: FIXTURE_LIBRARY_ID, animeIds: null })
    expect(plan.error).toBeNull()
    expect(plan.libraryName).toBe('Fixture library')
    expect(plan.titles.map((t) => t.name)).toEqual([FRIEREN_DIR, 'Dungeon Meshi'])
    const frieren = plan.titles[0].translations[0].episodes[0]
    const ass = fs.statSync(path.join(env.drive, FRIEREN_ASS)).size
    expect(frieren).toMatchObject({ key: FRIEREN, state: 'ready', size: 2075 + ass })
    expect(plan.rejected).toEqual([])
    expect(plan.hot.dir).toBe(env.hot)
    expect(plan.cold?.dir).toBe(env.cold)
  })

  it('one title only; a missing cold folder disables Cold', async () => {
    env = makeImportEnv()
    fs.rmSync(env.cold, { recursive: true })
    const plan = await env.svc.plan({ libraryId: FIXTURE_LIBRARY_ID, animeIds: [202] })
    expect(plan.titles.map((t) => t.animeId)).toEqual([202])
    expect(plan.cold).toBeNull()
    expect(plan.coldUnavailable).toMatch(/isn’t there/)
    const r = await env.svc.start({
      libraryId: FIXTURE_LIBRARY_ID,
      selection: keys(MESHI),
      destination: 'cold'
    })
    expect(r.ok).toBe(false)
  })

  it('an unplugged drive plans nothing and starts nothing', async () => {
    env = makeImportEnv()
    env.available.value = false
    const plan = await env.svc.plan({ libraryId: FIXTURE_LIBRARY_ID, animeIds: null })
    expect(plan.titles).toEqual([])
    expect(plan.error).toMatch(/Connect the drive/)
    const r = await env.svc.start({
      libraryId: FIXTURE_LIBRARY_ID,
      selection: keys(MESHI),
      destination: 'hot'
    })
    expect(r.ok).toBe(false)
  })

  it('a title whose snapshot name is "..": its item is listed as unsafe and never planned', async () => {
    env = makeImportEnv({}, { editDrive: (d) => setMetaTitle(d, 101, '..') })
    const plan = await env.svc.plan({ libraryId: FIXTURE_LIBRARY_ID, animeIds: null })
    expect(plan.rejected).toEqual([{ key: FRIEREN, label: '.. — 1 серия', reason: UNSAFE_NAME }])
    expect(plan.titles.map((t) => t.animeId)).toEqual([202])
  })
})

describe('copying', () => {
  it('lands under the local name with arrivedAt, and registers the title from the snapshot', async () => {
    env = makeImportEnv({ now: () => 1_800_000_000_000 })
    const j = await startOk(env, [FRIEREN, MESHI])
    await env.svc.settled(j.jobId)
    expect(job(env)).toMatchObject({ status: 'completed', itemsDone: 2, itemsTotal: 2 })
    const mp4 = path.join(env.hot, FRIEREN_DIR, `${FRIEREN_FILE}.mp4`)
    expect(fs.readFileSync(mp4)).toEqual(fs.readFileSync(path.join(env.drive, FRIEREN_MP4)))
    expect(fs.readFileSync(path.join(env.hot, FRIEREN_DIR, `${FRIEREN_FILE}.ass`))).toEqual(
      fs.readFileSync(path.join(env.drive, FRIEREN_ASS))
    )
    expect(fs.existsSync(path.join(env.hot, 'Dungeon Meshi', `${MESHI_FILE}.mkv`))).toBe(true)
    const eps = read<Record<string, DownloadedEpisodeLike>>('downloadedEpisodes')
    expect(eps[FRIEREN]).toEqual({
      translationType: 'subRu',
      author: 'Crunchyroll',
      quality: 1080,
      translationId: 9001,
      arrivedAt: 1_800_000_000_000
    })
    expect(eps[MESHI].arrivedAt).toBe(1_800_000_000_000)
    const anime = read<Record<string, AnimeSearchResult>>('downloadedAnime')
    expect(anime['101'].titles.romaji).toBe('Sousou no Frieren')
    expect(anime['202'].title).toBe('Dungeon Meshi')
    // Details from `meta/` (the record alone without one), with the copied
    // translation, so the detail page lists and plays the copy offline.
    const cache =
      read<
        Record<
          string,
          { animeDetail: AnimeDetail; episodes: Record<number, EpisodeDetail>; cachedAt: number }
        >
      >('animeCache')
    expect(Object.keys(cache).sort()).toEqual(['101', '202'])
    expect(cache['101'].animeDetail.myAnimeListId).toBe(52991)
    expect(cache['101'].cachedAt).toBe(0)
    expect(cache['101'].animeDetail.episodes).toEqual([
      { id: -1, episodeFull: '1 серия', episodeInt: '1', episodeType: '', isActive: 1 }
    ])
    expect(cache['101'].episodes[-1].translations).toMatchObject([
      { id: 9001, type: 'subRu', authorsSummary: 'Crunchyroll', height: 1080, isActive: 1 }
    ])
    expect(cache['202'].animeDetail.title).toBe('Dungeon Meshi')
    expect(cache['202'].episodes[-1].translations.map((t) => t.id)).toEqual([9101])
    // The drive's poster, only where it has one.
    expect(fs.existsSync(path.join(env.userData, 'poster-cache', '101.jpg'))).toBe(true)
    expect(fs.existsSync(path.join(env.userData, 'poster-cache', '202.jpg'))).toBe(false)
    expect(env.imported.map((i) => i.dirName)).toEqual([FRIEREN_DIR, 'Dungeon Meshi'])
  })

  it('a title the job seeded gets each copied episode; an entry this PC had is never touched', async () => {
    const meshi2 = '202:2:9101'
    env = makeImportEnv(
      {},
      {
        editDrive: (d) => {
          const rel = 'Dungeon Meshi/Dungeon Meshi - 02 [AniLibria].mkv'
          fs.copyFileSync(path.join(d, MESHI_MKV), path.join(d, rel))
          const file = path.join(d, '.anime-dl', 'manifest.json')
          const m = JSON.parse(fs.readFileSync(file, 'utf8'))
          m.items.push({ ...m.items[1], episodeInt: '2', path: rel })
          fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`)
        }
      }
    )
    // This PC's own entry, from an online visit, lists the copied episode.
    const mine = {
      animeDetail: {
        id: 101,
        title: 'Frieren',
        titles: {},
        episodes: [
          { id: 555, episodeFull: '1 серия', episodeInt: '1', episodeType: 'tv', isActive: 1 }
        ]
      },
      episodes: {},
      qualityProbes: {},
      cachedAt: 5,
      posterCached: false
    }
    env.store.set('animeCache', { '101': mine })
    // The fake store hands out live objects: compare with a copy.
    const was = structuredClone(mine)
    const j = await startOk(env, [FRIEREN, MESHI, meshi2])
    await env.svc.settled(j.jobId)
    const cache =
      read<Record<string, { animeDetail: AnimeDetail; episodes: Record<number, EpisodeDetail> }>>(
        'animeCache'
      )
    expect(cache['101']).toEqual(was)
    expect(cache['202'].animeDetail.episodes.map((e) => [e.id, e.episodeInt])).toEqual([
      [-1, '1'],
      [-2, '2']
    ])
    expect(Object.keys(cache['202'].episodes).sort()).toEqual(['-1', '-2'])
  })

  it('into the cold root when chosen', async () => {
    env = makeImportEnv()
    const j = await startOk(env, [MESHI], 'cold')
    await env.svc.settled(j.jobId)
    expect(fs.existsSync(path.join(env.cold, 'Dungeon Meshi', `${MESHI_FILE}.mkv`))).toBe(true)
    expect(fs.existsSync(path.join(env.hot, 'Dungeon Meshi'))).toBe(false)
  })

  it('a drive file that doesn’t match its manifest size fails, and nothing is registered', async () => {
    env = makeImportEnv({}, { editDrive: (d) => fs.appendFileSync(path.join(d, MESHI_MKV), 'x') })
    const j = await startOk(env, [MESHI])
    await env.svc.settled(j.jobId)
    expect(job(env).failed.map((f) => f.key)).toEqual([MESHI])
    expect(fs.existsSync(path.join(env.hot, 'Dungeon Meshi', `${MESHI_FILE}.mkv`))).toBe(false)
    expect(read<Record<string, unknown>>('downloadedEpisodes')).toEqual({})
  })

  it('never writes to the drive: the tree and mtimes are unchanged, and no write call touches it', async () => {
    env = makeImportEnv()
    const before = mtimeSnapshot(env.drive)
    const writes = fsWritesUnder(env.drive)
    const j = await startOk(env, [FRIEREN, MESHI])
    await env.svc.settled(j.jobId)
    expect(job(env).status).toBe('completed')
    expect(writes()).toEqual([])
    expect(mtimeSnapshot(env.drive)).toEqual(before)
  })
})

type DownloadedEpisodeLike = {
  translationType: string
  author: string
  quality: number
  translationId: number
  arrivedAt?: number
}

describe('duplicates: ask, showing both sizes', () => {
  it('the same translation on this PC: Replace swaps the file and keeps one registry entry', async () => {
    env = makeImportEnv()
    const local = localFile(env, FRIEREN_DIR, `${FRIEREN_FILE}.mp4`, 612)
    env.store.set('downloadedEpisodes', { [FRIEREN]: entry(9001, 'Crunchyroll') })
    const j = await startOk(env, [FRIEREN])
    await until(() => job(env).status === 'waiting-duplicate', 'the prompt')
    expect(job(env).duplicate).toEqual({
      key: FRIEREN,
      label: `${FRIEREN_DIR} — 1 серия`,
      localSize: 612,
      driveSize: 2075,
      canKeepBoth: false,
      canReplace: true
    })
    await env.svc.resolveDuplicate(j.jobId, { choice: 'replace', applyToAll: false })
    await env.svc.settled(j.jobId)
    expect(job(env).status).toBe('completed')
    expect(fs.readFileSync(local)).toEqual(fs.readFileSync(path.join(env.drive, FRIEREN_MP4)))
    const eps = read<Record<string, unknown>>('downloadedEpisodes')
    expect(Object.keys(eps).filter((k) => k.startsWith('101:1'))).toEqual([FRIEREN])
  })

  it('Replace over another translation: its files and registry entries go', async () => {
    env = makeImportEnv()
    const other = localFile(env, FRIEREN_DIR, 'Sousou no Frieren - 01 [Other].mkv', 900)
    const otherAss = localFile(env, FRIEREN_DIR, 'Sousou no Frieren - 01 [Other].ass', 'x')
    const legacy = localFile(env, FRIEREN_DIR, 'Sousou no Frieren - 01.mp4', 10)
    const neighbour = localFile(env, FRIEREN_DIR, 'Sousou no Frieren - 01.5 [Other].mkv', 10)
    env.store.set('downloadedEpisodes', {
      '101:1:5555': entry(5555, 'Other'),
      '101:1': entry(1, ''),
      '101:2:5555': entry(5555, 'Other')
    })
    const j = await startOk(env, [FRIEREN])
    await until(() => job(env).status === 'waiting-duplicate', 'the prompt')
    expect(job(env).duplicate).toMatchObject({ localSize: 900, canKeepBoth: true })
    await env.svc.resolveDuplicate(j.jobId, { choice: 'replace', applyToAll: false })
    await env.svc.settled(j.jobId)
    for (const p of [other, otherAss, legacy]) expect(fs.existsSync(p)).toBe(false)
    expect(fs.existsSync(neighbour)).toBe(true)
    const eps = read<Record<string, unknown>>('downloadedEpisodes')
    expect(Object.keys(eps).sort()).toEqual([FRIEREN, '101:2:5555'])
  })

  it('Keep skips the item and leaves this PC’s file and entry alone', async () => {
    env = makeImportEnv()
    const local = localFile(env, FRIEREN_DIR, `${FRIEREN_FILE}.mp4`, 612)
    env.store.set('downloadedEpisodes', { [FRIEREN]: entry(9001, 'Crunchyroll') })
    const j = await startOk(env, [FRIEREN])
    await until(() => job(env).status === 'waiting-duplicate', 'the prompt')
    await env.svc.resolveDuplicate(j.jobId, { choice: 'keep', applyToAll: false })
    await env.svc.settled(j.jobId)
    expect(job(env)).toMatchObject({ status: 'completed', itemsDone: 0 })
    expect(job(env).kept).toEqual([
      { key: FRIEREN, label: `${FRIEREN_DIR} — 1 серия`, reason: KEPT_LOCAL }
    ])
    expect(fs.statSync(local).size).toBe(612)
    expect(env.store.get('downloadedEpisodes')).toEqual({ [FRIEREN]: entry(9001, 'Crunchyroll') })
  })

  it('Keep both copies alongside another translation; both entries stay', async () => {
    env = makeImportEnv()
    const other = localFile(env, FRIEREN_DIR, 'Sousou no Frieren - 01 [Other].mkv', 900)
    env.store.set('downloadedEpisodes', { '101:1:5555': entry(5555, 'Other') })
    const j = await startOk(env, [FRIEREN])
    await until(() => job(env).status === 'waiting-duplicate', 'the prompt')
    await env.svc.resolveDuplicate(j.jobId, { choice: 'keep-both', applyToAll: false })
    await env.svc.settled(j.jobId)
    expect(fs.existsSync(other)).toBe(true)
    expect(fs.existsSync(path.join(env.hot, FRIEREN_DIR, `${FRIEREN_FILE}.mp4`))).toBe(true)
    expect(Object.keys(read<object>('downloadedEpisodes')).sort()).toEqual(['101:1:5555', FRIEREN])
  })

  it('a file in the cold root counts too', async () => {
    env = makeImportEnv()
    const p = path.join(env.cold, 'Dungeon Meshi', `${MESHI_FILE}.mkv`)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'cold')
    await startOk(env, [MESHI])
    await until(() => job(env).status === 'waiting-duplicate', 'the prompt')
    expect(job(env).duplicate).toMatchObject({ key: MESHI, localSize: 4, driveSize: 19727 })
  })

  it('"Apply to all remaining" answers the rest, during Import all too', async () => {
    env = makeImportEnv()
    localFile(env, FRIEREN_DIR, `${FRIEREN_FILE}.mp4`, 612)
    localFile(env, 'Dungeon Meshi', `${MESHI_FILE}.mkv`, 700)
    // Import all: every title the plan lists, all selected.
    const plan = await env.svc.plan({ libraryId: FIXTURE_LIBRARY_ID, animeIds: null })
    const all = plan.titles.flatMap((t) =>
      t.translations.flatMap((tr) => tr.episodes.map((e) => e.key))
    )
    const j = await startOk(env, all)
    await until(() => job(env).status === 'waiting-duplicate', 'the first prompt')
    expect(job(env).duplicate?.key).toBe(FRIEREN)
    await env.svc.resolveDuplicate(j.jobId, { choice: 'keep', applyToAll: true })
    await env.svc.settled(j.jobId)
    expect(job(env).status).toBe('completed')
    expect(job(env).kept.map((k) => k.key)).toEqual([FRIEREN, MESHI])
    // The second was never asked.
    expect(env.updates.filter((u) => u.duplicate?.key === MESHI)).toEqual([])
    expect(fs.statSync(path.join(env.hot, 'Dungeon Meshi', `${MESHI_FILE}.mkv`)).size).toBe(700)
  })

  it('a local file still downloading (.part) is asked about, and never replaced', async () => {
    env = makeImportEnv()
    const part = localFile(env, FRIEREN_DIR, `${FRIEREN_FILE}.mp4.part`, 300)
    const j = await startOk(env, [FRIEREN])
    await until(() => job(env).status === 'waiting-duplicate', 'the prompt')
    expect(job(env).duplicate).toMatchObject({ localSize: 300, canReplace: false })
    await env.svc.resolveDuplicate(j.jobId, { choice: 'replace', applyToAll: false })
    await env.svc.settled(j.jobId)
    expect(job(env).kept[0].reason).toBe(STILL_BUSY)
    expect(fs.statSync(part).size).toBe(300)
    expect(fs.existsSync(path.join(env.hot, FRIEREN_DIR, `${FRIEREN_FILE}.mp4`))).toBe(false)
  })

  it('an answer that comes in while the prompt is still being saved is not lost', async () => {
    env = makeImportEnv()
    localFile(env, 'Dungeon Meshi', `${MESHI_FILE}.mkv`, 700)
    // Every save of the job file is slow, so `list()` shows the prompt before it is saved.
    const rename = fs.promises.rename.bind(fs.promises)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('import-jobs')) await new Promise((r) => setTimeout(r, 50))
      return rename(from, to)
    })
    const j = await startOk(env, [MESHI])
    await until(() => job(env).status === 'waiting-duplicate', 'the prompt', 5000)
    await env.svc.resolveDuplicate(j.jobId, { choice: 'replace', applyToAll: false })
    await env.svc.settled(j.jobId)
    expect(job(env).status).toBe('completed')
    expect(fs.statSync(path.join(env.hot, 'Dungeon Meshi', `${MESHI_FILE}.mkv`)).size).toBe(19727)
  })

  it('a pause while asking stops the job; the resume asks again', async () => {
    env = makeImportEnv()
    localFile(env, 'Dungeon Meshi', `${MESHI_FILE}.mkv`, 700)
    const j = await startOk(env, [MESHI])
    await until(() => job(env).status === 'waiting-duplicate', 'the prompt')
    await env.svc.pause(j.jobId)
    expect(job(env)).toMatchObject({ status: 'paused', duplicate: null })
    await env.svc.resume(j.jobId)
    await until(() => job(env).status === 'waiting-duplicate', 'the prompt again')
    await env.svc.resolveDuplicate(j.jobId, { choice: 'replace', applyToAll: false })
    await env.svc.settled(j.jobId)
    expect(fs.statSync(path.join(env.hot, 'Dungeon Meshi', `${MESHI_FILE}.mkv`)).size).toBe(19727)
  })
})

/** An fs whose write of a file under `match` never finishes: a process killed mid-copy. */
function hangOn(match: RegExp): { xfs: Partial<ExportFs>; hung: Promise<void> } {
  let signal!: () => void
  const hung = new Promise<void>((r) => (signal = r))
  return {
    hung,
    xfs: {
      open: async (p, flags) => {
        const h = await nodeFs.open(p, flags)
        if (!match.test(p)) return h
        return {
          ...h,
          write: async (buf) => {
            await h.write(buf.subarray(0, 512))
            await h.close()
            signal()
            await new Promise(() => {})
          }
        }
      }
    }
  }
}

describe('kill and resume (the same guarantees as S6a)', () => {
  it('a kill mid-file: the next boot shows it paused; the resume deletes the .anime-dl-tmp and completes', async () => {
    env = makeImportEnv()
    const kill = hangOn(/Dungeon Meshi - 01 \[AniLibria\]\.mkv\.anime-dl-tmp$/)
    const doomed = env.restart({ xfs: kill.xfs })
    const r = await doomed.start({
      libraryId: FIXTURE_LIBRARY_ID,
      selection: keys(FRIEREN, MESHI),
      destination: 'hot'
    })
    expect(r.ok).toBe(true)
    await kill.hung
    const dest = path.join(env.hot, 'Dungeon Meshi', `${MESHI_FILE}.mkv`)
    expect(fs.existsSync(`${dest}${TMP_SUFFIX}`)).toBe(true)
    // Frieren finished and was registered before the kill; Meshi wasn't.
    expect(Object.keys(read<object>('downloadedEpisodes'))).toEqual([FRIEREN])

    const svc = env.restart()
    await svc.init()
    const [paused] = svc.list()
    expect(paused.status).toBe('paused')
    await svc.resume(paused.jobId)
    await svc.settled(paused.jobId)
    expect(svc.list()[0]).toMatchObject({ status: 'completed', itemsDone: 2 })
    expect(fs.existsSync(`${dest}${TMP_SUFFIX}`)).toBe(false)
    expect(fs.readFileSync(dest)).toEqual(fs.readFileSync(path.join(env.drive, MESHI_MKV)))
    expect(Object.keys(read<object>('downloadedEpisodes')).sort()).toEqual([FRIEREN, MESHI])
    // Its own finished file isn't a duplicate of itself.
    expect(svc.list()[0].kept).toEqual([])
  })

  it('a kill mid-file, then the drive’s file goes: the resume still deletes the .anime-dl-tmp', async () => {
    env = makeImportEnv()
    const kill = hangOn(/Dungeon Meshi - 01 \[AniLibria\]\.mkv\.anime-dl-tmp$/)
    const doomed = env.restart({ xfs: kill.xfs })
    expect(
      (
        await doomed.start({
          libraryId: FIXTURE_LIBRARY_ID,
          selection: keys(MESHI),
          destination: 'hot'
        })
      ).ok
    ).toBe(true)
    await kill.hung
    const dest = path.join(env.hot, 'Dungeon Meshi', `${MESHI_FILE}.mkv`)
    expect(fs.existsSync(`${dest}${TMP_SUFFIX}`)).toBe(true)
    fs.rmSync(path.join(env.drive, MESHI_MKV))

    const svc = env.restart()
    await svc.init()
    const [paused] = svc.list()
    await svc.resume(paused.jobId)
    await svc.settled(paused.jobId)
    expect(svc.list()[0].failed.map((f) => [f.key, f.reason])).toEqual([
      [MESHI, 'the file is missing on the drive']
    ])
    expect(fs.existsSync(`${dest}${TMP_SUFFIX}`)).toBe(false)
    expect(fs.existsSync(dest)).toBe(false)
    expect(read<object>('downloadedEpisodes')).toEqual({})
  })

  it('the drive pulled before the start of a run: waits for it, then completes', async () => {
    env = makeImportEnv({ retryMs: 20 })
    const j = await startOk(env, [MESHI])
    await env.svc.pause(j.jobId)
    const away = `${env.drive}-away`
    fs.renameSync(env.drive, away)
    await env.svc.resume(j.jobId)
    await until(() => job(env).status === 'waiting-drive', 'waiting for the drive')
    fs.renameSync(away, env.drive)
    await until(() => job(env).status === 'completed', 'the copy', 5000)
    expect(fs.existsSync(path.join(env.hot, 'Dungeon Meshi', `${MESHI_FILE}.mkv`))).toBe(true)
  })
})

describe('the playback hold', () => {
  it('holds before the next file while the player is open; one release resumes the import and the held merges', async () => {
    const presence = createPlayerPresenceService()
    const resumeHeldMerges = vi.fn()
    // `index.ts`'s merge hold registration, before any import exists.
    presence.onRelease(resumeHeldMerges)
    const sender = {
      id: 1,
      once: () => sender,
      on: () => sender
    } as unknown as Parameters<typeof presence.open>[0]
    env = makeImportEnv({
      presence,
      xfs: {
        open: async (p, flags) => {
          const h = await nodeFs.open(p, flags)
          if (!/Sousou no Frieren - 01 .*\.mp4\.anime-dl-tmp$/.test(p)) return h
          return {
            ...h,
            write: async (buf) => {
              // The player opens while the first file copies.
              if (!presence.isOpen()) presence.open(sender)
              await h.write(buf)
            }
          }
        }
      }
    })
    const j = await startOk(env, [FRIEREN, MESHI])
    await until(() => job(env).status === 'held', 'the hold')
    // The file in flight finished; the next didn't start.
    expect(fs.existsSync(path.join(env.hot, FRIEREN_DIR, `${FRIEREN_FILE}.mp4`))).toBe(true)
    expect(fs.existsSync(path.join(env.hot, 'Dungeon Meshi'))).toBe(false)

    presence.close(1)
    await env.svc.settled(j.jobId)
    expect(job(env).status).toBe('completed')
    expect(resumeHeldMerges).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(path.join(env.hot, 'Dungeon Meshi', `${MESHI_FILE}.mkv`))).toBe(true)
  })
})
