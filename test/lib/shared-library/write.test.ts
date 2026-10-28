// The Shared Library writer (#573): the order of every write (checks, s₀ and
// caps, repair, then the atomic sequence), the torn-pair repair, crash
// points, the first write into a With-metadata library and the owner checks.
import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPS } from '../../../src/main/lib/shared-library/format'
import { discoverLibraries } from '../../../src/main/lib/shared-library/discover'
import { readLibrary } from '../../../src/main/lib/shared-library/read'
import {
  IdentityChangeError,
  InvalidLibraryDataError,
  LibraryExistsError,
  LibraryIdMismatchError,
  LibraryNotFoundError,
  LibraryReadOnlyError,
  LibraryTooLargeError,
  NotOwnerError,
  StaleGenerationError,
  createLibrary,
  writeManifest,
  writeState
} from '../../../src/main/lib/shared-library/write'
import {
  CLAIMANT,
  CrashError,
  LIB,
  LOGGED_OUT,
  OTHER_LIB,
  OWNER,
  OWNER_ID,
  STRANGER,
  cleanup,
  crashAt,
  exists,
  fixture,
  item,
  manifest,
  readJson,
  snapshot,
  sparse,
  state,
  tinyItem,
  tree
} from '../../helpers/shared-library'

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

type Ok = Extract<SharedLibraryRead, { status: 'ok' }>

async function ok(root: string): Promise<Ok> {
  const r = await readLibrary(root)
  expect(r.status, JSON.stringify(r).slice(0, 200)).toBe('ok')
  return r as Ok
}

const EXTRA = item('9', 9009) as SharedLibraryItem
const withExtra = (items: SharedLibraryItem[]): SharedLibraryItem[] => [
  ...items.filter((i) => i.translationId !== 9009),
  EXTRA
]

const EMPTY_DOC: SharedSyncDoc = {
  stateVersion: 1,
  stateMinor: 0,
  installId: 'pc-owner',
  titles: {},
  priorityOrder: { value: [], at: 0, origin: 'pc-owner' },
  tombstones: {}
}

type Op = 'writeManifest' | 'writeState'

/** The owner's write, from what the drive reads as now. */
async function run(op: Op, root: string): Promise<unknown> {
  const r = await ok(root)
  if (op === 'writeManifest') {
    return writeManifest(
      root,
      { ...r.manifest, items: withExtra(r.manifest.items) },
      OWNER,
      r.manifest.generation
    )
  }
  return writeState(root, r.state?.doc ?? EMPTY_DOC, OWNER, r.manifest.stateGeneration)
}

/** Runs `write` and asserts it throws `error` with every file under the root unchanged. */
async function refuses(
  root: string,
  write: () => Promise<unknown>,
  error: abstract new (...args: never[]) => Error
): Promise<void> {
  const before = snapshot(root)
  await expect(write()).rejects.toBeInstanceOf(error)
  expect(snapshot(root)).toEqual(before)
}

const TORN = ['torn-state', 'torn-manifest', 'torn-both'] as const

describe('a newer major takes precedence over the .prev fallback', () => {
  it.each(['newer-major-state', 'newer-major-manifest'])(
    '%s: the owner’s writeManifest and writeState refuse, the tree byte-identical',
    async (name) => {
      const root = fixture(name)
      const m = manifest(8, 5) as unknown as SharedLibraryManifestInput
      await refuses(root, () => writeManifest(root, m, OWNER, 8), LibraryReadOnlyError)
      await refuses(root, () => writeState(root, EMPTY_DOC, OWNER, 5), LibraryReadOnlyError)
    }
  )
})

describe('over a cap: refused, never repaired', () => {
  function overCapState(): string {
    const root = tree({
      'manifest.json': manifest(8, 5),
      'manifest.prev.json': manifest(7, 4),
      'state.prev.json': state(4, 7)
    })
    sparse(root, 'state.json', CAPS.stateBytes + 1)
    return root
  }
  function overCapManifest(): string {
    const root = tree({ 'manifest.prev.json': manifest(7, 4), 'state.json': state(4, 7) })
    sparse(root, 'manifest.json', CAPS.manifestBytes + 1)
    return root
  }
  const input = manifest(8, 5) as unknown as SharedLibraryManifestInput

  it.each([
    ['state.json', overCapState],
    ['manifest.json', overCapManifest]
  ])('an over-cap %s: both writers refuse, the tree byte-identical', async (_, build) => {
    const root = build()
    await refuses(root, () => writeManifest(root, input, OWNER, 7), LibraryReadOnlyError)
    await refuses(root, () => writeState(root, EMPTY_DOC, OWNER, 4), LibraryReadOnlyError)
  })

  it(
    '200,001 items: writeManifest refuses, the tree byte-identical',
    { timeout: 60_000 },
    async () => {
      const items = Array.from({ length: CAPS.items + 1 }, (_, i) => tinyItem(i + 1))
      const root = tree({
        'manifest.json': JSON.stringify(manifest(3, null, { mode: 'videos', items }))
      })
      const m = manifest(3, null, { mode: 'videos' }) as unknown as SharedLibraryManifestInput
      await refuses(root, () => writeManifest(root, m, LOGGED_OUT, 3), LibraryReadOnlyError)
    }
  )

  describe('the writer refuses to serialize over a cap, before any repair', () => {
    const big = (): SharedLibraryItem[] =>
      Array.from({ length: CAPS.items + 1 }, (_, i) => tinyItem(i + 1) as SharedLibraryItem)

    it.each([
      ['an untorn', 'golden-videos', LOGGED_OUT],
      ['a torn', 'torn-state', OWNER]
    ])(
      'writeManifest with 200,001 items on %s library',
      { timeout: 60_000 },
      async (_, name, actor) => {
        const root = fixture(name)
        fs.writeFileSync(path.join(root, '.anime-dl', 'manifest.json.tmp'), 'stale')
        const m = (await ok(root)).manifest
        const write = () => writeManifest(root, { ...m, items: big() }, actor, m.generation)
        await refuses(root, write, LibraryTooLargeError)
        // The item count is checked before the bytes.
        await expect(write()).rejects.toThrow(`more than ${CAPS.items} items`)
      }
    )

    it(
      'writeState whose state.json would be over 32 MB, on a torn library',
      { timeout: 60_000 },
      async () => {
        const root = fixture('torn-state')
        fs.writeFileSync(path.join(root, '.anime-dl', 'state.json.tmp'), 'stale')
        const huge = 'x'.repeat(CAPS.stringBytes)
        const dismissed = Array.from({ length: CAPS.stateBytes / CAPS.stringBytes + 1 }, () => huge)
        const doc: SharedSyncDoc = { ...EMPTY_DOC, titles: { '101': { dismissed } } }
        await refuses(root, () => writeState(root, doc, OWNER, 4), LibraryTooLargeError)
        await expect(writeState(root, doc, OWNER, 4)).rejects.toThrow(
          `state.json would be over ${CAPS.stateBytes} bytes`
        )
      }
    )
  })
})

describe('step 4 with a null manifest.prev', () => {
  it('writeManifest repairs only the manifest side and leaves the invalid state as an orphan', async () => {
    const root = fixture('step4-null-prev')
    const orphan = fs.readFileSync(path.join(root, '.anime-dl', 'state.json'))
    const r = await ok(root)
    await writeManifest(root, { ...r.manifest, items: withExtra(r.manifest.items) }, OWNER, 7)
    expect(fs.readFileSync(path.join(root, '.anime-dl', 'state.json'))).toEqual(orphan)
    const after = await ok(root)
    expect(after).toMatchObject({
      torn: false,
      state: null,
      pair: { manifest: 'manifest.json', state: null }
    })
    expect(after.manifest.generation).toBe(8)
  })
})

describe('other-library state', () => {
  it('the owner’s next write repairs, removing the foreign state.json and manifest.json 7/4', async () => {
    const root = fixture('other-library-state')
    await run('writeManifest', root)
    const r = await ok(root)
    expect(r.torn).toBe(false)
    expect(r.state!.libraryId).toBe(LIB)
    expect(`${r.manifest.generation}/${r.manifest.stateGeneration} + ${r.state!.generation}`).toBe(
      '7/3 + 3'
    )
    expect(exists(root, 'state.prev.json')).toBe(false)
  })

  it('the variant after manifest-only writes: both writers refuse, the tree byte-identical', async () => {
    const root = fixture('other-library-after-manifest-only')
    const m = manifest(9, 4) as unknown as SharedLibraryManifestInput
    await refuses(root, () => writeManifest(root, m, OWNER, 9), LibraryReadOnlyError)
    await refuses(root, () => writeState(root, EMPTY_DOC, OWNER, 4), LibraryReadOnlyError)
  })
})

describe('the pair rule through the writer', () => {
  it('a manifest-only write reads back read-write and untorn, and writeState then succeeds', async () => {
    const root = tree({
      'manifest.json': manifest(7, 4),
      'state.json': state(4, 7),
      'state.prev.json': state(3, 6)
    })
    await run('writeManifest', root)
    const r = await ok(root)
    expect(r.torn).toBe(false)
    expect(`${r.manifest.generation}/${r.manifest.stateGeneration}`).toBe('8/4')
    await run('writeState', root)
    expect((await ok(root)).torn).toBe(false)
  })
})

describe('repairing a torn pair', () => {
  it.each(TORN)('both writers repair: a completed write on %s leaves it untorn', async (name) => {
    for (const op of ['writeManifest', 'writeState'] as const) {
      const root = fixture(name)
      await run(op, root)
      const r = await ok(root)
      expect(r.torn, `${op} on ${name}`).toBe(false)
      expect(r.pair).toEqual({ manifest: 'manifest.json', state: 'state.json' })
    }
  })

  describe('crash injection after each repair step and each normal-write step', () => {
    const cases = [...TORN, 'golden-metadata'].flatMap((name) =>
      (['writeManifest', 'writeState'] as const).map((op) => [name, op] as const)
    )
    it.each(cases)('%s, %s', { timeout: 60_000 }, async (name, op) => {
      let completed = false
      for (let n = 1; !completed; n++) {
        const root = fixture(name)
        const crash = crashAt(n)
        try {
          await run(op, root)
          completed = true
        } catch (err) {
          if (!(err instanceof CrashError)) throw err
        } finally {
          crash.restore()
        }
        const after = await readLibrary(root)
        expect(after.status, `${name} ${op}: crash at call ${n}`).toBe('ok')
        await run(op, root)
        const final = await ok(root)
        expect(final.torn, `${name} ${op}: re-run after call ${n}`).toBe(false)
        expect(final.pair).toEqual({ manifest: 'manifest.json', state: 'state.json' })
        expect(n).toBeLessThan(40)
      }
    })
  })

  describe('a refused write on a torn library changes nothing', () => {
    function torn(name: string): string {
      const root = fixture(name)
      for (const f of ['manifest.json.tmp', 'state.json.tmp']) {
        fs.writeFileSync(path.join(root, '.anime-dl', f), 'stale')
      }
      return root
    }
    const metadata = (over: Record<string, unknown> = {}): SharedLibraryManifestInput =>
      manifest(7, 4, over) as unknown as SharedLibraryManifestInput

    it.each(TORN)('%s', async (name) => {
      const root = torn(name)
      const g = (await ok(root)).manifest.generation
      await refuses(
        root,
        () => writeManifest(root, metadata({ libraryId: OTHER_LIB }), OWNER, g),
        LibraryIdMismatchError
      )
      await refuses(root, () => writeManifest(root, metadata(), OWNER, g + 1), StaleGenerationError)
      await refuses(root, () => writeState(root, EMPTY_DOC, OWNER, 99), StaleGenerationError)
      await refuses(root, () => writeState(root, EMPTY_DOC, STRANGER, 4), NotOwnerError)
      await refuses(root, () => writeManifest(root, metadata(), STRANGER, g), NotOwnerError)
      await refuses(
        root,
        () => writeManifest(root, metadata(), OWNER, g, { takeover: true }),
        NotOwnerError
      )
    })
  })

  describe('s₀ before the repair', () => {
    it('torn-state: writeState writes generation 6, counting the unpaired 5/8', async () => {
      const root = fixture('torn-state')
      expect(await run('writeState', root)).toEqual({ generation: 8, stateGeneration: 6 })
      expect(readJson(root, 'state.json').generation).toBe(6)
    })

    it('torn-both: writeState writes 6, counting manifest.json’s stateGeneration 5', async () => {
      const root = fixture('torn-both')
      await run('writeState', root)
      expect(readJson(root, 'state.json').generation).toBe(6)
    })
  })

  describe('expectedGeneration on a torn read is the chosen manifest’s', () => {
    it('manifest-torn: writeManifest takes 7 (manifest.prev); anything else is stale', async () => {
      const root = fixture('torn-manifest')
      const m = (await ok(root)).manifest
      for (const g of [8, 6]) {
        await refuses(root, () => writeManifest(root, m, OWNER, g), StaleGenerationError)
      }
      await expect(writeManifest(root, m, OWNER, 7)).resolves.toEqual({
        generation: 8,
        stateGeneration: 4
      })
    })

    it('manifest-torn: writeState takes 4', async () => {
      const root = fixture('torn-manifest')
      const doc = (await ok(root)).state!.doc
      await refuses(root, () => writeState(root, doc, OWNER, 5), StaleGenerationError)
      await expect(writeState(root, doc, OWNER, 4)).resolves.toEqual({
        generation: 8,
        stateGeneration: 5
      })
    })
  })
})

describe('the atomic write', () => {
  it(
    'never renames onto an existing target, the repair’s rename included',
    { timeout: 60_000 },
    async () => {
      const rename = fs.promises.rename
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (fs.existsSync(to)) {
          throw Object.assign(new Error(`EEXIST: ${to}`), { code: 'EEXIST' })
        }
        return rename(from, to)
      })
      for (const name of [...TORN, 'golden-metadata', 'after-manifest-only']) {
        for (const op of ['writeManifest', 'writeState'] as const) {
          const root = fixture(name)
          await run(op, root)
          expect((await ok(root)).torn).toBe(false)
        }
      }
    }
  )

  it('deletes a pre-existing X.prev before the rename', async () => {
    const root = fixture('after-manifest-only')
    const calls: string[] = []
    const unlink = fs.promises.unlink
    const rename = fs.promises.rename
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (p) => {
      calls.push(`unlink ${path.basename(String(p))}`)
      return unlink(p)
    })
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (a, b) => {
      calls.push(`rename ${path.basename(String(a))} ${path.basename(String(b))}`)
      return rename(a, b)
    })
    await run('writeState', root)
    expect(calls).toEqual([
      'unlink state.prev.json',
      'rename state.json state.prev.json',
      'rename state.json.tmp state.json',
      'unlink manifest.prev.json',
      'rename manifest.json manifest.prev.json',
      'rename manifest.json.tmp manifest.json'
    ])
  })
})

describe('the first write into a With-metadata library', () => {
  const NEW: SharedLibraryManifestInput = {
    libraryId: LIB,
    name: 'New library',
    owner: { shikimoriId: OWNER_ID, nickname: 'owner' },
    mode: 'metadata',
    titles: [{ animeId: 101, name: 'Frieren' }],
    items: [item('1', 9001) as SharedLibraryItem]
  }

  function emptyRoot(): string {
    const root = tree({})
    fs.rmSync(path.join(root, '.anime-dl'), { recursive: true })
    return root
  }

  async function step1(kind: 'new' | 'takeover', root: string): Promise<void> {
    if (kind === 'new') {
      await createLibrary(root, NEW, OWNER)
      return
    }
    await writeManifest(root, NEW, OWNER, 3, { takeover: true })
  }

  function start(kind: 'new' | 'takeover'): string {
    if (kind === 'new') return emptyRoot()
    return tree({ 'manifest.json': manifest(3, null, { mode: 'videos' }) })
  }

  it.each(['new', 'takeover'] as const)(
    '%s: after step 1, empty state; writeState with null succeeds',
    async (kind) => {
      const root = start(kind)
      await step1(kind, root)
      const r = await ok(root)
      expect(r).toMatchObject({
        mode: 'metadata',
        state: null,
        stateInitialized: false,
        torn: false
      })
      expect(r.manifest.stateGeneration).toBeNull()
      expect(r.manifest.owner?.shikimoriId).toBe(OWNER_ID)
      await writeState(root, EMPTY_DOC, OWNER, null)
      expect((await ok(root)).stateInitialized).toBe(true)
    }
  )

  it.each(['new', 'takeover'] as const)(
    '%s: a kill after every step reads as the table says',
    { timeout: 60_000 },
    async (kind) => {
      const seen = new Set<string>()
      let completed = false
      for (let n = 1; !completed; n++) {
        const root = start(kind)
        let stage: 'step1' | 'step2/3' = 'step1'
        const crash = crashAt(n)
        try {
          await step1(kind, root)
          stage = 'step2/3'
          await writeState(root, EMPTY_DOC, OWNER, null)
          completed = true
        } catch (err) {
          if (!(err instanceof CrashError)) throw err
        } finally {
          crash.restore()
        }
        const r = await readLibrary(root)
        const where = `${kind}, crash at call ${n} (${stage})`
        if (r.status === 'none') {
          expect(kind, where).toBe('new')
          expect(stage, where).toBe('step1')
          expect(await discoverLibraries(root), where).toEqual([])
          seen.add('no library')
          continue
        }
        expect(r.status, where).toBe('ok')
        const read = r as Ok
        if (read.mode === 'videos') {
          // Before the rename, or inside it: then the Videos-only manifest.prev, torn.
          expect([kind, stage], where).toEqual(['takeover', 'step1'])
          expect(read.torn, where).toBe(read.pair.manifest === 'manifest.prev.json')
          if (read.torn) seen.add('videos manifest.prev, torn')
          continue
        }
        // Inside step 1's or step 3's rename the reader falls back to manifest.prev, torn.
        expect(read.torn, where).toBe(read.pair.manifest === 'manifest.prev.json')
        if (read.state === null) {
          expect(read.stateInitialized, where).toBe(false)
          const orphan = exists(root, 'state.json') ? readJson(root, 'state.json').generation : 0
          if (orphan > 0) seen.add('empty state next to an orphan')
          else seen.add('empty state')
          const { stateGeneration } = await writeState(root, EMPTY_DOC, OWNER, null)
          expect(stateGeneration, where).toBeGreaterThan(orphan)
        } else {
          expect(stage, where).toBe('step2/3')
          seen.add('a matching pair')
        }
        expect(n).toBeLessThan(30)
      }
      expect([...seen].sort()).toEqual(
        [
          kind === 'new' ? 'no library' : 'videos manifest.prev, torn',
          'a matching pair',
          'empty state',
          'empty state next to an orphan'
        ].sort()
      )
    }
  )

  it('refusals: createLibrary refuses an existing manifest or manifest.prev', async () => {
    const root = tree({ 'manifest.json': manifest(3, null, { mode: 'videos' }) })
    await refuses(root, () => createLibrary(root, NEW, OWNER), LibraryExistsError)
    const prevOnly = tree({ 'manifest.prev.json': manifest(3, null, { mode: 'videos' }) })
    await refuses(prevOnly, () => createLibrary(prevOnly, NEW, OWNER), LibraryExistsError)
  })

  it('createLibrary: metadata needs the logged-in actor as owner; videos needs no owner', async () => {
    for (const actor of [LOGGED_OUT, STRANGER]) {
      const empty = emptyRoot()
      await refuses(empty, () => createLibrary(empty, NEW, actor), NotOwnerError)
      expect(fs.existsSync(path.join(empty, '.anime-dl'))).toBe(false)
    }
    const owned = emptyRoot()
    await refuses(
      owned,
      () => createLibrary(owned, { ...NEW, mode: 'videos' }, LOGGED_OUT),
      InvalidLibraryDataError
    )
    const videos = { ...NEW, mode: 'videos' as const, owner: null }
    const root = emptyRoot()
    await createLibrary(root, videos, LOGGED_OUT)
    expect((await ok(root)).mode).toBe('videos')
  })

  it('writeManifest or writeState on a root with no library throws LibraryNotFoundError', async () => {
    const root = emptyRoot()
    await expect(writeManifest(root, NEW, OWNER, 1)).rejects.toBeInstanceOf(LibraryNotFoundError)
    await expect(writeState(root, EMPTY_DOC, OWNER, null)).rejects.toBeInstanceOf(
      LibraryNotFoundError
    )
  })
})

describe('the owner check in writeState', () => {
  const metadata = (): string => fixture('golden-metadata')

  it.each([
    ['a logged-in non-owner', STRANGER],
    [
      'a claim for a different libraryId',
      { ...CLAIMANT, claim: { libraryId: OTHER_LIB, ownerId: OWNER_ID } }
    ],
    ['a claim for a different owner', { ...CLAIMANT, claim: { libraryId: LIB, ownerId: 1 } }],
    ['no account and no claim', LOGGED_OUT]
  ])('throws NotOwnerError for %s', async (_, actor) => {
    const root = metadata()
    await refuses(root, () => writeState(root, EMPTY_DOC, actor, 4), NotOwnerError)
  })

  it('throws on a videos library and with a stale expectedStateGeneration', async () => {
    const videos = fixture('golden-videos')
    await refuses(videos, () => writeState(videos, EMPTY_DOC, OWNER, null), NotOwnerError)
    const root = metadata()
    await refuses(root, () => writeState(root, EMPTY_DOC, OWNER, 3), StaleGenerationError)
  })

  it.each([
    ['the owner', OWNER],
    ['a matching claim', CLAIMANT]
  ])('succeeds for %s', async (_, actor) => {
    const root = metadata()
    await expect(writeState(root, EMPTY_DOC, actor, 4)).resolves.toEqual({
      generation: 8,
      stateGeneration: 5
    })
  })
})

describe('writeManifest', () => {
  it('any actor, logged out included, adds items to a null-owner library', async () => {
    const root = fixture('golden-videos')
    const m = (await ok(root)).manifest
    await writeManifest(root, { ...m, items: withExtra(m.items) }, LOGGED_OUT, 3)
    expect((await ok(root)).manifest.items).toHaveLength(3)
  })

  it('but can’t change its owner or mode that way', async () => {
    const root = fixture('golden-videos')
    const m = (await ok(root)).manifest
    const owner = { shikimoriId: OWNER_ID, nickname: 'owner' }
    await refuses(
      root,
      () => writeManifest(root, { ...m, mode: 'metadata', owner }, OWNER, 3),
      IdentityChangeError
    )
    await refuses(
      root,
      () => writeManifest(root, { ...m, owner }, LOGGED_OUT, 3),
      IdentityChangeError
    )
  })

  it('{ takeover: true } by a logged-in actor sets the owner and metadata, with stateGeneration null', async () => {
    const root = fixture('golden-videos')
    const m = (await ok(root)).manifest
    const owner = { shikimoriId: STRANGER.shikimoriUserId!, nickname: 'stranger' }
    await writeManifest(root, { ...m, mode: 'metadata', owner }, STRANGER, 3, { takeover: true })
    const r = await ok(root)
    expect(r.manifest).toMatchObject({ mode: 'metadata', owner, stateGeneration: null })
  })

  it('{ takeover: true } is refused on an owned library, one owned by the actor, and from a claim', async () => {
    const owned = fixture('golden-metadata')
    const m = (await ok(owned)).manifest
    const as = (actor: SharedLibraryActor) =>
      writeManifest(owned, { ...m, owner: { shikimoriId: actor.shikimoriUserId ?? 0 } }, actor, 7, {
        takeover: true
      })
    await refuses(owned, () => as(STRANGER), NotOwnerError)
    await refuses(owned, () => as(OWNER), NotOwnerError)
    const videos = fixture('golden-videos')
    const v = (await ok(videos)).manifest
    await refuses(
      videos,
      () =>
        writeManifest(
          videos,
          { ...v, mode: 'metadata', owner: { shikimoriId: OWNER_ID } },
          CLAIMANT,
          3,
          { takeover: true }
        ),
      NotOwnerError
    )
  })

  it('an owner change without takeover is refused', async () => {
    const root = fixture('golden-metadata')
    const m = (await ok(root)).manifest
    await refuses(
      root,
      () => writeManifest(root, { ...m, owner: { shikimoriId: 1 } }, OWNER, 7),
      IdentityChangeError
    )
  })

  it('a metadata library needs the owner or a matching claim', async () => {
    const root = fixture('golden-metadata')
    const m = (await ok(root)).manifest
    await refuses(root, () => writeManifest(root, m, LOGGED_OUT, 7), NotOwnerError)
    await expect(writeManifest(root, m, CLAIMANT, 7)).resolves.toEqual({
      generation: 8,
      stateGeneration: 4
    })
  })
})

describe('orphan state files are replaced by the next writeState, never rotated into .prev', () => {
  type Orphan = 'v2' | 'over-cap'
  /** A With-metadata manifest with empty state, next to orphans the reader must ignore. */
  function withOrphans(orphans: Partial<Record<'state.json' | 'state.prev.json', Orphan>>): string {
    const files: Record<string, unknown> = { 'manifest.json': manifest(3, null) }
    for (const [file, kind] of Object.entries(orphans)) {
      if (kind === 'v2') files[file] = { ...state(5, 8), stateVersion: 2 }
    }
    const root = tree(files)
    for (const [file, kind] of Object.entries(orphans)) {
      if (kind === 'over-cap') sparse(root, file, CAPS.stateBytes + 1024 * 1024)
    }
    return root
  }

  const cases: [string, Partial<Record<'state.json' | 'state.prev.json', Orphan>>][] = [
    ['a v2 state.json', { 'state.json': 'v2' }],
    ['a 33 MB sparse state.json', { 'state.json': 'over-cap' }],
    ['a v2 state.prev.json', { 'state.prev.json': 'v2' }],
    ['a 33 MB sparse state.prev.json', { 'state.prev.json': 'over-cap' }],
    ['both, v2 and over-cap', { 'state.json': 'v2', 'state.prev.json': 'over-cap' }]
  ]

  it.each(cases)(
    '%s: ok before, writeState succeeds, ok after with no state.prev.json',
    async (_, orphans) => {
      const root = withOrphans(orphans)
      expect((await ok(root)).stateInitialized).toBe(false)
      const { stateGeneration } = await writeState(root, EMPTY_DOC, OWNER, null)
      const after = await ok(root)
      expect(after).toMatchObject({
        torn: false,
        pair: { manifest: 'manifest.json', state: 'state.json' }
      })
      expect(exists(root, 'state.prev.json')).toBe(false)
      if (orphans['state.json'] === 'v2') expect(stateGeneration).toBeGreaterThan(5)
    }
  )

  it.each(cases)(
    '%s: a kill after every step still reads ok, and a re-run ends ok',
    { timeout: 60_000 },
    async (_, orphans) => {
      let completed = false
      for (let n = 1; !completed; n++) {
        const root = withOrphans(orphans)
        const crash = crashAt(n)
        try {
          await writeState(root, EMPTY_DOC, OWNER, null)
          completed = true
        } catch (err) {
          if (!(err instanceof CrashError)) throw err
        } finally {
          crash.restore()
        }
        const mid = await readLibrary(root)
        expect(mid.status, `crash at call ${n}: ${JSON.stringify(mid).slice(0, 120)}`).toBe('ok')
        const r = mid as Ok
        if (r.manifest.stateGeneration === null) {
          await writeState(root, EMPTY_DOC, OWNER, null)
        }
        const final = await ok(root)
        expect(final.torn, `re-run after call ${n}`).toBe(false)
        expect(final.stateInitialized).toBe(true)
        expect(exists(root, 'state.prev.json'), `re-run after call ${n}`).toBe(false)
        expect(n).toBeLessThan(30)
      }
    }
  )

  it('takeover and the step-4 null manifest.prev keep orphans ignored until writeState replaces them', async () => {
    const takeover = tree({
      'manifest.json': manifest(3, null, { mode: 'videos' }),
      'state.json': { ...state(5, 8), stateVersion: 2 }
    })
    const v = (await ok(takeover)).manifest
    const owner = { shikimoriId: OWNER_ID, nickname: 'owner' }
    await writeManifest(takeover, { ...v, mode: 'metadata', owner }, OWNER, 3, { takeover: true })
    expect((await ok(takeover)).state).toBeNull()
    await writeState(takeover, EMPTY_DOC, OWNER, null)
    expect((await ok(takeover)).stateInitialized).toBe(true)
    expect(exists(takeover, 'state.prev.json')).toBe(false)

    // Step 4's null manifest.prev: the repair restores it, and the invalid state.json
    // it leaves as an orphan is replaced, not rotated.
    const step4 = fixture('step4-null-prev')
    await writeState(step4, EMPTY_DOC, OWNER, null)
    const r = await ok(step4)
    expect(r).toMatchObject({
      torn: false,
      pair: { manifest: 'manifest.json', state: 'state.json' }
    })
    expect(exists(step4, 'state.prev.json')).toBe(false)
  })
})
