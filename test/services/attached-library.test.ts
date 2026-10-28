// AttachedLibraryService (#578): the open flow, the identity check and the
// local claim, the non-writing read-only check, S5's reader results, the
// ffmpeg warning, discovery, `checkItem`, and `spawnPathFor`.
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  createAttachedLibraryService,
  type AttachedLibraryServiceDeps
} from '../../src/main/services/attached-library'
import { checkWritable } from '../../src/main/services/attached-library/writable'
import { spawnPathFor } from '../../src/main/services/attached-library/spawn-path'
import { absoluteOverflow } from '../../src/main/lib/shared-library/paths'
import { CAPS } from '../../src/main/lib/shared-library/format'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import {
  cleanup,
  fixture,
  manifest,
  sparse,
  state,
  tempRoot,
  tree,
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
