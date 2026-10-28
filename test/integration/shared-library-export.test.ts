// Export to a Shared Library, end to end in temp dirs (#574): a temp PC (hot
// and cold roots with fake episodes, one an unmerged `.mp4` + `.ass` pair) and
// temp "drives". Kill, re-plug, drive-missing, cancel, the target table and a
// verify failure, each against the real service, S5's reader and writer, and
// the real episode scanner.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { itemKey } from '../../src/main/lib/shared-library/format'
import { LIBRARY_DIR, readLibrary } from '../../src/main/lib/shared-library/read'
import {
  nodeFs,
  TMP_SUFFIX,
  type ExportFs
} from '../../src/main/services/shared-library-export/copy'
import { BLOCKED_OWN_METADATA } from '../../src/main/services/shared-library-export/plan'
import {
  bytesFor,
  makeExportEnv,
  scan,
  seedLibrary,
  sel,
  sha256,
  type ExportEnv
} from '../helpers/shared-library-export'

const OTHER_LIB = '9c2d4e6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f'
const IMPOSTOR_LIB = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const ME = { id: 4242, nickname: 'me' }

let env: ExportEnv
afterEach(() => env?.cleanup())

/** Three titles' worth: hot, cold, and an unmerged pair. */
function seedPc(e: ExportEnv): { a1: string; a2: string; b1: string; c1: string } {
  const a1 = e.addEpisode({
    animeId: 101,
    title: 'Alpha Show',
    episodeInt: '1',
    translationId: 11
  }).key
  const a2 = e.addEpisode({
    animeId: 101,
    title: 'Alpha Show',
    episodeInt: '2',
    translationId: 12,
    where: 'cold'
  }).key
  const b1 = e.addEpisode({
    animeId: 202,
    title: 'Beta Show',
    episodeInt: '1',
    translationId: 21,
    ext: 'mp4',
    subtitle: true
  }).key
  const c1 = e.addEpisode({
    animeId: 303,
    title: 'Gamma Show',
    episodeInt: '5',
    translationId: 31
  }).key
  return { a1, a2, b1, c1 }
}

async function startOk(e: ExportEnv, keys: string[], name = 'Trip'): Promise<ExportJobView> {
  const r = await e.svc.start({ selection: sel(...keys), target: e.drive, name })
  if (!r.ok) throw new Error(`start refused: ${r.reason}`)
  return r.job
}

function manifestOf(root: string): SharedLibraryManifest {
  const raw = JSON.parse(fs.readFileSync(path.join(root, LIBRARY_DIR, 'manifest.json'), 'utf8'))
  return raw as SharedLibraryManifest
}

/** An fs whose write of a file under `match` never finishes: a process killed mid-copy. */
function hangOn(match: RegExp, afterBytes = 1024): { xfs: Partial<ExportFs>; hung: Promise<void> } {
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
            await h.write(buf.subarray(0, afterBytes))
            // A dead process's descriptors are closed by the OS.
            await h.close()
            signal()
            await new Promise(() => {})
          }
        }
      }
    }
  }
}

describe('Shared Library export (#574) — integration', () => {
  beforeEach(() => {
    env = makeExportEnv()
  })

  it('produces the layout, a manifest S5 reads, and byte-identical files', async () => {
    const { a1, a2, b1, c1 } = seedPc(env)
    const job = await startOk(env, [a1, a2, b1, c1])
    await env.svc.settled(job.jobId)
    const root = path.join(env.drive, 'Trip')

    const read = await readLibrary(root)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    const m = read.manifest
    expect(m.mode).toBe('videos')
    expect(m.owner).toBeNull()
    expect(m.name).toBe('Trip')
    expect(m.items.map(itemKey).sort()).toEqual([a1, a2, b1, c1].sort())
    expect(m.titles.map((t) => t.animeId).sort()).toEqual([101, 202, 303])
    expect(m.naming).toEqual({ rule: 'v1', renamed: [] })

    const byKey = new Map(m.items.map((i) => [itemKey(i), i]))
    expect(byKey.get(a1)!.path).toBe('Alpha Show/Alpha Show - 01 [Studio].mkv')
    expect(byKey.get(a2)!.path).toBe('Alpha Show/Alpha Show - 02 [Studio].mkv')
    const pair = byKey.get(b1)!
    expect(pair.path).toBe('Beta Show/Beta Show - 01 [Studio].mp4')
    expect(pair.subtitlePath).toBe('Beta Show/Beta Show - 01 [Studio].ass')

    // Byte-identical, hot and cold sources alike, and the recorded hash is the file's.
    const srcOf: Record<string, string> = {
      [a1]: path.join(env.hot, 'Alpha Show', 'Alpha Show - 01 [Studio].mkv'),
      [a2]: path.join(env.cold, 'Alpha Show', 'Alpha Show - 02 [Studio].mkv'),
      [b1]: path.join(env.hot, 'Beta Show', 'Beta Show - 01 [Studio].mp4'),
      [c1]: path.join(env.hot, 'Gamma Show', 'Gamma Show - 05 [Studio].mkv')
    }
    for (const [key, src] of Object.entries(srcOf)) {
      const dest = path.join(root, ...byKey.get(key)!.path.split('/'))
      expect(sha256(dest)).toBe(sha256(src))
      expect(byKey.get(key)!.sha256).toBe(sha256(src))
      expect(byKey.get(key)!.size).toBe(fs.statSync(src).size)
    }
    expect(fs.readFileSync(path.join(root, ...pair.subtitlePath!.split('/')), 'utf8')).toBe(
      fs.readFileSync(path.join(env.hot, 'Beta Show', 'Beta Show - 01 [Studio].ass'), 'utf8')
    )
    // The metadata snapshot for every title in scope; no index.html (nothing renamed).
    for (const id of [101, 202, 303]) {
      expect(fs.existsSync(path.join(root, LIBRARY_DIR, 'meta', `${id}.json`))).toBe(true)
    }
    expect(fs.existsSync(path.join(root, 'index.html'))).toBe(false)
    expect(Object.keys(scan(root)).some((f) => f.endsWith(TMP_SUFFIX))).toBe(false)
    expect(env.svc.list()[0].status).toBe('completed')
  })

  it('a name the v1 rule changes: listed in naming.renamed, and index.html is written', async () => {
    // A Windows device name as the title folder: fine on this PC, renamed on the drive.
    const { key } = env.addEpisode({
      animeId: 404,
      title: 'CON',
      episodeInt: '1',
      translationId: 41
    })
    const job = await startOk(env, [key])
    await env.svc.settled(job.jobId)
    const root = path.join(env.drive, 'Trip')
    const m = manifestOf(root)
    expect(m.items[0].path).toBe('CON_/CON - 01 [Studio].mkv')
    expect(m.naming).toEqual({ rule: 'v1', renamed: [key] })
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    expect(html).toContain('CON_/CON%20-%2001%20%5BStudio%5D.mkv')
    expect(html).not.toContain('<script')
  })

  it('kill mid-file: the resume deletes the .anime-dl-tmp, completes, and lists each item once', async () => {
    const { a1, a2, b1, c1 } = seedPc(env)
    const kill = hangOn(/Beta Show - 01 \[Studio\]\.mp4\.anime-dl-tmp$/)
    const doomed = env.restart({ xfs: kill.xfs })
    const r = await doomed.start({
      selection: sel(a1, a2, b1, c1),
      target: env.drive,
      name: 'Trip'
    })
    expect(r.ok).toBe(true)
    await kill.hung
    const root = path.join(env.drive, 'Trip')
    const tmp = path.join(root, 'Beta Show', `Beta Show - 01 [Studio].mp4${TMP_SUFFIX}`)
    expect(fs.existsSync(tmp)).toBe(true)
    // Killed mid-job, the drive already holds a valid library with what the
    // last checkpoint (every 2 items here) recorded.
    const killed = await readLibrary(root)
    expect(killed.status).toBe('ok')
    if (killed.status === 'ok') expect(killed.manifest.items.map(itemKey)).toEqual([a1, a2])

    // The process is gone; a new one boots on the same userData.
    const svc = env.restart()
    await svc.init()
    const [job] = svc.list()
    expect(job.status).toBe('paused')
    await svc.resume(job.jobId)
    await svc.settled(job.jobId)

    expect(fs.existsSync(tmp)).toBe(false)
    const m = manifestOf(root)
    const keys = m.items.map(itemKey)
    expect(keys.sort()).toEqual([a1, a2, b1, c1].sort())
    expect(new Set(keys).size).toBe(keys.length)
    expect(svc.list()[0].status).toBe('completed')
    expect(sha256(path.join(root, 'Beta Show', 'Beta Show - 01 [Studio].mp4'))).toBe(
      sha256(path.join(env.hot, 'Beta Show', 'Beta Show - 01 [Studio].mp4'))
    )
  })

  it('kill mid-file, then the source goes: the resume still deletes the leftover .anime-dl-tmp', async () => {
    // A restarted copy truncates its own tmp anyway; this is the case where
    // the file is not copied again, so only the resume's cleanup removes it.
    const { a1, b1, c1 } = seedPc(env)
    const kill = hangOn(/Beta Show - 01 \[Studio\]\.mp4\.anime-dl-tmp$/)
    const doomed = env.restart({ xfs: kill.xfs })
    const r = await doomed.start({ selection: sel(a1, b1, c1), target: env.drive, name: 'Trip' })
    expect(r.ok).toBe(true)
    await kill.hung
    const root = path.join(env.drive, 'Trip')
    const tmp = path.join(root, 'Beta Show', `Beta Show - 01 [Studio].mp4${TMP_SUFFIX}`)
    expect(fs.existsSync(tmp)).toBe(true)
    fs.rmSync(path.join(env.hot, 'Beta Show'), { recursive: true })

    const svc = env.restart()
    await svc.init()
    const [job] = svc.list()
    await svc.resume(job.jobId)
    await svc.settled(job.jobId)
    expect(fs.existsSync(tmp)).toBe(false)
    const done = svc.list()[0]
    expect(done.status).toBe('completed')
    expect(done.failed.map((f) => f.key)).toEqual([b1])
    expect(manifestOf(root).items.map(itemKey).sort()).toEqual([a1, c1].sort())
  })

  it('kill mid-file, then the title folder becomes a plain file: the resume fails that item, not the drive (#614 review)', async () => {
    const { a1, b1, c1 } = seedPc(env)
    const kill = hangOn(/Beta Show - 01 \[Studio\]\.mp4\.anime-dl-tmp$/)
    const doomed = env.restart({ xfs: kill.xfs })
    const r = await doomed.start({ selection: sel(a1, b1, c1), target: env.drive, name: 'Trip' })
    expect(r.ok).toBe(true)
    await kill.hung
    const root = path.join(env.drive, 'Trip')
    fs.rmSync(path.join(root, 'Beta Show'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Beta Show'), 'not a folder')

    const svc = env.restart()
    await svc.init()
    const [job] = svc.list()
    await svc.resume(job.jobId)
    await svc.settled(job.jobId)
    const done = svc.list()[0]
    expect(done.status).toBe('completed')
    expect(done.failed.map((f) => f.key)).toEqual([b1])
    expect(manifestOf(root).items.map(itemKey).sort()).toEqual([a1, c1].sort())
  })

  it('Locate…: refuses a folder without the library, resumes at one with it, and keeps its "Found at" note', async () => {
    const { a1, b1, c1 } = seedPc(env)
    const kill = hangOn(/Beta Show - 01 \[Studio\]\.mp4\.anime-dl-tmp$/)
    const doomed = env.restart({ xfs: kill.xfs })
    const r = await doomed.start({ selection: sel(a1, b1, c1), target: env.drive, name: 'Trip' })
    expect(r.ok).toBe(true)
    await kill.hung
    const moved = path.join(env.dir, 'elsewhere')
    fs.mkdirSync(moved)
    fs.renameSync(path.join(env.drive, 'Trip'), path.join(moved, 'Trip'))

    const svc = env.restart({ setTimer: () => 0, clearTimer: () => {} })
    await svc.init()
    const [job] = svc.list()
    await svc.resume(job.jobId)
    await svc.settled(job.jobId)
    expect(svc.list()[0].status).toBe('waiting-drive')

    expect(await svc.locate(job.jobId, env.drive)).toEqual({
      ok: false,
      reason: "This folder doesn't hold the library 'Trip'."
    })
    expect(await svc.locate(job.jobId, moved)).toEqual({ ok: true })
    await svc.settled(job.jobId)
    const done = svc.list()[0]
    expect(done.status).toBe('completed')
    expect(done.root).toBe(path.join(moved, 'Trip'))
    expect(done.note).toBe(`Found at ${path.join(moved, 'Trip')}`)
    expect(manifestOf(path.join(moved, 'Trip')).items.map(itemKey).sort()).toEqual(
      [a1, b1, c1].sort()
    )
  })

  it('re-plug at a different path: resumes by libraryId there, and the impostor at the old path is unchanged', async () => {
    const { a1, a2, b1, c1 } = seedPc(env)
    const mountA = path.join(env.dir, 'mountA')
    const mountB = path.join(env.dir, 'mountB')
    fs.mkdirSync(mountA)
    fs.mkdirSync(mountB)
    const kill = hangOn(/Beta Show - 01 \[Studio\]\.mp4\.anime-dl-tmp$/)
    const doomed = env.restart({ xfs: kill.xfs })
    const r = await doomed.start({ selection: sel(a1, a2, b1, c1), target: mountA, name: 'Trip' })
    expect(r.ok).toBe(true)
    await kill.hung
    const oldRoot = path.join(mountA, 'Trip')

    // The stick comes back as another mount; a different stick, holding a
    // different library under the same name, takes the old path.
    fs.renameSync(oldRoot, path.join(mountB, 'Trip'))
    await seedLibrary(oldRoot, { libraryId: IMPOSTOR_LIB, name: 'Trip' })
    const before = scan(mountA)

    const svc = env.restart({ candidates: async () => [mountA, mountB] })
    await svc.init()
    const [job] = svc.list()
    await svc.resume(job.jobId)
    await svc.settled(job.jobId)

    const done = svc.list()[0]
    expect(done.status).toBe('completed')
    expect(done.root).toBe(path.join(mountB, 'Trip'))
    expect(done.note).toContain(path.join(mountB, 'Trip'))
    expect(scan(mountA)).toEqual(before)
    const m = manifestOf(path.join(mountB, 'Trip'))
    expect(m.items.map(itemKey).sort()).toEqual([a1, a2, b1, c1].sort())
  })

  it('drive missing: waits for the drive, writes nothing, and completes after it reappears', async () => {
    const { a1, a2, b1 } = seedPc(env)
    const kill = hangOn(/Alpha Show - 02 \[Studio\]\.mkv\.anime-dl-tmp$/)
    const doomed = env.restart({ xfs: kill.xfs })
    const r = await doomed.start({ selection: sel(a1, a2, b1), target: env.drive, name: 'Trip' })
    expect(r.ok).toBe(true)
    await kill.hung
    const root = path.join(env.drive, 'Trip')
    const away = path.join(env.dir, 'unplugged')
    fs.renameSync(root, away)
    const driveBefore = scan(env.drive)
    const awayBefore = scan(away)

    const timers: (() => void)[] = []
    const svc = env.restart({
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => {}
    })
    await svc.init()
    const [job] = svc.list()
    await svc.resume(job.jobId)
    await svc.settled(job.jobId)
    expect(svc.list()[0].status).toBe('waiting-drive')
    expect(timers).toHaveLength(1)
    expect(fs.existsSync(root)).toBe(false)
    expect(scan(env.drive)).toEqual(driveBefore)

    // The 10 s retry, with the drive still gone: still nothing written.
    timers.shift()!()
    await svc.settled(job.jobId)
    expect(svc.list()[0].status).toBe('waiting-drive')
    expect(scan(env.drive)).toEqual(driveBefore)
    expect(scan(away)).toEqual(awayBefore)

    fs.renameSync(away, root)
    timers.shift()!()
    await svc.settled(job.jobId)
    expect(svc.list()[0].status).toBe('completed')
    expect(manifestOf(root).items.map(itemKey).sort()).toEqual([a1, a2, b1].sort())
  })

  it('a drive pulled mid-job with its mount point left behind: the empty folder is never written', async () => {
    const { a1, a2, b1, c1 } = seedPc(env)
    const root = path.join(env.drive, 'Trip')
    const away = path.join(env.dir, 'unplugged')
    let pulled = false
    const timers: (() => void)[] = []
    const svc = env.restart({
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => {},
      xfs: {
        open: async (p, flags) => {
          const h = await nodeFs.open(p, flags)
          if (!/Alpha Show - 02 .*\.anime-dl-tmp$/.test(p)) return h
          return {
            ...h,
            write: async (buf) => {
              if (!pulled) {
                // The drive goes; the mount point stays, empty (a /mnt-style mount).
                pulled = true
                fs.renameSync(root, away)
                fs.mkdirSync(root)
              }
              await h.write(buf)
            }
          }
        }
      }
    })
    const r = await svc.start({ selection: sel(a1, a2, b1, c1), target: env.drive, name: 'Trip' })
    if (!r.ok) throw new Error(r.reason)
    await svc.settled(r.job.jobId)

    expect(svc.list()[0].status).toBe('waiting-drive')
    expect(svc.list()[0].note).toMatch(/^The drive went away: /)
    expect(fs.readdirSync(root)).toEqual([])
    expect(svc.list()[0].failed).toEqual([])

    fs.rmdirSync(root)
    fs.renameSync(away, root)
    timers.shift()!()
    await svc.settled(r.job.jobId)
    expect(svc.list()[0].status).toBe('completed')
    // The drive is back: the note that said it went away is gone.
    expect(svc.list()[0].note).toBeNull()
    expect(manifestOf(root).items.map(itemKey).sort()).toEqual([a1, a2, b1, c1].sort())
    expect(Object.keys(scan(root)).some((f) => f.endsWith(TMP_SUFFIX))).toBe(false)
  })

  it('a plain file at .anime-dl/meta: a snapshot warning, not a lost drive; the videos are copied (#614 review)', async () => {
    const { a1, b1 } = seedPc(env)
    const root = path.join(env.drive, 'Trip')
    await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Trip' })
    fs.writeFileSync(path.join(root, LIBRARY_DIR, 'meta'), 'not a folder')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const job = await startOk(env, [a1, b1], 'Trip')
      await env.svc.settled(job.jobId)
      const done = env.svc.list()[0]
      expect(done.status).toBe('completed')
      expect(done.failed).toEqual([])
      expect(manifestOf(root).items.map(itemKey).sort()).toEqual([a1, b1].sort())
      expect(warn.mock.calls.some((c) => String(c[0]).includes('snapshot of 101 failed'))).toBe(
        true
      )
      expect(fs.readFileSync(path.join(root, LIBRARY_DIR, 'meta'), 'utf8')).toBe('not a folder')
    } finally {
      warn.mockRestore()
    }
  })

  it('a plain file where a title folder should be: that item fails, the job completes (#614 review)', async () => {
    const { a1, b1 } = seedPc(env)
    const root = path.join(env.drive, 'Trip')
    await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Trip' })
    fs.writeFileSync(path.join(root, 'Alpha Show'), 'not a folder')
    const job = await startOk(env, [a1, b1], 'Trip')
    await env.svc.settled(job.jobId)
    const done = env.svc.list()[0]
    expect(done.status).toBe('completed')
    expect(done.failed.map((f) => f.key)).toEqual([a1])
    expect(manifestOf(root).items.map(itemKey)).toEqual([b1])
  })

  it('a drive pulled while a title’s meta is written: the resume writes its meta and poster (#614 review)', async () => {
    const { a1, b1 } = seedPc(env)
    fs.mkdirSync(path.join(env.userData, 'poster-cache'))
    const poster = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 7])
    fs.writeFileSync(path.join(env.userData, 'poster-cache', '101.jpg'), poster)
    const root = path.join(env.drive, 'Trip')
    const away = path.join(env.dir, 'unplugged')
    let pulled = false
    const timers: (() => void)[] = []
    const svc = env.restart({
      setTimer: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimer: () => {},
      xfs: {
        open: async (p, flags) => {
          if (!pulled && p.endsWith(path.join('meta', `101.json${TMP_SUFFIX}`))) {
            pulled = true
            fs.renameSync(root, away)
          }
          return nodeFs.open(p, flags)
        }
      }
    })
    const r = await svc.start({ selection: sel(a1, b1), target: env.drive, name: 'Trip' })
    if (!r.ok) throw new Error(r.reason)
    await svc.settled(r.job.jobId)
    expect(pulled).toBe(true)
    expect(svc.list()[0].status).toBe('waiting-drive')
    expect(svc.list()[0].note).toMatch(/^The drive went away: /)

    fs.renameSync(away, root)
    timers.shift()!()
    await svc.settled(r.job.jobId)
    expect(svc.list()[0].status).toBe('completed')
    expect(svc.list()[0].note).toBeNull()
    expect(fs.existsSync(path.join(root, LIBRARY_DIR, 'meta', '101.json'))).toBe(true)
    expect(fs.readFileSync(path.join(root, LIBRARY_DIR, 'posters', '101.jpg'))).toEqual(poster)
    expect(manifestOf(root).items.map(itemKey).sort()).toEqual([a1, b1].sort())
  })

  it('pause mid-file: the paused job’s bytesDone leaves out the aborted file’s partial bytes (#614 review)', async () => {
    const a1 = env.addEpisode({
      animeId: 101,
      title: 'Alpha Show',
      episodeInt: '1',
      translationId: 11
    })
    const a2 = env.addEpisode({
      animeId: 101,
      title: 'Alpha Show',
      episodeInt: '2',
      translationId: 12,
      bytes: 3 * 1024 * 1024
    })
    let jobId = ''
    let svc: ReturnType<ExportEnv['restart']> | null = null
    let paused: Promise<unknown> | null = null
    svc = env.restart({
      xfs: {
        open: async (p, flags) => {
          const h = await nodeFs.open(p, flags)
          if (!/Alpha Show - 02 .*\.anime-dl-tmp$/.test(p)) return h
          return {
            ...h,
            write: async (buf) => {
              await h.write(buf)
              // The first 1 MB chunk is down; the user presses Pause.
              paused ??= svc!.pause(jobId)
            }
          }
        }
      }
    })
    const r = await svc.start({ selection: sel(a1.key, a2.key), target: env.drive, name: 'Trip' })
    if (!r.ok) throw new Error(r.reason)
    jobId = r.job.jobId
    await svc.settled(jobId)
    await paused
    const a1Size = fs.statSync(a1.video).size
    const job = svc.list()[0]
    expect(job.status).toBe('paused')
    expect(job.filesDone).toBe(1)
    expect(job.bytesDone).toBe(a1Size)
    const lastPaused = env.updates.filter((u) => u.status === 'paused').at(-1)
    expect(lastPaused?.bytesDone).toBe(a1Size)
  })

  it('cancel: the library stays valid with the finished items', async () => {
    const { a1, a2, b1, c1 } = seedPc(env)
    let cancelSvc: (() => void) | null = null
    let gate!: () => void
    const reached = new Promise<void>((r) => (gate = r))
    const svc = env.restart({
      xfs: {
        open: async (p, flags) => {
          const h = await nodeFs.open(p, flags)
          if (!/Beta Show - 01/.test(p)) return h
          return {
            ...h,
            write: async (buf) => {
              gate()
              await new Promise((r) => setTimeout(r, 5))
              cancelSvc?.()
              await h.write(buf)
            }
          }
        }
      }
    })
    const r = await svc.start({ selection: sel(a1, a2, b1, c1), target: env.drive, name: 'Trip' })
    if (!r.ok) throw new Error(r.reason)
    let cancelled: Promise<unknown> | null = null
    cancelSvc = () => {
      cancelled ??= svc.cancel(r.job.jobId)
    }
    await reached
    await svc.settled(r.job.jobId)
    await cancelled
    const root = path.join(env.drive, 'Trip')
    const read = await readLibrary(root)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.manifest.items.map(itemKey).sort()).toEqual([a1, a2].sort())
    expect(svc.list()[0].status).toBe('cancelled')
    expect(Object.keys(scan(root)).some((f) => f.endsWith(TMP_SUFFIX))).toBe(false)
    for (const item of read.manifest.items) {
      expect(fs.existsSync(path.join(root, ...item.path.split('/')))).toBe(true)
    }
  })

  it('adds to a Videos-only library another PC made, with no shikimoriUser: only the new items, and the estimate equals their bytes', async () => {
    const { a1, a2, b1 } = seedPc(env)
    const root = path.join(env.drive, 'Shared')
    // The other PC already put a1 on the drive, same size.
    const a1Size = fs.statSync(
      path.join(env.hot, 'Alpha Show', 'Alpha Show - 01 [Studio].mkv')
    ).size
    fs.mkdirSync(path.join(root, 'Alpha Show'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'Alpha Show', 'Alpha Show - 01 [Studio].mkv'),
      bytesFor('x', a1Size)
    )
    await seedLibrary(root, {
      libraryId: OTHER_LIB,
      name: 'Shared',
      titles: [{ animeId: 101, name: 'Alpha Show' }],
      items: [
        {
          animeId: 101,
          episodeInt: '1',
          translationId: 11,
          translationType: 'subRu',
          author: 'Studio',
          quality: 720,
          path: 'Alpha Show/Alpha Show - 01 [Studio].mkv',
          size: a1Size
        }
      ]
    })
    const a1Before = sha256(path.join(root, 'Alpha Show', 'Alpha Show - 01 [Studio].mkv'))

    const plan = await env.svc.plan({ animeIds: [101, 202], target: env.drive, name: 'Shared' })
    expect(plan.target?.kind).toBe('add')
    expect(plan.target?.root).toBe(root)
    expect(plan.target?.present).toEqual([a1])
    const { exportEstimate } = await import('../../src/shared/shared-library-export')
    const est = exportEstimate(plan.titles, new Set([a1, a2, b1]), plan.target!.present)
    const newBytes =
      fs.statSync(path.join(env.cold, 'Alpha Show', 'Alpha Show - 02 [Studio].mkv')).size +
      fs.statSync(path.join(env.hot, 'Beta Show', 'Beta Show - 01 [Studio].mp4')).size +
      fs.statSync(path.join(env.hot, 'Beta Show', 'Beta Show - 01 [Studio].ass')).size
    expect(est.bytes).toBe(newBytes)
    expect(est.alreadyThere).toBe(1)

    const job = await startOk(env, [a1, a2, b1], 'Shared')
    expect(job.bytesTotal).toBe(newBytes)
    await env.svc.settled(job.jobId)
    const m = manifestOf(root)
    expect(m.libraryId).toBe(OTHER_LIB)
    expect(m.owner).toBeNull()
    expect(m.lastWriter?.installId).toBe('pc-export')
    expect(m.items.map(itemKey).sort()).toEqual([a1, a2, b1].sort())
    // a1 was not copied again.
    expect(sha256(path.join(root, 'Alpha Show', 'Alpha Show - 01 [Studio].mkv'))).toBe(a1Before)
  })

  it('an own With metadata target: the plan reports the blocker, the start refuses, and nothing under it changes', async () => {
    env.cleanup()
    env = makeExportEnv({}, { shikimoriUser: ME })
    const { a1 } = seedPc(env)
    const root = path.join(env.drive, 'Mine')
    await seedLibrary(root, {
      libraryId: OTHER_LIB,
      name: 'Mine',
      owner: { shikimoriId: ME.id, nickname: ME.nickname }
    })
    const before = scan(env.drive)

    const plan = await env.svc.plan({ animeIds: [101], target: env.drive, name: 'Mine' })
    expect(plan.target?.kind).toBe('own-metadata')
    expect(plan.target?.blocked).toBe(BLOCKED_OWN_METADATA)
    const r = await env.svc.start({ selection: sel(a1), target: env.drive, name: 'Mine' })
    expect(r).toEqual({ ok: false, reason: BLOCKED_OWN_METADATA })
    expect(scan(env.drive)).toEqual(before)
    expect(env.svc.list()).toEqual([])
  })

  it('a foreign library at the target is never written; a sibling is created instead', async () => {
    const { a1, b1 } = seedPc(env)
    const foreign = path.join(env.drive, 'Trip')
    await seedLibrary(foreign, {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: { shikimoriId: 777, nickname: 'friend' }
    })
    const before = scan(foreign)

    const plan = await env.svc.plan({ animeIds: [101], target: env.drive, name: 'Trip' })
    expect(plan.target?.kind).toBe('foreign')
    expect(plan.target?.ownerNickname).toBe('friend')
    expect(plan.target?.root).toBe(path.join(env.drive, 'Trip (2)'))

    const job = await startOk(env, [a1, b1], 'Trip')
    await env.svc.settled(job.jobId)
    expect(scan(foreign)).toEqual(before)
    const sibling = await readLibrary(path.join(env.drive, 'Trip (2)'))
    expect(sibling.status).toBe('ok')
    if (sibling.status !== 'ok') return
    expect(sibling.manifest.libraryId).not.toBe(OTHER_LIB)
    expect(sibling.manifest.items.map(itemKey).sort()).toEqual([a1, b1].sort())
  })

  it('a re-export next to a foreign library adds to the sibling the first export made (#614 review)', async () => {
    const { a1, b1 } = seedPc(env)
    const foreign = path.join(env.drive, 'Trip')
    await seedLibrary(foreign, {
      libraryId: OTHER_LIB,
      name: 'Trip',
      owner: { shikimoriId: 777, nickname: 'friend' }
    })
    const before = scan(foreign)
    const first = await startOk(env, [a1], 'Trip')
    await env.svc.settled(first.jobId)
    const sibling = path.join(env.drive, 'Trip (2)')
    const firstId = manifestOf(sibling).libraryId

    const plan = await env.svc.plan({ animeIds: [101, 202], target: env.drive, name: 'Trip' })
    expect(plan.target?.root).toBe(sibling)
    expect(plan.target?.kind).toBe('add')
    expect(plan.target?.ownerNickname).toBe('friend')
    expect(plan.target?.present).toEqual([a1])

    const second = await startOk(env, [a1, b1], 'Trip')
    expect(second.filesTotal).toBe(2)
    await env.svc.settled(second.jobId)
    expect(fs.existsSync(path.join(env.drive, 'Trip (3)'))).toBe(false)
    const m = manifestOf(sibling)
    expect(m.libraryId).toBe(firstId)
    expect(m.items.map(itemKey).sort()).toEqual([a1, b1].sort())
    expect(scan(foreign)).toEqual(before)
  })

  it('a symlinked title folder leading out of the root: the file is skipped and nothing lands outside', async () => {
    const { a1, b1 } = seedPc(env)
    const root = path.join(env.drive, 'Trip')
    await seedLibrary(root, { libraryId: OTHER_LIB, name: 'Trip' })
    const outside = path.join(env.dir, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(root, 'Alpha Show'))

    const job = await startOk(env, [a1, b1], 'Trip')
    await env.svc.settled(job.jobId)
    const done = env.svc.list()[0]
    expect(done.status).toBe('completed')
    expect(done.failed.map((f) => f.key)).toEqual([a1])
    expect(done.failed[0].reason).toMatch(/outside the library/)
    expect(fs.readdirSync(outside)).toEqual([])
    expect(manifestOf(root).items.map(itemKey)).toEqual([b1])
  })

  it('a verify failure marks the file failed and leaves it out of the manifest', async () => {
    const { a1, a2, c1 } = seedPc(env)
    const svc = env.restart({
      xfs: {
        open: async (p, flags) => {
          const h = await nodeFs.open(p, flags)
          if (!/Alpha Show - 02 .*\.anime-dl-tmp$/.test(p)) return h
          let first = true
          return {
            ...h,
            write: async (buf) => {
              const out = Buffer.from(buf)
              if (first) out[0] ^= 0xff
              first = false
              await h.write(out)
            }
          }
        }
      }
    })
    const r = await svc.start({ selection: sel(a1, a2, c1), target: env.drive, name: 'Trip' })
    if (!r.ok) throw new Error(r.reason)
    await svc.settled(r.job.jobId)
    const job = svc.list()[0]
    expect(job.status).toBe('completed')
    expect(job.failed.map((f) => f.key)).toEqual([a2])
    expect(job.failed[0].reason).toMatch(/verify failed/)
    const root = path.join(env.drive, 'Trip')
    expect(manifestOf(root).items.map(itemKey).sort()).toEqual([a1, c1].sort())
    expect(fs.existsSync(path.join(root, 'Alpha Show', 'Alpha Show - 02 [Studio].mkv'))).toBe(false)
  })
})
