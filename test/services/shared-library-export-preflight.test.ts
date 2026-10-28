// The export preflight (#575). CI can't make FAT32 or NTFS filesystems, so the
// type probe is injected, and so is the write probe where a test needs it to
// change between plan and start; the read-only parent uses a real `chmod`.

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { absoluteOverflow } from '../../src/main/lib/shared-library/paths'
import { readLibrary } from '../../src/main/lib/shared-library/read'
import {
  FAT32_MAX_FILE_SIZE,
  TooLargeError,
  copyVerified,
  isTooLargeForFilesystem,
  nodeFs,
  type ExportFs
} from '../../src/main/services/shared-library-export/copy'
import {
  createFsTypeProbe,
  parseDfMountPoint,
  parseDiskutilPlist,
  parseFindmnt,
  parseGetVolume,
  type FsProbeResult,
  type RunCommand
} from '../../src/main/services/shared-library-export/fs-type-probe'
import {
  PROBE_PREFIX,
  createWriteProbe,
  nearestExistingAncestor,
  preflight,
  probeFolder,
  windowsStyleRoot,
  type PreflightDeps,
  type PreflightItem
} from '../../src/main/services/shared-library-export/preflight'
import { makeExportEnv, sel, type ExportEnv } from '../helpers/shared-library-export'

const FIX = path.join(__dirname, '..', 'fixtures', 'fs-type-probe')
const fixture = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8')

let env: ExportEnv | null = null
let tmp: string | null = null
afterEach(() => {
  env?.cleanup()
  env = null
  if (tmp) {
    fs.chmodSync(tmp, 0o755)
    for (const d of fs.readdirSync(tmp)) fs.chmodSync(path.join(tmp, d), 0o755)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  tmp = null
})

const makeTmp = (): string => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-preflight-')))
  return tmp
}

const fsType =
  (t: ExportFsType, mountPoint: string | null = null) =>
  async (): Promise<FsProbeResult> => ({
    fsType: t,
    mountPoint
  })

const errno = (code: string, message = code): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code })

function item(
  key: string,
  size: number,
  over: Partial<PreflightItem['naming']> = {}
): PreflightItem {
  const [animeId, episodeInt, translationId] = key.split(':')
  return {
    key,
    size,
    naming: {
      animeId: Number(animeId),
      episodeInt,
      translationId: Number(translationId),
      title: 'Movie',
      author: 'Studio',
      ext: '.mkv',
      ...over
    }
  }
}

/** Preflight deps that touch nothing: every path is a folder, the write probe succeeds. */
function fakeDeps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    xfs: { stat: nodeFs.stat, readdir: async () => [], unlink: async () => {} },
    isDirectory: async () => true,
    fsTypeProbe: fsType('unknown'),
    writeProbe: async () => {},
    platform: 'linux',
    now: Date.now,
    ...over
  }
}

describe('FAT32: a file over 4 GiB − 1 bytes is skipped, one of exactly 4 GiB − 1 is kept', () => {
  it('the boundary pair on fat32 (red on a `≥` rule)', async () => {
    const r = await preflight(
      {
        items: [item('1:1:1', FAT32_MAX_FILE_SIZE), item('1:2:1', FAT32_MAX_FILE_SIZE + 1)],
        existing: []
      },
      { root: '/media/u/STICK/Lib' },
      fakeDeps({ fsTypeProbe: fsType('fat32') })
    )
    expect(FAT32_MAX_FILE_SIZE).toBe(4_294_967_295)
    expect(r.skipped).toEqual(['1:2:1'])
    expect(r.named.map((n) => n.key)).toEqual(['1:1:1'])
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual(['This drive is FAT32: 1 file over 4 GB will be skipped.'])
  })

  it('a 4.5 GB movie is skipped and a 668 MB episode kept', async () => {
    const r = await preflight(
      { items: [item('1:1:1', 4_500_000_000), item('2:1:1', 668_000_000)], existing: [] },
      { root: '/media/u/STICK/Lib' },
      fakeDeps({ fsTypeProbe: fsType('fat32') })
    )
    expect(r.skipped).toEqual(['1:1:1'])
    expect(r.named.map((n) => n.key)).toEqual(['2:1:1'])
  })

  it.each(['unknown', 'exfat', 'ntfs'] as const)(
    '%s: no type-based warning, nothing skipped',
    async (t) => {
      const r = await preflight(
        {
          items: [item('1:1:1', 4_500_000_000), item('1:2:1', FAT32_MAX_FILE_SIZE + 1)],
          existing: []
        },
        { root: '/media/u/STICK/Lib' },
        fakeDeps({ fsTypeProbe: fsType(t) })
      )
      expect(r.fsType).toBe(t)
      expect(r.skipped).toEqual([])
      expect(r.warnings).toEqual([])
      expect(r.blockers).toEqual([])
    }
  )

  it('an S6c re-encode whose source is over the limit is warned about, not skipped', async () => {
    const r = await preflight(
      { items: [{ ...item('1:1:1', 4_500_000_000), reencode: true }], existing: [] },
      { root: '/media/u/STICK/Lib' },
      fakeDeps({ fsTypeProbe: fsType('fat32') })
    )
    expect(r.skipped).toEqual([])
    expect(r.mayBeSkipped).toEqual(['1:1:1'])
    expect(r.named.map((n) => n.key)).toEqual(['1:1:1'])
    expect(r.warnings).toEqual(['1 re-encoded file may be skipped if it’s still over 4 GB.'])
  })

  it('the job copies only the kept items; the skipped one is listed on the job (red on main: copied)', async () => {
    env = makeExportEnv({ fsTypeProbe: fsType('fat32') })
    const movie = env.addEpisode({ animeId: 7, title: 'Film', episodeInt: '1', translationId: 11 })
    const ep = env.addEpisode({ animeId: 8, title: 'Show', episodeInt: '1', translationId: 12 })
    const sizes: Record<string, number> = { [movie.video]: 4_500_000_000, [ep.video]: 668_000_000 }
    const svc = env.restart({
      xfs: {
        stat: async (p) => {
          const st = await fs.promises.stat(p)
          return sizes[p] === undefined ? st : Object.assign(st, { size: sizes[p] })
        },
        statfs: async () => ({ bavail: 1e12, bsize: 1 })
      }
    })

    const plan = await svc.plan({ animeIds: [7, 8], target: env.drive, name: 'Lib' })
    expect(plan.preflight?.skipped).toEqual([movie.key])
    expect(plan.preflight?.warnings).toEqual([
      'This drive is FAT32: 1 file over 4 GB will be skipped.'
    ])

    const r = await svc.start({ selection: sel(movie.key, ep.key), target: env.drive, name: 'Lib' })
    if (!r.ok) throw new Error(r.reason)
    await svc.settled(r.job.jobId)
    const job = svc.list()[0]
    expect(job.status).toBe('completed')
    expect(job.skipped).toEqual([
      { key: movie.key, label: 'Film — Episode 1', reason: 'too-large-for-filesystem' }
    ])
    expect(job.filesTotal).toBe(1)
    const lib = await readLibrary(path.join(env.drive, 'Lib'))
    if (lib.status !== 'ok') throw new Error(lib.status)
    expect(
      lib.manifest.items.map((i) => `${i.animeId}:${i.episodeInt}:${i.translationId}`)
    ).toEqual([ep.key])
    expect(fs.existsSync(path.join(env.drive, 'Lib', 'Film'))).toBe(false)
  })

  it('start refuses when every selected file is skipped', async () => {
    env = makeExportEnv({ fsTypeProbe: fsType('fat32') })
    const movie = env.addEpisode({ animeId: 7, title: 'Film', episodeInt: '1', translationId: 11 })
    const svc = env.restart({
      xfs: {
        stat: async (p) => {
          const st = await fs.promises.stat(p)
          return p === movie.video ? Object.assign(st, { size: 4_500_000_000 }) : st
        }
      }
    })
    const r = await svc.start({ selection: sel(movie.key), target: env.drive, name: 'Lib' })
    expect(r).toEqual({
      ok: false,
      reason:
        'Nothing to copy: every selected file is over 4 GB, which this FAT32 drive can’t hold.'
    })
    expect(fs.existsSync(path.join(env.drive, 'Lib'))).toBe(false)
  })
})

describe('the nearest existing ancestor', () => {
  it('walks up with stat only, to the filesystem root', async () => {
    const seen: string[] = []
    const isDir = async (p: string): Promise<boolean> => {
      seen.push(p)
      return p === '/a'
    }
    expect(await nearestExistingAncestor('/a/b/c', isDir)).toBe('/a')
    expect(seen).toEqual(['/a/b/c', '/a/b', '/a'])
    expect(await nearestExistingAncestor('/x/y', async () => false)).toBe('/')
  })

  it('a target whose parents don’t exist yet: both probes run in <tmp>/a and no folder is created', async () => {
    env = makeExportEnv()
    const a = path.join(env.dir, 'a')
    fs.mkdirSync(a)
    const typeProbe = vi.fn(fsType('ext'))
    const writeProbe = vi.fn(createWriteProbe(nodeFs))
    const svc = env.restart({ fsTypeProbe: typeProbe, writeProbe })
    const plan = await svc.plan({
      animeIds: null,
      target: path.join(a, 'b'),
      name: 'new-library'
    })
    expect(plan.target?.root).toBe(path.join(a, 'b', 'new-library'))
    expect(typeProbe.mock.calls).toEqual([[a]])
    expect(writeProbe.mock.calls).toEqual([[a]])
    expect(plan.preflight?.ok).toBe(true)
    expect(fs.readdirSync(a)).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a read-only <tmp>/a (chmod 0555) is a blocker, from the real write probe',
    async () => {
      const root = makeTmp()
      const a = path.join(root, 'a')
      fs.mkdirSync(a)
      fs.chmodSync(a, 0o555)
      const r = await preflight(
        { items: [item('1:1:1', 10)], existing: [] },
        { root: path.join(a, 'b', 'new-library') },
        {
          ...fakeDeps({ fsTypeProbe: fsType('ext') }),
          xfs: nodeFs,
          isDirectory: async (p) => (await fs.promises.stat(p)).isDirectory(),
          writeProbe: createWriteProbe(nodeFs)
        }
      )
      expect(r.ok).toBe(false)
      expect(r.blockers).toEqual([
        'This folder is read-only for you on this computer: you don’t have permission to write to it.'
      ])
      expect(fs.readdirSync(a)).toEqual([])
    }
  )

  it('the probe file is gone afterwards, even when the write throws', async () => {
    const root = makeTmp()
    const xfs: ExportFs = {
      ...nodeFs,
      open: async (p, flags) => {
        const h = await nodeFs.open(p, flags)
        return {
          ...h,
          write: async () => {
            throw errno('EIO', 'EIO: i/o error, write')
          }
        }
      }
    }
    await expect(createWriteProbe(xfs)(root)).rejects.toMatchObject({ code: 'EIO' })
    expect(fs.readdirSync(root)).toEqual([])

    // Through the folder probe it is a warning, not a blocker.
    const p = await probeFolder(root, { ...fakeDeps(), xfs, writeProbe: createWriteProbe(xfs) })
    expect(p.blockers).toEqual([])
    expect(p.driveWarnings).toEqual([
      'Couldn’t check that this folder can be written (EIO). Any write error will show during the copy.'
    ])
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('a successful probe leaves nothing behind', async () => {
    const root = makeTmp()
    await createWriteProbe(nodeFs)(root)
    expect(fs.readdirSync(root)).toEqual([])
  })
})

describe('writable: the type alone never blocks', () => {
  it('ntfs on macOS with an EROFS probe is a blocker', async () => {
    const r = await preflight(
      { items: [item('1:1:1', 10)], existing: [] },
      { root: '/Volumes/STICK/Lib' },
      fakeDeps({
        platform: 'darwin',
        fsTypeProbe: fsType('ntfs'),
        writeProbe: async () => {
          throw errno('EROFS')
        }
      })
    )
    expect(r.ok).toBe(false)
    expect(r.blockers).toEqual(['This drive is read-only on this computer (NTFS on macOS).'])
  })

  it('ntfs on macOS with a writable probe (a third-party driver) is no blocker', async () => {
    const r = await preflight(
      { items: [item('1:1:1', 10)], existing: [] },
      { root: '/Volumes/STICK/Lib' },
      fakeDeps({ platform: 'darwin', fsTypeProbe: fsType('ntfs') })
    )
    expect(r.ok).toBe(true)
    expect(r.blockers).toEqual([])
  })

  it.each(['EACCES', 'EPERM'])('%s is a blocker too', async (code) => {
    const r = await preflight(
      { items: [], existing: [] },
      { root: '/media/u/STICK/Lib' },
      fakeDeps({
        writeProbe: async () => {
          throw errno(code)
        }
      })
    )
    expect(r.ok).toBe(false)
  })
})

describe('the dialog probes once per folder; start probes again', () => {
  it('the plan’s probe succeeds, the drive turns EROFS: start refuses with the same blocker', async () => {
    env = makeExportEnv({ fsTypeProbe: fsType('ntfs'), platform: 'darwin' })
    const a1 = env.addEpisode({ animeId: 7, title: 'Show', episodeInt: '1', translationId: 11 })
    let readOnly = false
    const writeProbe = vi.fn(async () => {
      if (readOnly) throw errno('EROFS')
    })
    const svc = env.restart({ writeProbe })
    const plan = await svc.plan({ animeIds: [7], target: env.drive, name: 'Lib', session: 's1' })
    expect(plan.preflight?.ok).toBe(true)

    readOnly = true
    const r = await svc.start({ selection: sel(a1.key), target: env.drive, name: 'Lib' })
    expect(r).toEqual({
      ok: false,
      reason: 'This drive is read-only on this computer (NTFS on macOS).'
    })
    expect(writeProbe).toHaveBeenCalledTimes(2)
    expect(fs.readdirSync(env.drive)).toEqual([])
    expect(svc.list()).toEqual([])

    // The dialog shows the same message once it re-probes (a new dialog).
    const again = await svc.plan({ animeIds: [7], target: env.drive, name: 'Lib', session: 's2' })
    expect(again.preflight?.blockers).toEqual([r.ok ? '' : r.reason])
  })

  it('within one dialog, a new library name re-plans without a new probe; another folder probes', async () => {
    env = makeExportEnv()
    env.addEpisode({ animeId: 7, title: 'Show', episodeInt: '1', translationId: 11 })
    const other = path.join(env.dir, 'other')
    fs.mkdirSync(other)
    const writeProbe = vi.fn(async () => {})
    const typeProbe = vi.fn(fsType('exfat'))
    const svc = env.restart({ writeProbe, fsTypeProbe: typeProbe })
    for (const name of ['Lib', 'Lib 2', 'Lib 3']) {
      await svc.plan({ animeIds: [7], target: env.drive, name, session: 's1' })
    }
    expect(writeProbe.mock.calls).toEqual([[env.drive]])
    expect(typeProbe).toHaveBeenCalledTimes(1)
    await svc.plan({ animeIds: [7], target: other, name: 'Lib', session: 's1' })
    expect(writeProbe.mock.calls).toEqual([[env.drive], [other]])
  })
})

describe('stale probe files', () => {
  it('a 2 h-old probe file is removed, a 1-minute-old one and unrelated files are left alone', async () => {
    const root = makeTmp()
    const now = Date.now()
    const touch = (name: string, ageMs: number): void => {
      const p = path.join(root, name)
      fs.writeFileSync(p, '.')
      const t = new Date(now - ageMs)
      fs.utimesSync(p, t, t)
    }
    touch(`${PROBE_PREFIX}old`, 2 * 60 * 60 * 1000)
    touch(`${PROBE_PREFIX}fresh`, 60 * 1000)
    touch('unrelated-old.txt', 2 * 60 * 60 * 1000)
    touch('anime-dl-probe-no-dot', 2 * 60 * 60 * 1000)
    await probeFolder(root, { ...fakeDeps(), xfs: nodeFs, now: () => now })
    expect(fs.readdirSync(root).sort()).toEqual(
      [`${PROBE_PREFIX}fresh`, 'anime-dl-probe-no-dot', 'unrelated-old.txt'].sort()
    )
  })
})

describe('the run-time size rule', () => {
  it('EFBIG, ffmpeg’s "File too large", or a FAT32 temp file at 4 GiB − 1 is too large; EIO is not', () => {
    expect(isTooLargeForFilesystem(errno('EFBIG'), 'unknown', null)).toBe(true)
    expect(
      isTooLargeForFilesystem(
        new Error('Error writing trailer of out.mkv: File too large'),
        'unknown',
        null
      )
    ).toBe(true)
    const enospc = errno('ENOSPC', 'ENOSPC: no space left on device, write')
    expect(isTooLargeForFilesystem(enospc, 'fat32', FAT32_MAX_FILE_SIZE)).toBe(true)
    expect(isTooLargeForFilesystem(enospc, 'fat32', FAT32_MAX_FILE_SIZE - 1)).toBe(false)
    expect(isTooLargeForFilesystem(enospc, 'exfat', FAT32_MAX_FILE_SIZE)).toBe(false)
    expect(isTooLargeForFilesystem(errno('EIO'), 'fat32', 10)).toBe(false)
  })

  it('copyVerified: a FAT32 temp file at the limit becomes a TooLargeError, and the temp file is deleted', async () => {
    const root = makeTmp()
    const src = path.join(root, 'src.bin')
    fs.writeFileSync(src, Buffer.alloc(64))
    const dest = path.join(root, 'out', 'x.mkv')
    const xfs: ExportFs = {
      ...nodeFs,
      stat: async (p) =>
        p.endsWith('.anime-dl-tmp')
          ? { size: FAT32_MAX_FILE_SIZE, dev: 0, ino: 0, mtimeMs: 0 }
          : nodeFs.stat(p),
      open: async (p, flags) => {
        const h = await nodeFs.open(p, flags)
        return {
          ...h,
          write: async () => {
            throw errno('ENOSPC')
          }
        }
      }
    }
    await expect(copyVerified(xfs, src, dest, { fsType: 'fat32' })).rejects.toBeInstanceOf(
      TooLargeError
    )
    expect(fs.readdirSync(path.join(root, 'out'))).toEqual([])
    await expect(copyVerified(xfs, src, dest, { fsType: 'exfat' })).rejects.toMatchObject({
      code: 'ENOSPC'
    })
  })

  /** A job on fake FAT32 whose third file's write throws `err`. */
  async function jobWithThirdWriteFailing(err: () => Error): Promise<{
    keys: string[]
    job: ExportJobView
  }> {
    env = makeExportEnv({ fsTypeProbe: fsType('fat32') })
    const keys = [1, 2, 3, 4].map(
      (n) =>
        env!.addEpisode({ animeId: 7, title: 'Show', episodeInt: String(n), translationId: 10 + n })
          .key
    )
    let opened = 0
    const svc = env.restart({
      xfs: {
        open: async (p, flags) => {
          const h = await nodeFs.open(p, flags)
          if (!p.endsWith('.anime-dl-tmp') || !p.includes(' - ')) return h
          opened++
          if (opened !== 3) return h
          return {
            ...h,
            write: async (buf) => {
              await h.write(buf.subarray(0, 100))
              throw err()
            }
          }
        }
      }
    })
    const r = await svc.start({ selection: sel(...keys), target: env.drive, name: 'Lib' })
    if (!r.ok) throw new Error(r.reason)
    await svc.settled(r.job.jobId)
    return { keys, job: svc.list()[0] }
  }

  const tmpFiles = (dir: string): string[] => {
    const out: string[] = []
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name))
        else if (e.name.endsWith('.anime-dl-tmp')) out.push(e.name)
      }
    }
    walk(dir)
    return out
  }

  it.each([
    ['EFBIG on the copy', () => errno('EFBIG', 'EFBIG: file too large, write')],
    [
      'a fake ffmpeg "File too large" (S6c re-encode)',
      () => new Error('av_interleaved_write_frame(): File too large')
    ]
  ])(
    '%s: skipped as too-large-for-filesystem, temp deleted, the rest completes',
    async (_n, err) => {
      const { keys, job } = await jobWithThirdWriteFailing(err)
      expect(job.status).toBe('completed')
      expect(job.skipped).toEqual([
        { key: keys[2], label: 'Show — Episode 3', reason: 'too-large-for-filesystem' }
      ])
      expect(job.failed).toEqual([])
      expect(tmpFiles(env!.drive)).toEqual([])
      const lib = await readLibrary(path.join(env!.drive, 'Lib'))
      if (lib.status !== 'ok') throw new Error(lib.status)
      expect(
        lib.manifest.items.map((i) => `${i.animeId}:${i.episodeInt}:${i.translationId}`)
      ).toEqual([keys[0], keys[1], keys[3]])
    }
  )

  it('a plain EIO is still a failure, not a skip', async () => {
    const { keys, job } = await jobWithThirdWriteFailing(() =>
      errno('EIO', 'EIO: i/o error, write')
    )
    expect(job.status).toBe('completed')
    expect(job.skipped).toEqual([])
    expect(job.failed.map((f) => f.key)).toEqual([keys[2]])
    expect(tmpFiles(env!.drive)).toEqual([])
  })
})

describe('names: S5’s v1 rule, reported', () => {
  it('preflight’s renamed[] is exactly the manifest’s naming.renamed (CON, a trailing dot, a 295-byte author)', async () => {
    env = makeExportEnv()
    const con = env.addEpisode({ animeId: 1, title: 'CON', episodeInt: '1', translationId: 11 })
    const dot = env.addEpisode({ animeId: 2, title: 'Wait.', episodeInt: '1', translationId: 12 })
    const plain = env.addEpisode({ animeId: 3, title: 'Plain', episodeInt: '1', translationId: 13 })
    // A 295-byte author can't be in today's download name (ENAMETOOLONG), so
    // the file is the legacy untagged one; the author comes from its record.
    const author = `${'あ'.repeat(98)}x`
    expect(Buffer.byteLength(author)).toBe(295)
    fs.mkdirSync(path.join(env.hot, 'Long'))
    fs.writeFileSync(path.join(env.hot, 'Long', 'Long - 01.mkv'), Buffer.alloc(2048, 7))
    const longKey = '4:1:14'
    const episodes = env.store.get('downloadedEpisodes') as Record<string, unknown>
    episodes[longKey] = { translationType: 'subRu', author, quality: 720, translationId: 14 }
    env.store.set('downloadedEpisodes', episodes)
    const anime = env.store.get('downloadedAnime') as Record<number, AnimeSearchResult>
    anime[4] = { ...anime[3], id: 4, title: 'Long', titles: { romaji: 'Long' } }
    env.store.set('downloadedAnime', anime)

    const keys = [con.key, dot.key, plain.key, longKey]
    const plan = await env.svc.plan({ animeIds: [1, 2, 3, 4], target: env.drive, name: 'Lib' })
    const pf = plan.preflight!
    expect([...pf.renamed].sort()).toEqual([con.key, dot.key, longKey].sort())
    expect(pf.renames[con.key]).toEqual({
      from: 'CON/CON - 01 [Studio].mkv',
      to: 'CON_/CON - 01 [Studio].mkv'
    })
    expect(pf.warnings).toEqual([
      '3 names will be changed to fit this drive and Windows. An index.html will help find them without the app.'
    ])

    const r = await env.svc.start({ selection: sel(...keys), target: env.drive, name: 'Lib' })
    if (!r.ok) throw new Error(r.reason)
    await env.svc.settled(r.job.jobId)
    expect(env.svc.list()[0].status).toBe('completed')
    const lib = await readLibrary(path.join(env.drive, 'Lib'))
    if (lib.status !== 'ok') throw new Error(lib.status)
    expect([...(lib.manifest.naming?.renamed ?? [])].sort()).toEqual([...pf.renamed].sort())
    expect(fs.existsSync(path.join(env.drive, 'Lib', 'index.html'))).toBe(true)
  })
})

describe('MAX_PATH: S5’s absoluteOverflow, not a copy of it', () => {
  const deep = `C:\\${'d'.repeat(66)}\\`
  // A 199-unit relative path: within the 200 budget, so not renamed.
  const items = [
    item('1:1:7', 10, { title: 't'.repeat(90) }),
    item('1:2:8', 10, { title: 'Short' })
  ]

  it('under a 70-character Windows root: the flagged items and the warning come from the call', async () => {
    expect(deep.length).toBe(70)
    const overflow = vi.fn(absoluteOverflow)
    const r = await preflight(
      { items, existing: [] },
      { root: deep },
      fakeDeps({ platform: 'win32', overflow })
    )
    expect(r.named[0].path.length).toBe(199)
    expect(r.renamed).toEqual([])
    expect(overflow).toHaveBeenCalledTimes(1)
    expect(overflow.mock.calls[0][0]).toBe(deep)
    expect(overflow.mock.calls[0][1].map((i) => i.path)).toEqual(r.named.map((n) => n.path))
    expect(r.overflow).toEqual(overflow.mock.results[0].value)
    expect(r.overflow).toEqual(['1:1:7'])
    expect(r.warnings).toEqual([
      '1 file will have paths too long for some Windows apps. Choose a shorter folder.'
    ])
  })

  it('no warning under E:\\Anime Library\\', async () => {
    const r = await preflight(
      { items, existing: [] },
      { root: 'E:\\Anime Library\\' },
      fakeDeps({ platform: 'win32' })
    )
    expect(r.overflow).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('on macOS or Linux, the root below its mount point is checked as a drive letter', async () => {
    const overflow = vi.fn(absoluteOverflow)
    const mount = '/media/user/MY STICK'
    const root = `${mount}/${'d'.repeat(66)}`
    const r = await preflight(
      { items, existing: [] },
      { root },
      fakeDeps({ fsTypeProbe: fsType('fat32', mount), overflow })
    )
    expect(overflow.mock.calls[0][0]).toBe(`E:\\${'d'.repeat(66)}`)
    expect(r.overflow).toEqual(['1:1:7'])
  })

  it('windowsStyleRoot', () => {
    expect(windowsStyleRoot('E:\\Anime', null)).toBe('E:\\Anime')
    expect(windowsStyleRoot('\\\\nas\\share\\Anime', null)).toBe('\\\\nas\\share\\Anime')
    expect(windowsStyleRoot('/Volumes/S/a/b', '/Volumes/S')).toBe('E:\\a\\b')
    expect(windowsStyleRoot('/Volumes/S/a', null)).toBeNull()
    expect(windowsStyleRoot('/elsewhere/a', '/Volumes/S')).toBeNull()
  })
})

describe('the filesystem-type probe', () => {
  it('parses captured Get-Volume, findmnt, df and diskutil output', () => {
    expect(parseGetVolume(fixture('get-volume-ntfs.txt'))).toBe('ntfs')
    expect(parseGetVolume(fixture('get-volume-fat32.txt'))).toBe('fat32')
    expect(parseGetVolume(fixture('get-volume-exfat.txt'))).toBe('exfat')
    expect(parseGetVolume(fixture('get-volume-no-volume.txt'))).toBe('unknown')
    expect(parseGetVolume('ReFS\r\n')).toBe('other')

    expect(parseFindmnt(fixture('findmnt-ext4.json'))).toEqual({ fsType: 'ext', mountPoint: '/' })
    expect(parseFindmnt(fixture('findmnt-9p.json'))).toEqual({
      fsType: 'other',
      mountPoint: '/mnt/c'
    })
    expect(parseFindmnt(fixture('findmnt-vfat.json'))).toEqual({
      fsType: 'fat32',
      mountPoint: '/media/user/MY STICK'
    })
    expect(parseFindmnt('findmnt: bad usage')).toEqual({ fsType: 'unknown', mountPoint: null })

    expect(parseDfMountPoint(fixture('df-macos.txt'))).toBe('/Volumes/MY STICK')
    expect(parseDiskutilPlist(fixture('diskutil-ntfs.plist'))).toEqual({
      fsType: 'ntfs',
      mountPoint: '/Volumes/Tom & Jerry'
    })
    expect(parseDiskutilPlist(fixture('diskutil-msdos.plist'))).toEqual({
      fsType: 'fat32',
      mountPoint: '/Volumes/MY STICK'
    })
    expect(parseDiskutilPlist('<plist></plist>')).toEqual({ fsType: 'unknown', mountPoint: null })
  })

  it('runs the per-OS commands', async () => {
    const calls: [string, string[], Record<string, string> | undefined][] = []
    const run =
      (outputs: Record<string, string>): RunCommand =>
      async (cmd, args, opts) => {
        calls.push([cmd, args, opts.env])
        return outputs[cmd]
      }
    const win = createFsTypeProbe({
      platform: 'win32',
      run: run({ 'powershell.exe': fixture('get-volume-fat32.txt') })
    })
    expect(await win("E:\\it's; here")).toEqual({ fsType: 'fat32', mountPoint: null })
    expect(calls.pop()).toEqual([
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Volume -FilePath $env:ANIME_DL_PROBE_PATH).FileSystem'
      ],
      { ANIME_DL_PROBE_PATH: "E:\\it's; here" }
    ])

    const mac = createFsTypeProbe({
      platform: 'darwin',
      run: run({ df: fixture('df-macos.txt'), diskutil: fixture('diskutil-msdos.plist') })
    })
    expect(await mac('/Volumes/MY STICK/x')).toEqual({
      fsType: 'fat32',
      mountPoint: '/Volumes/MY STICK'
    })
    expect(calls.splice(0).map(([c, a]) => [c, a])).toEqual([
      ['df', ['-P', '/Volumes/MY STICK/x']],
      ['diskutil', ['info', '-plist', '/Volumes/MY STICK']]
    ])

    const linux = createFsTypeProbe({
      platform: 'linux',
      run: run({ findmnt: fixture('findmnt-vfat.json') })
    })
    expect(await linux('/media/user/MY STICK/x')).toEqual({
      fsType: 'fat32',
      mountPoint: '/media/user/MY STICK'
    })
    expect(calls.pop()?.slice(0, 2)).toEqual([
      'findmnt',
      ['-J', '-o', 'FSTYPE,TARGET', '--target', '/media/user/MY STICK/x']
    ])
  })

  it('a command that times out or fails gives unknown', async () => {
    const hang = createFsTypeProbe({
      platform: 'linux',
      run: () => new Promise<string>(() => {}),
      timeoutMs: 20
    })
    expect(await hang('/x')).toEqual({ fsType: 'unknown', mountPoint: null })
    const fail = createFsTypeProbe({
      platform: 'win32',
      run: async () => {
        throw new Error('Command failed: powershell.exe')
      }
    })
    expect(await fail('E:\\')).toEqual({ fsType: 'unknown', mountPoint: null })
  })

  it('the real runner passes the timeout through: a slow command is killed', async () => {
    const { runCommand } =
      await import('../../src/main/services/shared-library-export/fs-type-probe')
    const started = Date.now()
    await expect(
      runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 })
    ).rejects.toBeTruthy()
    expect(Date.now() - started).toBeLessThan(4000)
  })
})
