// What a Shared Library write keeps of what it read (#573): unknown fields by
// path, dropped entries, raw invalid scalars, the minor it read, and nothing
// off the allow-list.
import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryStorage } from '../../helpers/in-memory-storage'
import { applySyncDoc } from '../../../src/main/lib/sync-state/apply'
import { clampSyncDoc } from '../../../src/main/lib/sync-state/clock'
import { pruneDocTombstones } from '../../../src/main/lib/sync-state/gc'
import { projectSyncDoc } from '../../../src/main/lib/sync-state/project'
import {
  CAPS,
  LAYOUT_MINOR,
  STATE_MINOR,
  type RecordNode,
  type SchemaField
} from '../../../src/main/lib/shared-library/format'
import {
  presentKeys,
  type ResolvedItem
} from '../../../src/main/services/shared-library-export/plan'
import { readLibrary } from '../../../src/main/lib/shared-library/read'
import {
  InvalidLibraryDataError,
  LibraryTooLargeError,
  createLibrary,
  writeManifest,
  writeState
} from '../../../src/main/lib/shared-library/write'
import {
  LIB,
  LOGGED_OUT,
  OWNER,
  OWNER_ID,
  cleanup,
  fixture,
  fixtureText,
  item,
  manifest,
  readJson,
  readText,
  state,
  text,
  tree
} from '../../helpers/shared-library'

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

type Ok = Extract<SharedLibraryRead, { status: 'ok' }>

async function ok(root: string): Promise<Ok> {
  const r = await readLibrary(root)
  expect(r.status).toBe('ok')
  return r as Ok
}

const NOW = Date.UTC(2026, 9, 28, 12)

const ALGORITHM = {
  source: 'local',
  sampleRate: 11025,
  matchBitThreshold: 10,
  minRunSec: 20,
  windowSec: 360,
  refineBitThreshold: 8,
  refineSustainHashes: 4
} as ShowSkipDetections['algorithm']

/** A read doc with S4's required fields filled in, as S9 hands it to `applySyncDoc`. */
function asSyncDoc(doc: SharedSyncDoc): SyncDoc {
  return {
    installId: '',
    titles: {},
    priorityOrder: { value: [], at: 0, origin: '' },
    tombstones: {},
    ...doc
  } as SyncDoc
}

/** `file`'s bytes with the writer-owned fields set back to `expected`'s values. */
function writerFieldsAsIn(root: string, file: string, expected: string, fields: string[]): string {
  const out = readJson(root, file)
  const want = JSON.parse(expected)
  for (const f of fields) if (f in out) out[f] = want[f]
  return text(out)
}

const FORMAT = '../../../src/main/lib/shared-library/format'

/**
 * The reader and writer as a minor-0 build has them (#623): no
 * `items[].source` in the schema, and LAYOUT_MINOR 0.
 */
async function minor0Build(): Promise<{
  format: typeof import('../../../src/main/lib/shared-library/format')
  read: typeof import('../../../src/main/lib/shared-library/read')
  write: typeof import('../../../src/main/lib/shared-library/write')
}> {
  vi.resetModules()
  vi.doMock(FORMAT, async (importOriginal) => {
    const real =
      await importOriginal<typeof import('../../../src/main/lib/shared-library/format')>()
    const withoutSource = (f: SchemaField): SchemaField => {
      if (f.name !== 'items' || f.node.kind !== 'array') return f
      const el = f.node.element as RecordNode
      const element = { ...el, fields: el.fields.filter((x) => x.name !== 'source') }
      return { ...f, node: { ...f.node, element } }
    }
    return {
      ...real,
      LAYOUT_MINOR: 0,
      MANIFEST_SCHEMA: {
        ...real.MANIFEST_SCHEMA,
        fields: real.MANIFEST_SCHEMA.fields.map(withoutSource)
      }
    }
  })
  try {
    return {
      format: await import('../../../src/main/lib/shared-library/format'),
      read: await import('../../../src/main/lib/shared-library/read'),
      write: await import('../../../src/main/lib/shared-library/write')
    }
  } finally {
    vi.doUnmock(FORMAT)
    vi.resetModules()
  }
}

const MANIFEST_OWNED = ['generation', 'stateGeneration', 'lastWriter']
const STATE_OWNED = ['generation', 'manifestGeneration']

describe('golden files round-trip byte-for-byte', () => {
  it('a With-metadata library through writeState', async () => {
    const root = fixture('golden-metadata')
    const r = await ok(root)
    await writeState(root, r.state!.doc, OWNER, 4)
    const s = readText(root, 'state.json')
    expect(writerFieldsAsIn(root, 'state.json', s, STATE_OWNED)).toBe(s)
    expect(
      writerFieldsAsIn(
        root,
        'state.json',
        fixtureText('golden-metadata', 'state.json'),
        STATE_OWNED
      )
    ).toBe(fixtureText('golden-metadata', 'state.json'))
    expect(
      writerFieldsAsIn(
        root,
        'manifest.json',
        fixtureText('golden-metadata', 'manifest.json'),
        MANIFEST_OWNED
      )
    ).toBe(fixtureText('golden-metadata', 'manifest.json'))
  })

  it.each(['golden-metadata', 'golden-videos', 'golden-merged'])(
    '%s through writeManifest',
    async (name) => {
      const root = fixture(name)
      const r = await ok(root)
      const actor = r.manifest.mode === 'videos' ? LOGGED_OUT : OWNER
      await writeManifest(root, r.manifest, actor, r.manifest.generation)
      expect(
        writerFieldsAsIn(root, 'manifest.json', fixtureText(name, 'manifest.json'), MANIFEST_OWNED)
      ).toBe(fixtureText(name, 'manifest.json'))
    }
  )
})

describe('items[].source (#623)', () => {
  const MERGED = '101:1:9001'
  const SOURCE = { size: 9000, subtitleSize: 1200, codec: 'copy', outputSize: 10001 }

  /** This PC's pair for episode 1: the `.mp4` and `.ass` sizes. */
  const pairOf = (videoSize: number, subtitleSize: number): Map<string, ResolvedItem> =>
    new Map([
      [
        MERGED,
        {
          key: MERGED,
          animeId: 101,
          episodeInt: '1',
          translationId: 9001,
          translationType: 'subRu',
          author: 'Crunchyroll',
          quality: 1080,
          title: 'Frieren',
          label: 'Episode 1',
          videoPath: '/local/Frieren/Frieren - 01 [Crunchyroll].mp4',
          ext: '.mp4',
          videoSize,
          subtitlePath: '/local/Frieren/Frieren - 01 [Crunchyroll].ass',
          subtitleSize
        }
      ]
    ])

  it('a minor-0 reader keeps source in the item’s bag and writes it back unchanged', async () => {
    const old = await minor0Build()
    const root = fixture('golden-merged')
    const r = await old.read.readLibrary(root)
    expect(r.status).toBe('ok')
    const m = (r as Ok).manifest
    expect(Object.keys(m.items[0])).not.toContain('source')
    expect(old.format.unknownFieldsOf(m.items[0])).toEqual({ source: SOURCE })
    await old.write.writeManifest(root, m, LOGGED_OUT, m.generation)
    expect(
      writerFieldsAsIn(
        root,
        'manifest.json',
        fixtureText('golden-merged', 'manifest.json'),
        MANIFEST_OWNED
      )
    ).toBe(fixtureText('golden-merged', 'manifest.json'))
  })

  it('a minor-0 rewrite of a merged item keeps the old source in the bag, and presentKeys ignores it', async () => {
    const root = fixture('golden-merged')
    // The pair this source describes: present while the `.mkv` it was written for is there.
    const samePair = pairOf(SOURCE.size, SOURCE.subtitleSize)
    expect(presentKeys((await ok(root)).manifest, samePair)).toEqual([MERGED])

    // A minor-0 PC still has the bug: its own pair (another download) isn't
    // present, so it copies that `.mp4` + `.ass` over item 1, by itemKey.
    const old = await minor0Build()
    const r = (await old.read.readLibrary(root)) as Ok
    const replaced = {
      ...r.manifest.items[0],
      path: 'Frieren/Frieren - 01 [Crunchyroll].mp4',
      subtitlePath: 'Frieren/Frieren - 01 [Crunchyroll].ass',
      size: 9500
    }
    delete (replaced as { sha256?: string }).sha256
    await old.write.writeManifest(
      root,
      { ...r.manifest, items: [replaced, ...r.manifest.items.slice(1)] },
      LOGGED_OUT,
      r.manifest.generation
    )
    const raw = readJson(root, 'manifest.json')
    expect(raw.layoutMinor).toBe(1)
    expect(raw.items[0]).toMatchObject({ size: 9500, source: SOURCE })

    const after = (await ok(root)).manifest
    expect(after.items[0].source).toEqual(SOURCE)
    expect(presentKeys(after, samePair)).toEqual([])
    // The minor-0 PC's own pair is present by the size rule.
    expect(presentKeys(after, pairOf(9500, 300))).toEqual([MERGED])
  })

  it('presentKeys: source matches only an unmerged pair', async () => {
    const root = tree({
      'manifest.json': manifest(3, null, {
        mode: 'videos',
        layoutMinor: 1,
        // A merge that ran after the `.ass` went away.
        items: [
          item('1', 9001, { size: 8000, source: { ...SOURCE, subtitleSize: 0, outputSize: 8000 } })
        ]
      })
    })
    const m = (await ok(root)).manifest
    expect(presentKeys(m, pairOf(SOURCE.size, 0))).toEqual([MERGED])
    const lone = pairOf(SOURCE.size, 0)
    lone.set(MERGED, { ...lone.get(MERGED)!, subtitlePath: null })
    expect(presentKeys(m, lone)).toEqual([])
  })

  it('a minor-1 writer: an item rebuilt without source has none, though the drive’s had one', async () => {
    const root = fixture('golden-merged')
    const m = (await ok(root)).manifest
    const copied: SharedLibraryItem = {
      animeId: 101,
      episodeInt: '1',
      translationId: 9001,
      translationType: 'subRu',
      author: 'Crunchyroll',
      quality: 1080,
      path: 'Frieren/Frieren - 01 [Crunchyroll].mp4',
      subtitlePath: 'Frieren/Frieren - 01 [Crunchyroll].ass',
      size: 9500
    }
    await writeManifest(root, { ...m, items: [copied, ...m.items.slice(1)] }, LOGGED_OUT, 3)
    const items = readJson(root, 'manifest.json').items
    expect(items[0]).not.toHaveProperty('source')
    expect(items[1].source).toEqual(m.items[1].source)
  })
})

describe('unknown fields', () => {
  it('a newer-minor manifest keeps them at the top level, in owner, naming and an item', async () => {
    const root = fixture('newer-minor-manifest')
    const r = await ok(root)
    await writeManifest(root, r.manifest, OWNER, 7)
    const expected = fixtureText('newer-minor-manifest', 'manifest.json')
    expect(writerFieldsAsIn(root, 'manifest.json', expected, MANIFEST_OWNED)).toBe(expected)
  })

  it('a newer-minor state.json round-trips through writeState byte-identical', async () => {
    const root = fixture('newer-minor-state')
    const r = await ok(root)
    await writeState(root, r.state!.doc, OWNER, 4)
    const expected = fixtureText('newer-minor-state', 'state.json')
    expect(writerFieldsAsIn(root, 'state.json', expected, STATE_OWNED)).toBe(expected)
  })

  it('through the clamp: read → clampSyncDoc → writeState keeps the watch-entry field', async () => {
    const root = fixture('newer-minor-state')
    const r = await ok(root)
    const { doc } = clampSyncDoc(asSyncDoc(r.state!.doc), NOW)
    await writeState(root, doc, OWNER, 4)
    expect(readJson(root, 'state.json').doc.titles['101'].watch['1'].playbackRate).toBe(1.25)
  })

  describe('the writers carry by path', () => {
    it('a doc rebuilt by spreading, with no bag anywhere, keeps the watch-entry, skip and tombstone fields', async () => {
      const root = fixture('newer-minor-state')
      const doc = (await ok(root)).state!.doc
      const title = doc.titles!['101']
      const rebuilt: SharedSyncDoc = {
        ...doc,
        titles: {
          '101': {
            ...title,
            watch: { '1': { ...title.watch!['1'] } },
            skip: { ...title.skip!, perEpisode: { ...title.skip!.perEpisode } }
          }
        },
        tombstones: pruneDocTombstones(doc.tombstones!, 600, ['303'])
      }
      await writeState(root, rebuilt, OWNER, 4)
      const out = readJson(root, 'state.json').doc
      expect(out.titles['101'].watch['1'].playbackRate).toBe(1.25)
      expect(out.titles['101'].skip.fingerprintVersion).toBe(2)
      expect(out.tombstones['303'].reason).toBe('removed-from-drive')
    })

    it('first sync: a local doc with no plain unknown keys still writes the drive’s', async () => {
      const root = fixture('newer-minor-state')
      const store = new InMemoryStorage({ installId: 'pc-new', library: {}, watchProgress: {} })
      const doc = projectSyncDoc(store, ['101'], { resolveEpisodeFile: () => null })
      expect(Object.keys(doc)).not.toContain('deviceNames')
      await writeState(root, doc, OWNER, 4)
      const out = readJson(root, 'state.json').doc
      expect(out.deviceNames).toEqual({ 'pc-owner': 'Desktop' })
      expect(out.titles['101'].lastOpenedAt).toBe(1761600000123)
    })

    it('collision: the drive’s value is written', async () => {
      const root = fixture('newer-minor-state')
      const doc = (await ok(root)).state!.doc
      await writeState(root, { ...doc, deviceNames: { 'pc-owner': 'Laptop' } }, OWNER, 4)
      expect(readJson(root, 'state.json').doc.deviceNames).toEqual({ 'pc-owner': 'Desktop' })
    })

    it('cross-library leak: library A’s unknown keys never reach library B, and B stays at minor 0', async () => {
      const a = fixture('newer-minor-state')
      const b = fixture('golden-metadata')
      const store = new InMemoryStorage({ installId: 'pc-a', library: {}, watchProgress: {} })
      applySyncDoc(store, asSyncDoc((await ok(a)).state!.doc), ['101', '303'], {
        now: () => NOW,
        localEpisodeFile: () => null,
        skipAlgorithm: ALGORITHM
      })
      const projected = projectSyncDoc(store, ['101'], { resolveEpisodeFile: () => null })
      expect(projected.deviceNames).toEqual({ 'pc-owner': 'Desktop' })
      expect(projected.titles['101'].lastOpenedAt).toBe(1761600000123)
      await writeState(b, projected, OWNER, 4)
      const bytes = readText(b, 'state.json')
      expect(bytes).not.toContain('deviceNames')
      expect(bytes).not.toContain('lastOpenedAt')
      const out = readJson(b, 'state.json')
      expect([out.stateMinor, out.doc.stateMinor]).toEqual([0, 0])
    })

    it('no recreation: a watch entry, or a field, removed from doc stays removed', async () => {
      const root = fixture('newer-minor-state')
      const doc = (await ok(root)).state!.doc
      const { skip: _skip, ...title } = doc.titles!['101']
      void _skip
      await writeState(root, { ...doc, titles: { '101': { ...title, watch: {} } } }, OWNER, 4)
      const out = readJson(root, 'state.json').doc.titles['101']
      expect(out.watch).toEqual({})
      expect(out).not.toHaveProperty('skip')
      expect(out.lastOpenedAt).toBe(1761600000123)
    })

    it('writeManifest: a rebuilt item keeps its unknown field, matched by itemKey', async () => {
      const root = fixture('newer-minor-manifest')
      const m = (await ok(root)).manifest
      const items = [...m.items].reverse().map((i) => ({ ...i }))
      await writeManifest(root, { ...m, items }, OWNER, 7)
      const out = readJson(root, 'manifest.json').items
      expect(out[1]).toMatchObject({ episodeInt: '1', container: 'matroska' })
      expect(out[0]).not.toHaveProperty('container')
    })
  })

  it('envelope and owner: unknown keys survive a write whose envelope and owner are rebuilt', async () => {
    const st = fixture('newer-minor-state')
    await writeState(st, (await ok(st)).state!.doc, OWNER, 4)
    expect(readJson(st, 'state.json').compression).toBe('none')

    const mf = fixture('newer-minor-manifest')
    const m = (await ok(mf)).manifest
    await writeManifest(mf, { ...m, owner: { shikimoriId: OWNER_ID, nickname: 'owner' } }, OWNER, 7)
    expect(readJson(mf, 'manifest.json').owner.avatar).toBe('https://example.invalid/a.png')
  })

  it('through S4: doc- and title-level fields reach meta.unknown, the projection and the drive', async () => {
    const root = fixture('newer-minor-state')
    const store = new InMemoryStorage({ installId: 'pc-a', library: {}, watchProgress: {} })
    applySyncDoc(store, asSyncDoc((await ok(root)).state!.doc), ['101', '303'], {
      now: () => NOW,
      localEpisodeFile: () => null,
      skipAlgorithm: ALGORITHM
    })
    const unknown = store.get<SyncMeta>('syncMeta')!.unknown
    expect(unknown?.doc).toEqual({ deviceNames: { 'pc-owner': 'Desktop' } })
    expect(unknown?.titles?.['101']).toEqual({ lastOpenedAt: 1761600000123 })
    const doc = projectSyncDoc(store, ['101', '303'], { resolveEpisodeFile: () => null })
    await writeState(root, doc, OWNER, 4)
    const out = readJson(root, 'state.json').doc
    expect(out.deviceNames).toEqual({ 'pc-owner': 'Desktop' })
    expect(out.titles['101'].lastOpenedAt).toBe(1761600000123)
  })
})

describe('the writer keeps the minor it read', () => {
  it('a newer-minor state and manifest keep their minor, in the envelope and in doc', async () => {
    const st = fixture('newer-minor-state')
    await writeState(st, (await ok(st)).state!.doc, OWNER, 4)
    const s = readJson(st, 'state.json')
    expect([s.stateMinor, s.doc.stateMinor]).toEqual([1, 1])

    const mf = fixture('newer-minor-manifest')
    const r = await ok(mf)
    await writeState(mf, r.state!.doc, OWNER, 4)
    expect(readJson(mf, 'manifest.json').layoutMinor).toBe(2)
    await writeManifest(mf, (await ok(mf)).manifest, OWNER, 8)
    expect(readJson(mf, 'manifest.json').layoutMinor).toBe(2)
  })

  it('a minor-0 manifest written by this version is stamped LAYOUT_MINOR (1, #623)', async () => {
    const root = tree({ 'manifest.json': manifest(3, null, { mode: 'videos' }) })
    expect((await ok(root)).manifest.layoutMinor).toBe(0)
    await writeManifest(root, (await ok(root)).manifest, LOGGED_OUT, 3)
    expect(LAYOUT_MINOR).toBe(1)
    expect(readJson(root, 'manifest.json').layoutMinor).toBe(1)
  })

  it('a fresh writeState after the first-write table’s step 1 stamps STATE_MINOR', async () => {
    const root = tree({})
    fs.rmSync(path.join(root, '.anime-dl'), { recursive: true })
    await createLibrary(
      root,
      {
        libraryId: LIB,
        name: 'New',
        owner: { shikimoriId: OWNER_ID },
        mode: 'metadata',
        titles: [],
        items: []
      },
      OWNER
    )
    const doc = projectSyncDoc(new InMemoryStorage({ installId: 'pc-owner' }), [], {
      resolveEpisodeFile: () => null
    })
    await writeState(root, doc, OWNER, null)
    const s = readJson(root, 'state.json')
    expect([s.stateMinor, s.doc.stateMinor]).toEqual([STATE_MINOR, STATE_MINOR])
  })
})

describe('dropped entries are carried through', () => {
  const extra = item('4', 9004)

  it('never reach readLibrary’s items', async () => {
    const r = await ok(fixture('dropped-entries-manifest'))
    expect(r.manifest.items.map((i) => i.translationId)).toEqual([9002])
  })

  it('a writeManifest that adds one item writes them back at their indexes, over the string cap', async () => {
    const root = fixture('dropped-entries-manifest')
    const m = (await ok(root)).manifest
    const before = JSON.parse(fixtureText('dropped-entries-manifest', 'manifest.json'))
    await writeManifest(
      root,
      { ...m, items: [...m.items, extra as SharedLibraryItem] },
      LOGGED_OUT,
      5
    )
    const out = readJson(root, 'manifest.json')
    expect(out.items).toEqual([before.items[0], before.items[1], before.items[2], extra])
    expect(out.titles).toEqual(before.titles)
    expect(out.naming.renamed).toEqual(['101:2:9002', 42])
    expect(readText(root, 'manifest.json')).toContain(
      text(before.items[0]).trim().split('\n')[6].trim()
    )
  })

  it('a valid item in next with the same key replaces a carried one', async () => {
    const root = fixture('dropped-entries-manifest')
    const m = (await ok(root)).manifest
    const replacement = item('1', 9001) as SharedLibraryItem
    await writeManifest(root, { ...m, items: [replacement, ...m.items] }, LOGGED_OUT, 5)
    const out = readJson(root, 'manifest.json')
    expect(out.items.map((i: { translationId: number }) => i.translationId)).toEqual([
      9001, 9002, 9003
    ])
    expect(out.items[0].author).toBe('Crunchyroll')
  })

  it('the same holds when the dropped-entries manifest is the chosen manifest.prev', async () => {
    const root = fixture('dropped-entries-manifest')
    const dir = path.join(root, '.anime-dl')
    fs.renameSync(path.join(dir, 'manifest.json'), path.join(dir, 'manifest.prev.json'))
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"broken": ')
    const r = await ok(root)
    expect(r.pair.manifest).toBe('manifest.prev.json')
    const before = JSON.parse(fixtureText('dropped-entries-manifest', 'manifest.json'))
    await writeManifest(
      root,
      { ...r.manifest, items: [...r.manifest.items, extra as SharedLibraryItem] },
      LOGGED_OUT,
      5
    )
    expect(readJson(root, 'manifest.json').items).toEqual([...before.items, extra])
  })

  describe('state entries, by key', () => {
    it('are absent from what reaches applySyncDoc', async () => {
      const r = await ok(fixture('dropped-entries-state'))
      const store = new InMemoryStorage({ installId: 'pc-a', library: {}, watchProgress: {} })
      applySyncDoc(store, asSyncDoc(r.state!.doc), ['101', '202', '303'], {
        now: () => NOW,
        localEpisodeFile: () => null,
        skipAlgorithm: ALGORITHM
      })
      expect(Object.keys(store.get<object>('watchProgress')!).sort()).toEqual(['101:1', '101:3'])
      expect(store.get<string[]>('dismissedContinueWatching')).toEqual(['101:1', '101:3'])
    })

    it('a doc that doesn’t mention them writes them back at their keys, dismissed at its index', async () => {
      const root = fixture('dropped-entries-state')
      const doc = (await ok(root)).state!.doc
      const before = JSON.parse(fixtureText('dropped-entries-state', 'state.json')).doc
      await writeState(root, doc, OWNER, 4)
      const out = readJson(root, 'state.json').doc
      expect(out.titles['101'].watch).toEqual(before.titles['101'].watch)
      expect(Object.keys(out.titles['101'].watch)).toEqual(['1', '2', '3'])
      expect(out.titles['101'].dismissed).toEqual(['1', 7, '3'])
      expect(out.tombstones).toEqual(before.tombstones)
    })

    it('a valid entry under the same key replaces the carried one', async () => {
      const root = fixture('dropped-entries-state')
      const doc = (await ok(root)).state!.doc
      const title = doc.titles!['101']
      const fixed = { ...title, watch: { ...title.watch, '2': title.watch!['1'] } }
      const stone = { starred: { deleted: true as const, at: 700, origin: 'pc-owner' } }
      await writeState(
        root,
        { ...doc, titles: { '101': fixed }, tombstones: { ...doc.tombstones, '303': stone } },
        OWNER,
        4
      )
      const out = readJson(root, 'state.json').doc
      expect(out.titles['101'].watch['2']).toEqual(out.titles['101'].watch['1'])
      expect(out.tombstones['303']).toEqual(stone)
    })
  })
})

describe('invalid scalars keep their raw value', () => {
  it('a next with no name writes the raw name back; a valid one replaces it', async () => {
    const root = fixture('bad-scalar-manifest')
    const r = await ok(root)
    expect(r.manifest).not.toHaveProperty('name')
    await writeManifest(root, r.manifest, LOGGED_OUT, 5)
    const out = readJson(root, 'manifest.json')
    expect(out.name).toBe('N'.repeat(3072))
    expect(out.lastWriter).toMatchObject({ installId: 'pc-anon', appVersion: '5.0.25' })
    expect(out.generation).toBe(6)

    await writeManifest(root, { ...r.manifest, name: 'Renamed' }, LOGGED_OUT, 6)
    expect(readJson(root, 'manifest.json').name).toBe('Renamed')
  })

  it('every non-envelope field is optional in the result type', () => {
    const m = manifest(1, null) as unknown as SharedLibraryManifest
    // @ts-expect-error -- `name` may be missing: it fails validation and is left out.
    const name: string = m.name
    // @ts-expect-error -- `naming` may be missing too.
    const renamed: string[] = m.naming.renamed
    expect([name, renamed]).toHaveLength(2)
  })
})

describe('paths are checked at use, not at read', () => {
  it('an item whose file doesn’t exist round-trips through writeManifest', async () => {
    const root = fixture('golden-metadata')
    const r = await ok(root)
    expect(fs.existsSync(path.join(root, r.manifest.items[0].path))).toBe(false)
    await writeManifest(root, r.manifest, OWNER, 7)
    expect((await ok(root)).manifest.items).toHaveLength(2)
  })
})

describe('the allow-list', () => {
  const FORBIDDEN = ['token', 'syncplayPassword', 'shikimoriCredentials']
  const scan = (root: string): void => {
    for (const f of ['manifest.json', 'state.json']) {
      const bytes = readText(root, f)
      for (const name of FORBIDDEN) expect(bytes, `${f} holds ${name}`).not.toContain(name)
    }
  }

  it('a store holding secrets never yields them, nor does a read object given an own token', async () => {
    const root = fixture('golden-metadata')
    const r = await ok(root)
    const store = new InMemoryStorage({
      installId: 'pc-owner',
      token: { access_token: 'secret' },
      syncplayPassword: 'pw',
      shikimoriCredentials: { clientSecret: 'x' },
      syncMeta: {
        titles: {},
        rates: {},
        unknown: { doc: { token: 'doc-secret' }, titles: { '101': { syncplayPassword: 'pw' } } }
      }
    })
    const doc = projectSyncDoc(store, ['101'], { resolveEpisodeFile: () => null })
    await writeState(root, { ...doc, token: 'again' }, OWNER, 4)
    const m = (await ok(root)).manifest
    ;(m as unknown as Record<string, unknown>).token = 'secret'
    ;(m.items[0] as unknown as Record<string, unknown>).token = 'secret'
    ;(m.owner as unknown as Record<string, unknown>).shikimoriCredentials = 'x'
    await writeManifest(root, m, OWNER, r.manifest.generation + 1)
    scan(root)
  })

  it('carried plain keys: a token planted in the drive’s doc and title levels doesn’t reach the bytes', async () => {
    const s = state(4, 7) as any
    s.doc.token = 'doc-secret'
    s.doc.titles['101'].token = 'title-secret'
    s.doc.titles['101'].watch['1'].syncplayPassword = 'nested'
    s.doc.deviceNames = { a: 1 }
    const root = tree({ 'manifest.json': manifest(7, 4), 'state.json': s })
    const r = await ok(root)
    await writeState(root, r.state!.doc, OWNER, 4)
    scan(root)
    expect(readJson(root, 'state.json').doc.deviceNames).toEqual({ a: 1 })
  })
})

describe('caps on what the writer produces', () => {
  it('next over the string cap is LibraryTooLargeError; a malformed one is InvalidLibraryDataError', async () => {
    const root = fixture('golden-videos')
    const m = (await ok(root)).manifest
    await expect(
      writeManifest(root, { ...m, name: 'x'.repeat(CAPS.stringBytes + 1) }, LOGGED_OUT, 3)
    ).rejects.toBeInstanceOf(LibraryTooLargeError)
    await expect(
      writeManifest(
        root,
        { ...m, items: [{ ...m.items[0], path: '../escape.mkv' }] },
        LOGGED_OUT,
        3
      )
    ).rejects.toBeInstanceOf(InvalidLibraryDataError)
    expect(readText(root, 'manifest.json')).toBe(fixtureText('golden-videos', 'manifest.json'))
  })
})
