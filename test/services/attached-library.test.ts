// AttachedLibraryService (#578): the open flow, the identity check and the
// local claim, the non-writing read-only check, S5's reader results, the
// ffmpeg warning, discovery, `checkItem`, and `spawnPathFor`.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  createAttachedLibraryService,
  POSTER_MAX_BYTES,
  type AttachedLibraryServiceDeps
} from '../../src/main/services/attached-library'
import { checkWritable } from '../../src/main/services/attached-library/writable'
import { spawnPathFor } from '../../src/main/services/attached-library/spawn-path'
import { absoluteOverflow } from '../../src/main/lib/shared-library/paths'
import { CAPS } from '../../src/main/lib/shared-library/format'
import { readLibrary } from '../../src/main/lib/shared-library/read'
import { writeManifest } from '../../src/main/lib/shared-library/write'
import { createAnimePosterHandler } from '../../src/main/streaming/anime-poster-protocol'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import {
  cleanup,
  fixture,
  manifest,
  sparse,
  state,
  tempRoot,
  tree,
  LIB,
  OWNER_ID
} from '../helpers/shared-library'
import {
  FIXTURE_LIBRARY_ID,
  copyFixtureLibrary,
  fsWritesUnder,
  mtimeSnapshot
} from '../helpers/attached-library'

const OWNER = { id: OWNER_ID, nickname: 'owner', avatar: '' }
const STRANGER = { id: 777, nickname: 'stranger', avatar: '' }

interface Made {
  svc: ReturnType<typeof createAttachedLibraryService>
  store: InMemoryStorage
  log: {
    log: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  onChanged: ReturnType<typeof vi.fn>
}

function make(
  initial: Record<string, unknown> = {},
  over: Partial<AttachedLibraryServiceDeps> = {}
): Made {
  const store = new InMemoryStorage({
    shikimoriUser: null,
    shikimoriCredentials: null,
    downloadedAnime: {},
    attachedLibraries: {},
    ...initial
  })
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const onChanged = vi.fn()
  const svc = createAttachedLibraryService({
    store,
    checkFfmpeg: async () => ({ available: true }),
    onChanged,
    log,
    now: () => 1_000,
    ...over
  })
  return { svc, store, log, onChanged }
}

async function attachAt(m: Made, root: string, choice?: SharedLibraryAttachChoice) {
  const [candidate] = await m.svc.discover(root)
  expect(candidate?.libraryId).toBeTruthy()
  const res = await m.svc.attach(candidate.libraryId!, choice)
  if (!res.ok) throw new Error(res.error)
  return { candidate, res }
}

/** The fixture library rewritten as *Videos only*. */
function videosOnly(): string {
  const root = copyFixtureLibrary()
  const file = path.join(root, '.anime-dl', 'manifest.json')
  const m = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...m, owner: null, mode: 'videos' }, null, 2) + '\n')
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('identity matrix', () => {
  it('Videos only, any PC: videos, no warning', async () => {
    for (const user of [null, OWNER, STRANGER]) {
      const m = make({ shikimoriUser: user })
      const { candidate, res } = await attachAt(m, videosOnly())
      expect(candidate.identity).toBe('videos')
      expect(res.library.role).toBe('videos')
    }
  })

  it('With metadata, owner = shikimoriUser.id: owner', async () => {
    const m = make({ shikimoriUser: OWNER, shikimoriCredentials: { access_token: 'x' } })
    const { candidate, res } = await attachAt(m, copyFixtureLibrary())
    expect(candidate.identity).toBe('owner')
    expect(res.library.role).toBe('owner')
  })

  it('an expired session (shikimoriUser kept, credentials cleared) is still the owner', async () => {
    const m = make({
      shikimoriUser: OWNER,
      shikimoriCredentials: null,
      shikimoriSessionExpired: true
    })
    const { candidate, res } = await attachAt(m, copyFixtureLibrary())
    expect(candidate.identity).toBe('owner')
    expect(res.library.role).toBe('owner')
  })

  it('With metadata, logged in as someone else: a warning, then used as videos (foreign)', async () => {
    const m = make({ shikimoriUser: STRANGER })
    const { candidate, res } = await attachAt(m, copyFixtureLibrary())
    expect(candidate.identity).toBe('foreign')
    expect(candidate.ownerNickname).toBe('owner')
    expect(res.library.role).toBe('foreign')
    expect(
      m.store.get<Record<string, AttachedLibraryRecord>>('attachedLibraries')![FIXTURE_LIBRARY_ID]
        .claim
    ).toBeUndefined()
  })

  it.each([
    ['never online', { workOffline: true }],
    ['online and logged out', { workOffline: false }]
  ])('With metadata, no account (%s): the choice is offered', async (_label, extra) => {
    const m = make({ shikimoriUser: null, ...extra })
    const [candidate] = await m.svc.discover(copyFixtureLibrary())
    expect(candidate.identity).toBe('choose')
  })

  it('no account, "Use as videos only": videos, no claim', async () => {
    const m = make()
    const { res } = await attachAt(m, copyFixtureLibrary(), 'videos')
    expect(res.library.role).toBe('videos')
    const rec =
      m.store.get<Record<string, AttachedLibraryRecord>>('attachedLibraries')![FIXTURE_LIBRARY_ID]
    expect(rec.claim).toBeUndefined()
  })

  it('no account, "Use this library as <nickname>": a local claim', async () => {
    const m = make()
    const { res } = await attachAt(m, copyFixtureLibrary(), 'claim')
    expect(res.library.role).toBe('claim')
    const rec =
      m.store.get<Record<string, AttachedLibraryRecord>>('attachedLibraries')![FIXTURE_LIBRARY_ID]
    expect(rec.claim).toEqual({ ownerId: OWNER_ID, at: 1_000 })
  })

  it('a claim is refused on a PC with an account', async () => {
    const m = make({ shikimoriUser: STRANGER })
    const [candidate] = await m.svc.discover(copyFixtureLibrary())
    const res = await m.svc.attach(candidate.libraryId!, 'claim')
    expect(res.ok).toBe(false)
  })

  it('a claim followed by a login as the same id becomes plain ownership', async () => {
    const m = make()
    await attachAt(m, copyFixtureLibrary(), 'claim')
    m.store.set('shikimoriUser', OWNER)
    expect(m.svc.list()[0].role).toBe('owner')
    const rec =
      m.store.get<Record<string, AttachedLibraryRecord>>('attachedLibraries')![FIXTURE_LIBRARY_ID]
    expect(rec.claim).toBeUndefined()
    // A later logout doesn't bring the claim back.
    m.store.set('shikimoriUser', null)
    expect(m.svc.list()[0].role).toBe('videos')
  })

  it('a claim followed by a login as a different id turns foreign, and the claim is removed', async () => {
    const m = make()
    await attachAt(m, copyFixtureLibrary(), 'claim')
    m.onChanged.mockClear()
    m.store.set('shikimoriUser', STRANGER)
    expect(m.svc.get(FIXTURE_LIBRARY_ID)?.role).toBe('foreign')
    const rec =
      m.store.get<Record<string, AttachedLibraryRecord>>('attachedLibraries')![FIXTURE_LIBRARY_ID]
    expect(rec.claim).toBeUndefined()
    expect(m.onChanged).toHaveBeenCalledTimes(1)
  })

  it('the same library at two paths is keyed by libraryId: the latest root wins', async () => {
    const m = make({ shikimoriUser: OWNER })
    const a = copyFixtureLibrary()
    const b = copyFixtureLibrary()
    await attachAt(m, a)
    await attachAt(m, b)
    expect(m.svc.list().map((l) => l.root)).toEqual([b])
  })
})

describe('never written, for every classification', () => {
  const cases: [string, Record<string, unknown>, SharedLibraryAttachChoice | undefined][] = [
    ['owner', { shikimoriUser: OWNER }, undefined],
    ['foreign', { shikimoriUser: STRANGER }, undefined],
    ['videos (no account)', {}, 'videos'],
    ['claim', {}, 'claim']
  ]

  it.each(cases)(
    '%s: opening, the writability check and playing write no byte',
    async (_l, init, choice) => {
      const root = copyFixtureLibrary()
      const before = mtimeSnapshot(root)
      const writes = fsWritesUnder(root)
      const m = make(init)
      await attachAt(m, root, choice)
      m.svc.list()
      await m.svc.getTitle(FIXTURE_LIBRARY_ID, 101)
      expect(await m.svc.resolveItem(101, '1', 9001)).not.toBeNull()
      expect(
        await m.svc.checkItem(FIXTURE_LIBRARY_ID, {
          path: 'Dungeon Meshi/Dungeon Meshi - 01 [AniLibria].mkv',
          size: 19727
        })
      ).toBe('ok')
      expect(await checkWritable(root)).toEqual({ kind: 'writable' })
      await m.svc.posterFor(101)
      // A restart re-reads the library the same way.
      const again = make({ ...init, attachedLibraries: m.store.get('attachedLibraries') })
      await again.svc.init()
      expect(writes()).toEqual([])
      expect(mtimeSnapshot(root)).toEqual(before)
    }
  )

  it('the spy sees a write under the root (control)', async () => {
    const root = copyFixtureLibrary()
    const writes = fsWritesUnder(root)
    await fs.promises.writeFile(path.join(root, '.anime-dl', 'probe'), '')
    await fs.promises.unlink(path.join(root, '.anime-dl', 'probe'))
    expect(writes().map((w) => w.call)).toEqual(['writeFile', 'unlink'])
  })
})

describe('read-only check', () => {
  const chmodded: string[] = []
  afterEach(() => {
    for (const d of chmodded.splice(0)) fs.chmodSync(d, 0o755)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'chmod -w on .anime-dl gives read-only (mount), with no file created',
    async () => {
      const root = copyFixtureLibrary()
      const dir = path.join(root, '.anime-dl')
      fs.chmodSync(dir, 0o555)
      chmodded.push(dir)
      const before = mtimeSnapshot(root)
      const m = make({ shikimoriUser: OWNER })
      const { res } = await attachAt(m, root)
      expect(res.library.access).toBe('read-only')
      expect(res.library.accessReason).toBe('mount')
      expect(mtimeSnapshot(root)).toEqual(before)
    }
  )

  it('a fresh attach of the writable fixture starts as read-write', async () => {
    const m = make({ shikimoriUser: OWNER })
    const { res } = await attachAt(m, copyFixtureLibrary())
    expect(res.library.access).toBe('read-write')
    expect(res.library.accessReason).toBeUndefined()
  })

  it('an EIO from access leaves it read-write and logs the error', async () => {
    const eio = Object.assign(new Error('i/o error'), { code: 'EIO' })
    const m = make(
      { shikimoriUser: OWNER },
      {
        checkWritable: (root) =>
          checkWritable(root, async () => {
            throw eio
          })
      }
    )
    const { res } = await attachAt(m, copyFixtureLibrary())
    expect(res.library.access).toBe('read-write')
    expect(m.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('writability check failed'),
      eio
    )
  })

  it.each(['EROFS', 'EACCES', 'EPERM'])('%s gives read-only', async (code) => {
    const verdict = await checkWritable('/x', async () => {
      throw Object.assign(new Error(code), { code })
    })
    expect(verdict).toEqual({ kind: 'read-only', code })
  })
})

describe("S5's reader results", () => {
  it('a torn pair opens with access unchanged, and logs a line', async () => {
    const m = make({ shikimoriUser: OWNER })
    const { res } = await attachAt(m, fixture('torn-state'))
    expect(res.library.access).toBe('read-write')
    expect(res.library.message).toBeUndefined()
    expect(m.log.log).toHaveBeenCalledWith(expect.stringContaining('torn pair'))
  })

  it("no matching pair opens read-only (interrupted) with S5's message, and still plays", async () => {
    const root = tree({ 'manifest.json': manifest(7, 4), 'state.json': state(5, 8) })
    fs.mkdirSync(path.join(root, 'Frieren'))
    fs.writeFileSync(path.join(root, 'Frieren', 'Frieren - 01 [Crunchyroll].mkv'), 'x')
    const m = make({ shikimoriUser: OWNER })
    const { candidate, res } = await attachAt(m, root)
    expect(candidate.readOnly?.reason).toBe('interrupted')
    expect(res.library.access).toBe('read-only')
    expect(res.library.accessReason).toBe('interrupted')
    expect(res.library.message).toBe(
      'This library was interrupted while being written. Plug it into the PC that last wrote it.'
    )
    expect((await m.svc.resolveItem(101, '1', 9001))?.path).toBe(
      fs.realpathSync(path.join(root, 'Frieren', 'Frieren - 01 [Crunchyroll].mkv'))
    )
  })

  it('an over-cap state.json opens read-only (size) and still plays', async () => {
    const root = tree({
      'manifest.json': manifest(8, 5),
      'manifest.prev.json': manifest(7, 4),
      'state.prev.json': state(4, 7)
    })
    sparse(root, 'state.json', CAPS.stateBytes + 1)
    fs.mkdirSync(path.join(root, 'Frieren'))
    fs.writeFileSync(path.join(root, 'Frieren', 'Frieren - 02 [Crunchyroll].mkv'), 'x')
    const m = make({ shikimoriUser: OWNER })
    const { res } = await attachAt(m, root)
    expect(res.library.access).toBe('read-only')
    expect(res.library.accessReason).toBe('size')
    expect(res.library.message).toBe('This library is larger than this version can open')
    expect(await m.svc.resolveItem(101, '2', 9002)).not.toBeNull()
  })

  it('an over-cap manifest.json shows the message with no items, and nothing to attach', async () => {
    const root = tree({ 'manifest.prev.json': manifest(7, 4), 'state.json': state(4, 7) })
    sparse(root, 'manifest.json', CAPS.manifestBytes + 1)
    const m = make({ shikimoriUser: OWNER })
    const [candidate] = await m.svc.discover(root)
    expect(candidate).toMatchObject({
      libraryId: null,
      titleCount: 0,
      readOnly: { reason: 'size', message: 'This library is larger than this version can open' }
    })
  })

  it("the bad-scalar manifest (no valid name) attaches under the root's folder name", async () => {
    const root = fixture('bad-scalar-manifest')
    const m = make()
    const { candidate, res } = await attachAt(m, root)
    expect(candidate.name).toBe(path.basename(root))
    expect(res.library.name).toBe(path.basename(root))
  })

  it('an item flagged by absoluteOverflow produces the warning; an unflagged library does not', async () => {
    // A deep Windows-style mount point for the same tree: S5's own check, with
    // the root it would see on Windows.
    const deep = `E:\\${'x'.repeat(240)}`
    const overflow = vi.fn((_root: string, items: Parameters<typeof absoluteOverflow>[1]) =>
      absoluteOverflow(deep, items)
    )
    const flagged = make({ shikimoriUser: OWNER }, { overflow })
    expect((await attachAt(flagged, copyFixtureLibrary())).res.library.pathOverflow).toBe(2)

    const plain = make({ shikimoriUser: OWNER })
    expect((await attachAt(plain, copyFixtureLibrary())).res.library.pathOverflow).toBe(0)
  })
})

describe('ffmpeg warning', () => {
  it('with ffmpeg unavailable, attaching the fixture (one .mkv, one .mp4) returns ffmpegMissing', async () => {
    const m = make({ shikimoriUser: OWNER }, { checkFfmpeg: async () => ({ available: false }) })
    const { res } = await attachAt(m, copyFixtureLibrary())
    expect(res.ffmpegMissing).toEqual({ mkvCount: 1 })
    const titles = res.library.titles
    expect(titles.find((t) => t.animeId === 202)?.play).toEqual({
      any: { episodeInt: '1', translationId: 9101, container: 'mkv' },
      withoutFfmpeg: null
    })
    expect(titles.find((t) => t.animeId === 101)?.play.withoutFfmpeg).toEqual({
      episodeInt: '1',
      translationId: 9001,
      container: 'mp4'
    })
  })

  it('with ffmpeg available there is no warning', async () => {
    const m = make({ shikimoriUser: OWNER })
    const { res } = await attachAt(m, copyFixtureLibrary())
    expect(res.ffmpegMissing).toBeUndefined()
  })
})

describe('discovery', () => {
  it('a drive with two libraries returns both, so the user picks', async () => {
    const drive = tempRoot()
    fs.cpSync(copyFixtureLibrary(), path.join(drive, 'A'), { recursive: true })
    const b = path.join(drive, 'B')
    fs.cpSync(videosOnly(), b, { recursive: true })
    const file = path.join(b, '.anime-dl', 'manifest.json')
    const mb = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(
      file,
      JSON.stringify({ ...mb, libraryId: '0f0e0d0c-0b0a-4908-8706-050403020100', name: 'B lib' })
    )
    const m = make({ shikimoriUser: OWNER })
    const found = await m.svc.discover(drive)
    expect(found.map((c) => [c.name, c.ownerNickname, c.mode, c.titleCount])).toEqual([
      ['Fixture library', 'owner', 'metadata', 2],
      ['B lib', null, 'videos', 2]
    ])
  })

  it('attaching an id no discovery returned is refused', async () => {
    const m = make()
    expect((await m.svc.attach(FIXTURE_LIBRARY_ID)).ok).toBe(false)
  })
})

describe('titles, snapshots and checkItem', () => {
  it('titles render from the snapshot; the poster is served from the drive', async () => {
    const m = make({ shikimoriUser: OWNER, downloadedAnime: { '101': { id: 101 } } })
    const { res } = await attachAt(m, copyFixtureLibrary())
    const frieren = res.library.titles.find((t) => t.animeId === 101)!
    expect(frieren).toMatchObject({ name: 'Frieren', hasPoster: true, onThisPc: true })
    expect(frieren.anime.posterUrlSmall).toBe('anime-poster://101')
    expect(res.library.titles.find((t) => t.animeId === 202)).toMatchObject({
      hasPoster: false,
      onThisPc: false
    })
    expect(await m.svc.posterFor(101)).toMatch(/101\.jpg$/)
    expect(await m.svc.posterFor(202)).toBeNull()
    const detail = await m.svc.getTitle(FIXTURE_LIBRARY_ID, 101)
    expect(detail?.episodes).toEqual([
      {
        episodeInt: '1',
        episodeFull: '1 серия',
        items: [
          {
            translationId: 9001,
            translationType: 'subRu',
            author: 'Crunchyroll',
            quality: 1080,
            container: 'mp4',
            hasSubtitle: true
          }
        ]
      }
    ])
    expect(m.svc.availableSnapshots()[0].titles.map((t) => [t.animeId, !!t.meta])).toEqual([
      [101, true],
      [202, false]
    ])
  })

  describe('the poster cap', () => {
    const poster = (root: string): string => path.join(root, '.anime-dl', 'posters', '101.jpg')

    it('holds at serve time: a poster replaced past the cap after attaching is not served', async () => {
      const root = copyFixtureLibrary()
      const m = make({ shikimoriUser: OWNER })
      await attachAt(m, root)
      expect(await m.svc.posterFor(101)).toMatch(/101\.jpg$/)
      fs.truncateSync(poster(root), POSTER_MAX_BYTES + 1)
      expect(await m.svc.posterFor(101)).toBeNull()
      // Through `anime-poster://`, with an empty local cache: not served.
      const handler = createAnimePosterHandler({
        posterDir: tempRoot(),
        attachedPoster: (id) => m.svc.posterFor(id)
      })
      expect((await handler(new Request('anime-poster://101'))).status).toBe(404)
    })

    it('holds at open: a poster already past the cap is never listed', async () => {
      const root = copyFixtureLibrary()
      fs.truncateSync(poster(root), POSTER_MAX_BYTES + 1)
      const m = make({ shikimoriUser: OWNER })
      const { res } = await attachAt(m, root)
      expect(res.library.titles.find((t) => t.animeId === 101)?.hasPoster).toBe(false)
      expect(await m.svc.posterFor(101)).toBeNull()
    })

    it('a poster exactly at the cap is served', async () => {
      const root = copyFixtureLibrary()
      fs.truncateSync(poster(root), POSTER_MAX_BYTES)
      const m = make({ shikimoriUser: OWNER })
      await attachAt(m, root)
      expect(await m.svc.posterFor(101)).toMatch(/101\.jpg$/)
    })
  })

  it('checkItem: a file gone between realpath and stat is missing, not a rejection', async () => {
    const m = make({ shikimoriUser: OWNER })
    await attachAt(m, copyFixtureLibrary())
    const stat = fs.promises.stat
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]).endsWith('.mkv')) {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      }
      return (stat as (...a: unknown[]) => Promise<unknown>).apply(fs.promises, args)
    }) as never)
    await expect(
      m.svc.checkItem(FIXTURE_LIBRARY_ID, {
        path: 'Dungeon Meshi/Dungeon Meshi - 01 [AniLibria].mkv',
        size: 19727
      })
    ).resolves.toBe('missing')
  })

  it('checkItem: ok, missing, wrong size, outside the root', async () => {
    const root = copyFixtureLibrary()
    const m = make({ shikimoriUser: OWNER })
    await attachAt(m, root)
    const mkv = 'Dungeon Meshi/Dungeon Meshi - 01 [AniLibria].mkv'
    expect(await m.svc.checkItem(FIXTURE_LIBRARY_ID, { path: mkv, size: 19727 })).toBe('ok')
    expect(await m.svc.checkItem(FIXTURE_LIBRARY_ID, { path: mkv, size: 1 })).toBe('wrong-size')
    expect(await m.svc.checkItem(FIXTURE_LIBRARY_ID, { path: 'nope/x.mkv', size: 1 })).toBe(
      'missing'
    )
    const outside = path.join(tempRoot(), 'outside.mkv')
    fs.writeFileSync(outside, 'x')
    fs.rmSync(path.join(root, mkv))
    fs.symlinkSync(outside, path.join(root, mkv))
    expect(await m.svc.checkItem(FIXTURE_LIBRARY_ID, { path: mkv, size: 1 })).toBe('escapes')
  })

  it('a restart re-opens persisted libraries', async () => {
    const root = copyFixtureLibrary()
    const first = make({ shikimoriUser: OWNER })
    await attachAt(first, root)
    const second = make({
      shikimoriUser: OWNER,
      attachedLibraries: first.store.get('attachedLibraries')
    })
    expect(second.svc.list()[0].available).toBe(false)
    await second.svc.init()
    expect(second.svc.list()[0]).toMatchObject({
      available: true,
      role: 'owner',
      name: 'Fixture library'
    })
    expect(await second.svc.resolveItem(202, '1', 9101)).not.toBeNull()
  })
})

describe('refresh after a write (#616)', () => {
  const WRITER: SharedLibraryActor = {
    installId: 'pc-export',
    appVersion: '5.0.29',
    shikimoriUserId: null,
    claim: null
  }
  const MESHI = 'Dungeon Meshi/Dungeon Meshi - 01 [AniLibria].mkv'

  /** The real store's semantics: `get` and `set` clone (`src/main/store/index.ts`). */
  function makeCloned(
    initial: Record<string, unknown> = {},
    over: Partial<AttachedLibraryServiceDeps> = {}
  ): Made {
    const inner = new InMemoryStorage({
      shikimoriUser: null,
      shikimoriCredentials: null,
      downloadedAnime: {},
      attachedLibraries: {},
      ...initial
    })
    const store = {
      get: (key: string) => structuredClone(inner.get(key)),
      set: (key: string, value: unknown) => inner.set(key, structuredClone(value))
    } as AttachedLibraryServiceDeps['store']
    return { ...make(initial, { store, ...over }), store: inner }
  }

  /** What an export's checkpoint does: a Dungeon Meshi episode copied in and the manifest written. */
  async function exportEpisode(root: string, episodeInt: string): Promise<void> {
    const r = await readLibrary(root)
    if (r.status !== 'ok') throw new Error(`unexpected ${r.status}`)
    const m = r.manifest
    const rel = `Dungeon Meshi/Dungeon Meshi - 0${episodeInt} [AniLibria].mkv`
    fs.copyFileSync(path.join(root, MESHI), path.join(root, rel))
    const base = m.items.find((i) => i.path === MESHI)!
    await writeManifest(
      root,
      {
        libraryId: m.libraryId,
        name: m.name,
        owner: m.owner,
        mode: m.mode,
        titles: m.titles,
        items: [...m.items, { ...base, episodeInt, path: rel }],
        naming: m.naming
      },
      WRITER,
      m.generation
    )
  }

  it('a write into the attached root: the new item lists and resolves, onChanged fires, the record is saved', async () => {
    let t = 1_000
    const m = makeCloned({}, { now: () => ++t })
    const root = videosOnly()
    await attachAt(m, root)
    m.onChanged.mockClear()
    await exportEpisode(root, '2')
    expect(await m.svc.resolveItem(202, '2', 9101)).toBeNull()

    await m.svc.refresh(FIXTURE_LIBRARY_ID, root)
    expect(m.onChanged).toHaveBeenCalledTimes(1)
    const meshi = m.svc.get(FIXTURE_LIBRARY_ID)!.titles.find((x) => x.animeId === 202)!
    expect(meshi.itemCount).toBe(2)
    expect((await m.svc.resolveItem(202, '2', 9101))?.path).toBe(
      fs.realpathSync(path.join(root, 'Dungeon Meshi', 'Dungeon Meshi - 02 [AniLibria].mkv'))
    )
    const rec = (m.store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>)[
      FIXTURE_LIBRARY_ID
    ]
    expect(rec).toMatchObject({ root, access: 'read-write', lastSeenAt: t })
  })

  it('an unknown id does nothing', async () => {
    const m = makeCloned()
    const root = videosOnly()
    await attachAt(m, root)
    m.onChanged.mockClear()
    const before = structuredClone(m.store.get('attachedLibraries'))
    await exportEpisode(root, '2')
    await m.svc.refresh(LIB, root)
    expect(m.onChanged).not.toHaveBeenCalled()
    expect(m.store.get('attachedLibraries')).toEqual(before)
    expect(m.svc.get(LIB)).toBeNull()
    expect(await m.svc.resolveItem(202, '2', 9101)).toBeNull()
  })

  it('a newer state major written meanwhile flips access to read-only (version)', async () => {
    const root = tree({ 'manifest.json': manifest(1, 1), 'state.json': state(1, 1) })
    const m = makeCloned({ shikimoriUser: OWNER })
    await m.svc.discover(root)
    const res = await m.svc.attach(LIB)
    if (!res.ok) throw new Error(res.error)
    expect(res.library.access).toBe('read-write')
    m.onChanged.mockClear()
    fs.writeFileSync(
      path.join(root, '.anime-dl', 'state.json'),
      JSON.stringify(state(2, 1, { stateVersion: 2 }))
    )
    await m.svc.refresh(LIB, root)
    expect(m.onChanged).toHaveBeenCalledTimes(1)
    expect(m.svc.get(LIB)).toMatchObject({ access: 'read-only', accessReason: 'version' })
    expect(
      (m.store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>)[LIB]
    ).toMatchObject({ access: 'read-only', accessReason: 'version' })
  })

  it('a root that is not the attached copy (the same library on another drive) is a no-op; a symlink to it is not', async () => {
    let t = 1_000
    const m = makeCloned({}, { now: () => ++t })
    const root = videosOnly()
    await attachAt(m, root)
    const other = path.join(tempRoot(), 'Other drive')
    fs.cpSync(root, other, { recursive: true })
    await exportEpisode(other, '2')
    m.onChanged.mockClear()
    const before = structuredClone(m.store.get('attachedLibraries'))

    await m.svc.refresh(FIXTURE_LIBRARY_ID, other)
    expect(m.onChanged).not.toHaveBeenCalled()
    expect(m.store.get('attachedLibraries')).toEqual(before)
    expect(await m.svc.resolveItem(202, '2', 9101)).toBeNull()

    await exportEpisode(root, '2')
    const link = path.join(tempRoot(), 'link')
    fs.symlinkSync(root, link, 'dir')
    await m.svc.refresh(FIXTURE_LIBRARY_ID, link)
    expect(m.onChanged).toHaveBeenCalledTimes(1)
    expect((await m.svc.resolveItem(202, '2', 9101))?.libraryId).toBe(FIXTURE_LIBRARY_ID)
  })

  it('overlapping refreshes run one at a time, and the one that came in during a read re-runs', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reads = 0
    let entered!: () => void
    const blocked = new Promise<void>((r) => (entered = r))
    const m = makeCloned(
      {},
      {
        checkWritable: async () => {
          // 1: attach; 2: the first refresh, held mid-read.
          if (++reads === 2) {
            entered()
            await gate
          }
          return { kind: 'writable' }
        }
      }
    )
    const root = videosOnly()
    await attachAt(m, root)
    m.onChanged.mockClear()

    await exportEpisode(root, '2')
    const first = m.svc.refresh(FIXTURE_LIBRARY_ID, root)
    await blocked
    await exportEpisode(root, '3')
    const second = m.svc.refresh(FIXTURE_LIBRARY_ID, root)
    // Unserialized, the second read would finish here, and the held first one would then overwrite it.
    await Promise.race([second, new Promise((r) => setTimeout(r, 200))])
    release()
    await Promise.all([first, second])

    const meshi = m.svc.get(FIXTURE_LIBRARY_ID)!.titles.find((x) => x.animeId === 202)!
    expect(meshi.itemCount).toBe(3)
    expect(await m.svc.resolveItem(202, '3', 9101)).not.toBeNull()
    expect(reads).toBe(3)
    expect(m.onChanged).toHaveBeenCalledTimes(2)
  })

  it('an attach that lands during the read is kept', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let entered!: () => void
    const blocked = new Promise<void>((r) => (entered = r))
    const rootA = videosOnly()
    let reads = 0
    const m = makeCloned(
      {},
      {
        checkWritable: async (root) => {
          if (root === rootA && reads++ === 1) {
            entered()
            await gate
          }
          return { kind: 'writable' }
        }
      }
    )
    await attachAt(m, rootA)
    await exportEpisode(rootA, '2')
    const refreshing = m.svc.refresh(FIXTURE_LIBRARY_ID, rootA)
    await blocked

    const rootB = tree({ 'manifest.json': manifest(1, null, { mode: 'videos' }) })
    await attachAt(m, rootB)
    release()
    await refreshing

    const saved = m.store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>
    expect(Object.keys(saved).sort()).toEqual([FIXTURE_LIBRARY_ID, LIB].sort())
    expect(saved[LIB].root).toBe(rootB)
    expect(
      m.svc
        .list()
        .map((l) => l.libraryId)
        .sort()
    ).toEqual([FIXTURE_LIBRARY_ID, LIB].sort())
    expect(await m.svc.resolveItem(202, '2', 9101)).not.toBeNull()
  })

  describe('against a slow startup reopen (#616 review)', () => {
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    /** A restart on `rootA`'s persisted record, its `init()` held mid-read of `rootA`. */
    async function restartHeld(rootA: string): Promise<{
      m: Made
      init: Promise<void>
      release: () => void
      lastNow: () => number
    }> {
      const first = makeCloned()
      await attachAt(first, rootA)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let entered!: () => void
      const blocked = new Promise<void>((r) => (entered = r))
      let held = false
      let t = 5_000
      const m = makeCloned(
        { attachedLibraries: structuredClone(first.store.get('attachedLibraries')) },
        {
          now: () => ++t,
          checkWritable: async (root) => {
            if (root === rootA && !held) {
              held = true
              entered()
              await gate
            }
            return { kind: 'writable' }
          }
        }
      )
      const init = m.svc.init()
      await blocked
      return { m, init, release, lastNow: () => t }
    }

    it('a refresh started while init() reads lands after it: memory and the saved record hold the refreshed manifest', async () => {
      const root = videosOnly()
      const { m, init, release, lastNow } = await restartHeld(root)
      await exportEpisode(root, '2')
      const refreshed = m.svc.refresh(FIXTURE_LIBRARY_ID, root)
      // Unwaited, the refresh would finish here and the held startup read would then replace it.
      await Promise.race([refreshed, sleep(200)])
      release()
      await Promise.all([init, refreshed])

      const meshi = m.svc.get(FIXTURE_LIBRARY_ID)!.titles.find((x) => x.animeId === 202)!
      expect(meshi.itemCount).toBe(2)
      expect(await m.svc.resolveItem(202, '2', 9101)).not.toBeNull()
      const saved = m.store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>
      expect(saved[FIXTURE_LIBRARY_ID]).toMatchObject({
        root,
        access: 'read-write',
        lastSeenAt: lastNow()
      })
      expect(m.onChanged).toHaveBeenCalledTimes(1)
    })

    it('another library attached while init() reads is kept in the saved records', async () => {
      const rootA = videosOnly()
      const { m, init, release } = await restartHeld(rootA)
      const rootB = tree({ 'manifest.json': manifest(1, null, { mode: 'videos' }) })
      await attachAt(m, rootB)
      release()
      await init

      const saved = m.store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>
      expect(Object.keys(saved).sort()).toEqual([FIXTURE_LIBRARY_ID, LIB].sort())
      expect(saved[LIB].root).toBe(rootB)
      expect(m.svc.get(FIXTURE_LIBRARY_ID)?.available).toBe(true)
    })

    it('the same library re-attached while init() reads keeps the attach’s newer read', async () => {
      const root = videosOnly()
      const { m, init, release } = await restartHeld(root)
      await exportEpisode(root, '2')
      await attachAt(m, root)
      release()
      await init

      const meshi = m.svc.get(FIXTURE_LIBRARY_ID)!.titles.find((x) => x.animeId === 202)!
      expect(meshi.itemCount).toBe(2)
      expect(await m.svc.resolveItem(202, '2', 9101)).not.toBeNull()
    })
  })
})

describe('spawnPathFor', () => {
  const roots = ['E:\\Anime\\lib']

  it('a path under an attached root gets the \\\\?\\ form on Windows', () => {
    expect(spawnPathFor('E:\\Anime\\lib\\Frieren\\x.mkv', roots, path.win32)).toBe(
      '\\\\?\\E:\\Anime\\lib\\Frieren\\x.mkv'
    )
  })

  it('a local path, a sibling prefix and the root itself are unchanged', () => {
    for (const p of [
      'C:\\Users\\me\\Downloads\\x.mkv',
      'E:\\Anime\\library\\x.mkv',
      'E:\\Anime\\lib'
    ]) {
      expect(spawnPathFor(p, roots, path.win32)).toBe(p)
    }
  })

  it('any POSIX path is unchanged', () => {
    expect(spawnPathFor('/media/usb/lib/x.mkv', ['/media/usb/lib'], path.posix)).toBe(
      '/media/usb/lib/x.mkv'
    )
  })

  it('the service hands its own roots to it', async () => {
    const root = copyFixtureLibrary()
    const m = make({ shikimoriUser: OWNER })
    await attachAt(m, root)
    expect(m.svc.roots()).toContain(root)
    const p = path.join(root, 'x.mkv')
    // A no-op off Windows; the routing is what this pins.
    expect(m.svc.spawnPathFor(p)).toBe(path.toNamespacedPath(p))
  })
})
