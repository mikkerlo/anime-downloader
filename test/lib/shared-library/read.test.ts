// The Shared Library reader (#573): the pair search, the read-only decisions
// that come before it, envelope-only invalidity and untrusted input.
import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPS, unknownFieldsOf } from '../../../src/main/lib/shared-library/format'
import {
  readLibrary,
  readManifest,
  readMeta,
  readState
} from '../../../src/main/lib/shared-library/read'
import {
  LIB,
  OTHER_LIB,
  cleanup,
  fixture,
  item,
  manifest,
  sparse,
  state,
  text,
  tinyItem,
  tree
} from '../../helpers/shared-library'

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

type Ok = Extract<SharedLibraryRead, { status: 'ok' }>
type ReadOnly = Extract<SharedLibraryRead, { status: 'read-only' }>

async function ok(root: string): Promise<Ok> {
  const r = await readLibrary(root)
  expect(r.status, JSON.stringify(r).slice(0, 300)).toBe('ok')
  return r as Ok
}

async function readOnly(root: string): Promise<ReadOnly> {
  const r = await readLibrary(root)
  expect(r.status).toBe('read-only')
  return r as ReadOnly
}

/** `(manifest generation/stateGeneration, state generation/manifestGeneration)` of a pair. */
function gens(r: Ok): string {
  const m = `${r.manifest.generation}/${r.manifest.stateGeneration}`
  return r.state ? `${m} + ${r.state.generation}/${r.state.manifestGeneration}` : `${m} + none`
}

describe('golden files', () => {
  it('a With-metadata library reads as a fixed object', async () => {
    const r = await ok(fixture('golden-metadata'))
    expect(r).toMatchObject({
      mode: 'metadata',
      torn: false,
      stateInitialized: true,
      pair: { manifest: 'manifest.json', state: 'state.json' }
    })
    expect(JSON.parse(JSON.stringify(r.manifest))).toEqual(manifest(7, 4, { layoutMinor: 1 }))
    expect(JSON.parse(JSON.stringify(r.state))).toEqual(state(4, 7))
  })

  it('a Videos-only library pairs with no state', async () => {
    const r = await ok(fixture('golden-videos'))
    expect(r).toMatchObject({ mode: 'videos', state: null, stateInitialized: false, torn: false })
    expect(r.manifest.items.map((i) => i.episodeInt)).toEqual(['1', '12.5'])
    expect(r.manifest.naming).toEqual({ rule: 'v1', renamed: ['101:12.5:9002'] })
  })

  it('no manifest at all is no library', async () => {
    expect(await readLibrary(tree({}))).toEqual({ status: 'none' })
  })
})

describe('read-only decisions', () => {
  it('a newer minor opens read-write and keeps its unknown fields in the bag', async () => {
    const r = await ok(fixture('newer-minor-manifest'))
    expect(r.manifest.layoutMinor).toBe(2)
    expect(unknownFieldsOf(r.manifest)).toEqual({ checksumAlgorithm: 'sha256' })
    expect(unknownFieldsOf(r.manifest.owner!)).toEqual({ avatar: 'https://example.invalid/a.png' })
    expect(unknownFieldsOf(r.manifest.naming!)).toEqual({ normalization: 'nfc' })
    expect(unknownFieldsOf(r.manifest.items[0])).toEqual({ container: 'matroska' })
    expect(Object.keys(r.manifest)).not.toContain('checksumAlgorithm')
  })

  it('a newer-minor state keeps plain keys at the doc and title levels and bags below', async () => {
    const r = await ok(fixture('newer-minor-state'))
    const doc = r.state!.doc
    expect(r.state!.stateMinor).toBe(1)
    expect(doc.deviceNames).toEqual({ 'pc-owner': 'Desktop' })
    expect(doc.titles!['101'].lastOpenedAt).toBe(1761600000123)
    expect(unknownFieldsOf(doc.titles!['101'].watch!['1'])).toEqual({ playbackRate: 1.25 })
    expect(unknownFieldsOf(doc.titles!['101'].skip!)).toEqual({ fingerprintVersion: 2 })
    expect(unknownFieldsOf(doc.tombstones!['303'])).toEqual({ reason: 'removed-from-drive' })
    expect(unknownFieldsOf(r.state!)).toEqual({ compression: 'none' })
  })

  describe('a newer major comes before the pair search, with no fallback', () => {
    it('newer-major state: read-only, not torn (step 4 would pair the .prev files)', async () => {
      const r = await readOnly(fixture('newer-major-state'))
      expect(r.reason).toBe('version')
      expect(r.message).toMatch(/newer version/)
      expect(r).not.toHaveProperty('torn')
    })

    it('newer-major manifest: read-only, no fallback to manifest.prev at step 1', async () => {
      const r = await readOnly(fixture('newer-major-manifest'))
      expect(r.reason).toBe('version')
      expect(r.manifest).toBeNull()
    })

    it('a newer major in manifest.prev alone also opens read-only', async () => {
      const root = tree({
        'manifest.json': manifest(8, 4),
        'manifest.prev.json': manifest(7, 4, { layoutVersion: 2 }),
        'state.json': state(4, 7)
      })
      const r = await readOnly(root)
      expect(r.reason).toBe('version')
      expect(r.manifest?.generation).toBe(8)
    })

    it('orphans stay ignored: a v2 orphan state next to a null manifest is read-write', async () => {
      const root = tree({
        'manifest.json': manifest(3, null),
        'state.json': { ...state(5, 8), stateVersion: 2 },
        'state.prev.json': { ...state(4, 7), stateVersion: 2 }
      })
      const r = await ok(root)
      expect(r).toMatchObject({
        mode: 'metadata',
        state: null,
        stateInitialized: false,
        torn: false
      })
    })
  })

  describe('over a cap means read-only, not invalid', () => {
    it('an over-cap state.json opens read-only (size), not torn', async () => {
      const root = tree({
        'manifest.json': manifest(8, 5),
        'manifest.prev.json': manifest(7, 4),
        'state.prev.json': state(4, 7)
      })
      sparse(root, 'state.json', CAPS.stateBytes + 1)
      const r = await readOnly(root)
      expect(r.reason).toBe('size')
      expect(r.message).toBe('This library is larger than this version can open')
      expect(r.manifest?.generation).toBe(8)
    })

    it('an over-cap manifest.json opens read-only (size) with nothing to list', async () => {
      const root = tree({ 'manifest.prev.json': manifest(7, 4), 'state.json': state(4, 7) })
      sparse(root, 'manifest.json', CAPS.manifestBytes + 1)
      const r = await readOnly(root)
      expect(r.reason).toBe('size')
      expect(r.manifest).toBeNull()
    })

    it(
      'a manifest with 200,001 items opens read-only (size), not truncated',
      { timeout: 60_000 },
      async () => {
        const items = Array.from({ length: CAPS.items + 1 }, (_, i) => tinyItem(i + 1))
        const root = tree({
          'manifest.json': JSON.stringify(manifest(3, null, { mode: 'videos', items }))
        })
        // Under the size cap, so the item cap is what decides.
        expect(fs.statSync(path.join(root, '.anime-dl', 'manifest.json')).size).toBeLessThan(
          CAPS.manifestBytes
        )
        const r = await readOnly(root)
        expect(r.reason).toBe('size')
        expect(r.manifest).toBeNull()
      }
    )

    it('stats before parsing: an over-cap file is never read', async () => {
      const root = tree({
        'manifest.json': manifest(8, 5),
        'manifest.prev.json': manifest(7, 4),
        'state.prev.json': state(4, 7)
      })
      sparse(root, 'state.json', CAPS.stateBytes + 1)
      const readFile = vi.spyOn(fs.promises, 'readFile')
      await readOnly(root)
      const read = readFile.mock.calls.map((c) => path.basename(String(c[0])))
      expect(read).toContain('manifest.json')
      expect(read).not.toContain('state.json')
    })
  })
})

describe('the pair search', () => {
  it('torn pair: (manifest, state.prev), torn', async () => {
    const r = await ok(fixture('torn-state'))
    expect(r.torn).toBe(true)
    expect(r.pair).toEqual({ manifest: 'manifest.json', state: 'state.prev.json' })
    expect(gens(r)).toBe('7/4 + 4/7')
  })

  it('manifest-torn pair: (manifest.prev, state), torn', async () => {
    const r = await ok(fixture('torn-manifest'))
    expect(r.pair).toEqual({ manifest: 'manifest.prev.json', state: 'state.json' })
    expect(gens(r)).toBe('7/4 + 4/7')
  })

  it('both-torn pair: (manifest.prev, state.prev), torn', async () => {
    const r = await ok(fixture('torn-both'))
    expect(r.pair).toEqual({ manifest: 'manifest.prev.json', state: 'state.prev.json' })
    expect(gens(r)).toBe('9/4 + 4/7')
  })

  it('a pair with no match at all opens read-only (interrupted) and still lists', async () => {
    const root = tree({ 'manifest.json': manifest(7, 4), 'state.json': state(5, 8) })
    const r = await readOnly(root)
    expect(r.reason).toBe('interrupted')
    expect(r.message).toBe(
      'This library was interrupted while being written. Plug it into the PC that last wrote it.'
    )
    expect(r.manifest?.items).toHaveLength(2)
  })

  describe('exact stateGeneration, <= back-reference', () => {
    it('after a manifest-only write: read-write and not torn', async () => {
      const r = await ok(fixture('after-manifest-only'))
      expect(r.torn).toBe(false)
      expect(gens(r)).toBe('8/4 + 4/7')
    })

    it('a crash between the two writes of writeState, from a fresh pair', async () => {
      const r = await ok(fixture('torn-state'))
      expect(r.pair.state).toBe('state.prev.json')
    })

    it('a crash between the two writes of writeState, after a manifest-only write', async () => {
      const root = tree({
        'manifest.json': manifest(8, 4, {
          items: [item('1', 9001), item('2', 9002), item('3', 9003)]
        }),
        'manifest.prev.json': manifest(7, 4),
        'state.json': state(5, 9),
        'state.prev.json': state(4, 7)
      })
      const r = await ok(root)
      expect(r.pair).toEqual({ manifest: 'manifest.json', state: 'state.prev.json' })
      expect(r.manifest.items).toHaveLength(3)
    })

    it('a crash inside a manifest-only write: (manifest.prev, state), torn', async () => {
      const root = tree({ 'manifest.prev.json': manifest(7, 4), 'state.json': state(4, 7) })
      const r = await ok(root)
      expect(r.pair).toEqual({ manifest: 'manifest.prev.json', state: 'state.json' })
      expect(r.torn).toBe(true)
    })

    it('the same crash one manifest-only write later: (manifest.prev, state), torn', async () => {
      const root = tree({
        'manifest.prev.json': manifest(8, 4),
        'state.json': state(4, 7),
        'state.prev.json': state(3, 6)
      })
      const r = await ok(root)
      expect(r.pair).toEqual({ manifest: 'manifest.prev.json', state: 'state.json' })
      expect(gens(r)).toBe('8/4 + 4/7')
    })

    it('the sanity bound: a state from a later manifest is not a pair', async () => {
      const root = tree({ 'manifest.json': manifest(7, 4), 'state.json': state(4, 9) })
      expect((await readOnly(root)).reason).toBe('interrupted')
    })
  })

  it('step 4 with a null manifest.prev: (manifest.prev, none), torn, read-write', async () => {
    const r = await ok(fixture('step4-null-prev'))
    expect(r).toMatchObject({
      torn: true,
      state: null,
      stateInitialized: false,
      pair: { manifest: 'manifest.prev.json', state: null }
    })
  })

  it('a metadata manifest with stateGeneration null is a read-write library with empty state', async () => {
    const root = tree({ 'manifest.json': manifest(1, null), 'state.json': state(1, 2) })
    const r = await ok(root)
    expect(r).toMatchObject({ mode: 'metadata', state: null, stateInitialized: false, torn: false })
  })
})

describe('whole-file invalid is the envelope only', () => {
  it('a bad entry does not invalidate the file', async () => {
    const r = await ok(fixture('dropped-entries-manifest'))
    expect(r.torn).toBe(false)
    expect(r.manifest.items.map((i) => i.episodeInt)).toEqual(['2'])
    expect(r.manifest.titles).toEqual([{ animeId: 101, name: 'Frieren' }])
    expect(r.manifest.naming!.renamed).toEqual(['101:2:9002'])
  })

  it('a bad entry in manifest.json does not fall back to manifest.prev', async () => {
    const root = fixture('dropped-entries-manifest')
    fs.writeFileSync(
      path.join(root, '.anime-dl', 'manifest.prev.json'),
      text(manifest(4, null, { mode: 'videos' }))
    )
    const r = await ok(root)
    expect(r.pair.manifest).toBe('manifest.json')
    expect(r.manifest.generation).toBe(5)
  })

  const manifestRows: [string, (m: Record<string, unknown>) => unknown][] = [
    ['unparseable', () => '{"layoutVersion": 1,'],
    ['not an object', () => '[1, 2]'],
    ['layoutVersion not an integer', (m) => ({ ...m, layoutVersion: '1' })],
    ['layoutVersion at an unknown older major', (m) => ({ ...m, layoutVersion: 0 })],
    ['layoutMinor not an integer', (m) => ({ ...m, layoutMinor: 0.5 })],
    ['libraryId not a uuid', (m) => ({ ...m, libraryId: 'library-1' })],
    ['generation not an integer', (m) => ({ ...m, generation: '7' })],
    ['stateGeneration not an integer or null', (m) => ({ ...m, stateGeneration: '4' })],
    ['mode not in the enum', (m) => ({ ...m, mode: 'everything' })],
    ['owner does not fit mode (metadata, no owner)', (m) => ({ ...m, owner: null })],
    ['owner does not fit mode (videos, an owner)', (m) => ({ ...m, mode: 'videos' })],
    ['items not an array', (m) => ({ ...m, items: {} })],
    ['titles not an array', (m) => ({ ...m, titles: 'all' })]
  ]
  it.each(manifestRows)(
    'manifest envelope fails (%s): falls back to manifest.prev',
    async (_, bad) => {
      const m = bad(manifest(8, 4))
      const root = tree({
        'manifest.json': typeof m === 'string' ? m : text(m),
        'manifest.prev.json': manifest(7, 4),
        'state.json': state(4, 7)
      })
      const r = await ok(root)
      expect(r.pair.manifest).toBe('manifest.prev.json')
    }
  )

  const stateRows: [string, (s: Record<string, any>) => unknown][] = [
    ['unparseable', () => '{"stateVersion": 1,'],
    ['not an object', () => 'null'],
    ['stateVersion not an integer', (s) => ({ ...s, stateVersion: '1' })],
    ['stateMinor not an integer', (s) => ({ ...s, stateMinor: null })],
    ['libraryId not a uuid', (s) => ({ ...s, libraryId: 42 })],
    ['generation not an integer', (s) => ({ ...s, generation: 4.5 })],
    ['manifestGeneration not an integer', (s) => ({ ...s, manifestGeneration: '7' })],
    ['doc not an object', (s) => ({ ...s, doc: [] })],
    ['doc.stateVersion differs', (s) => ({ ...s, doc: { ...s.doc, stateVersion: 2 } })],
    ['doc.stateMinor differs', (s) => ({ ...s, doc: { ...s.doc, stateMinor: 1 } })]
  ]
  it.each(stateRows)('state envelope fails (%s): the file is skipped', async (_, bad) => {
    const s = bad(state(4, 7))
    const root = tree({
      'manifest.json': manifest(7, 4),
      'state.json': typeof s === 'string' ? s : text(s),
      'state.prev.json': state(4, 7)
    })
    const r = await ok(root)
    expect(r.pair).toEqual({ manifest: 'manifest.json', state: 'state.prev.json' })
  })

  it('envelope and doc disagree on stateMinor: the fixture skips state.json', async () => {
    const r = await ok(fixture('state-doc-minor-mismatch'))
    expect(r.pair.state).toBe('state.prev.json')
  })

  it('other-library state: never paired, the reader takes (manifest.prev, state.prev)', async () => {
    const r = await ok(fixture('other-library-state'))
    expect(r.pair).toEqual({ manifest: 'manifest.prev.json', state: 'state.prev.json' })
    expect(r.torn).toBe(true)
    expect(gens(r)).toBe('6/3 + 3/6')
    expect(r.state!.libraryId).toBe(LIB)
  })

  it('other-library variant after manifest-only writes: read-only (interrupted)', async () => {
    const r = await readOnly(fixture('other-library-after-manifest-only'))
    expect(r.reason).toBe('interrupted')
  })

  it('a foreign state with matching generations is read but not paired', async () => {
    const root = tree({
      'manifest.json': manifest(7, 4),
      'state.json': state(4, 7, { libraryId: OTHER_LIB })
    })
    expect((await readOnly(root)).reason).toBe('interrupted')
  })
})

describe('untrusted input', () => {
  it('drops dropped-state entries from what reaches a consumer', async () => {
    const r = await ok(fixture('dropped-entries-state'))
    const title = r.state!.doc.titles!['101']
    expect(Object.keys(title.watch!)).toEqual(['1', '3'])
    expect(title.dismissed).toEqual(['1', '3'])
    expect(Object.keys(r.state!.doc.tombstones!)).toEqual(['202'])
  })

  it('an invalid non-envelope scalar is left out', async () => {
    const r = await ok(fixture('bad-scalar-manifest'))
    expect(r.manifest).not.toHaveProperty('name')
    expect(r.manifest).not.toHaveProperty('lastWriter')
  })

  it('an item whose file is missing stays in the manifest', async () => {
    const root = fixture('golden-metadata')
    const r = await ok(root)
    for (const i of r.manifest.items) expect(fs.existsSync(path.join(root, i.path))).toBe(false)
    expect(r.manifest.items).toHaveLength(2)
  })

  it('makes no realpath call', async () => {
    const realpath = vi.spyOn(fs.promises, 'realpath')
    await ok(fixture('golden-metadata'))
    await ok(fixture('torn-both'))
    expect(realpath).not.toHaveBeenCalled()
  })

  const hostile = [
    '../x',
    'a/../../x',
    '/etc/passwd',
    'C:\\Windows\\x.mkv',
    'C:/x.mkv',
    '\\\\server\\share\\x.mkv',
    '//server/share/x.mkv',
    'a/\0b.mkv',
    'a/./b.mkv',
    'a//b.mkv',
    '...',
    'a/../b',
    'x.mkv:stream',
    ''
  ]
  it.each(hostile)('drops an item with path %j without throwing', async (p) => {
    const root = tree({
      'manifest.json': manifest(3, null, {
        mode: 'videos',
        items: [item('1', 9001, { path: p }), item('2', 9002)]
      })
    })
    const r = await ok(root)
    expect(r.manifest.items.map((i) => i.episodeInt)).toEqual(['2'])
  })

  it('drops an item with an oversized string, and a subtitlePath out of the root is left out', async () => {
    const root = tree({
      'manifest.json': manifest(3, null, {
        mode: 'videos',
        items: [
          item('1', 9001, { translationType: 'x'.repeat(CAPS.stringBytes + 1) }),
          item('2', 9002, { subtitlePath: '../evil.ass' })
        ]
      })
    })
    const r = await ok(root)
    expect(r.manifest.items).toHaveLength(1)
    expect(r.manifest.items[0]).not.toHaveProperty('subtitlePath')
  })

  it.each(['', 'not json', '\u0000\u0001', '{"a":', 'true', '42'])(
    'non-JSON manifest %j with no prev reads as interrupted without throwing',
    async (bytes) => {
      const root = tree({ 'manifest.json': bytes })
      expect((await readOnly(root)).reason).toBe('interrupted')
    }
  )

  it('never surfaces a forbidden name from the drive', async () => {
    const m = manifest(3, null, { mode: 'videos', token: 'secret' }) as any
    m.items[0].syncplayPassword = 'pw'
    const r = await ok(tree({ 'manifest.json': m }))
    expect(unknownFieldsOf(r.manifest)).toBeUndefined()
    expect(unknownFieldsOf(r.manifest.items[0])).toBeUndefined()
  })
})

describe('readManifest / readState: one file on its own', () => {
  it('valid, newer, over a cap, invalid or missing', async () => {
    const root = fixture('newer-major-state')
    const at = (f: string): string => path.join(root, '.anime-dl', f)
    expect((await readManifest(at('manifest.json'))).kind).toBe('valid')
    expect((await readState(at('state.prev.json'))).kind).toBe('valid')
    expect((await readState(at('state.json'))).kind).toBe('newer')
    expect((await readManifest(at('state.json'))).kind).toBe('invalid')
    expect((await readState(at('nope.json'))).kind).toBe('missing')
    sparse(root, 'big.json', CAPS.manifestBytes + 1)
    expect((await readManifest(at('big.json'))).kind).toBe('size')
  })
})

describe('meta/<animeId>.json', () => {
  it('reads with searchResult extra keys in the bag', async () => {
    const r = await readMeta(fixture('golden-metadata'), 101)
    expect(r.status).toBe('ok')
    const meta = (r as { meta: SharedLibraryMeta }).meta
    expect(unknownFieldsOf(meta.searchResult!)).toEqual({ rating: 9.1, studio: 'Madhouse' })
    expect(unknownFieldsOf(meta.searchResult!.titles)).toEqual({ zh: '葬送的芙莉莲' })
  })

  it('missing, over its 1 MB cap, or for another title', async () => {
    const root = fixture('golden-metadata')
    expect(await readMeta(root, 202)).toEqual({ status: 'missing' })
    sparse(root, 'meta/303.json', CAPS.metaBytes + 1)
    expect(await readMeta(root, 303)).toEqual({ status: 'size' })
    fs.copyFileSync(
      path.join(root, '.anime-dl', 'meta', '101.json'),
      path.join(root, '.anime-dl', 'meta', '404.json')
    )
    expect(await readMeta(root, 404)).toEqual({ status: 'invalid' })
    expect(await readMeta(root, -1)).toEqual({ status: 'invalid' })
  })
})
