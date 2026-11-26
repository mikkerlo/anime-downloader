// The Shared Library format (#573): the version rule enforced by the schema
// fingerprint, the unknown-field bag, `itemKey` and `searchResult`'s narrowing.
import * as fs from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { KNOWN_DOC_FIELDS, KNOWN_TITLE_FIELDS } from '../../../src/main/lib/sync-state/project'
import {
  CAPS,
  DOC_LEVEL_FIELDS,
  LAYOUT_MINORS,
  MANIFEST_SCHEMAS,
  TITLE_LEVEL_FIELDS,
  carryUnknown,
  compareFingerprint,
  describeSchema,
  emit,
  itemKey,
  layoutVersionFor,
  serializeMeta,
  setUnknownFields,
  toAnimeSearchResult,
  unknownFieldsOf,
  type LayoutMajor,
  type SchemaDescription
} from '../../../src/main/lib/shared-library/format'
import { readLibrary, readMeta } from '../../../src/main/lib/shared-library/read'
import {
  cleanup,
  fixture,
  fixtureText,
  manifest,
  schemaFixture
} from '../../helpers/shared-library'

afterEach(cleanup)

const checkedInV = (major: LayoutMajor): SchemaDescription =>
  JSON.parse(fs.readFileSync(schemaFixture(major), 'utf8'))
const checkedIn = (): SchemaDescription => checkedInV(1)

function changed(edit: (d: SchemaDescription) => void, major: LayoutMajor = 1): SchemaDescription {
  const d = structuredClone(describeSchema(major))
  edit(d)
  return d
}

const field = (d: SchemaDescription, path: string) => d.fields.find((f) => f.path === path)!

describe('the version rule, enforced by the schema fingerprint', () => {
  it.each([1, 2] as const)(
    'layout v%i matches its own checked-in fingerprint, schema-v<N>.json',
    (major) => {
      const file = checkedInV(major)
      // The hazard is a v2 description in the v1 file: against a higher major
      // `compareFingerprint` accepts every difference, so this is checked first.
      expect(file.versions.layout.version).toBe(major)
      const verdict = compareFingerprint(file, describeSchema(major))
      console.log(`schema fingerprint v${major}: ${verdict.rule}`)
      expect(verdict.details).toEqual([])
      expect(verdict.ok).toBe(true)
    }
  )

  it('v2 differs from v1 only in its owner, which is never null', () => {
    const shared = (d: SchemaDescription): SchemaDescription['fields'] =>
      d.fields.filter((f) => !f.path.startsWith('manifest.owner'))
    expect(shared(describeSchema(2))).toEqual(shared(describeSchema(1)))
    const owner = (major: LayoutMajor): SchemaDescription['fields'] =>
      describeSchema(major).fields.filter((f) => f.path.startsWith('manifest.owner'))
    expect(owner(1)).toEqual([
      { path: 'manifest.owner', type: 'object|null', required: true },
      { path: 'manifest.owner.shikimoriId', type: 'integer', required: true },
      { path: 'manifest.owner.nickname', type: 'string', required: false }
    ])
    expect(owner(2)).toEqual([
      { path: 'manifest.owner', type: 'object', required: true },
      { path: 'manifest.owner.provider', type: 'string:nonEmpty', required: true },
      { path: 'manifest.owner.userId', type: 'string:nonEmpty', required: true },
      { path: 'manifest.owner.nickname', type: 'string', required: false }
    ])
    expect(describeSchema(2).versions).toEqual({
      layout: { version: 2, minor: LAYOUT_MINORS[2] },
      state: describeSchema(1).versions.state
    })
  })

  it('an optional field added to the v2 owner needs LAYOUT_MINORS[2], and leaves v1 alone', () => {
    const add = (d: SchemaDescription): void => {
      d.fields.push({ path: 'manifest.owner.avatar', type: 'string', required: false })
    }
    expect(compareFingerprint(checkedInV(2), changed(add, 2)).ok).toBe(false)
    expect(
      compareFingerprint(
        checkedInV(2),
        changed((d) => {
          add(d)
          d.versions.layout.minor += 1
        }, 2)
      ).ok
    ).toBe(true)
    expect(compareFingerprint(checkedInV(1), describeSchema(1)).ok).toBe(true)
  })

  it('a v2 description written into the v1 file is caught by the major in its name', () => {
    // Compared as the version rule would, it passes: the major went up.
    expect(compareFingerprint(checkedInV(1), describeSchema(2)).ok).toBe(true)
    expect(describeSchema(2).versions.layout.version).not.toBe(1)
  })

  it('layoutVersionFor: v2 only for a v2-shaped owner, whatever its provider', () => {
    expect(layoutVersionFor(null)).toBe(1)
    expect(layoutVersionFor({ shikimoriId: 5, nickname: 'a' })).toBe(1)
    expect(layoutVersionFor({ provider: 'anilist', userId: '5' })).toBe(2)
    expect(layoutVersionFor({ provider: 'shikimori', userId: '5' })).toBe(2)
  })

  it('carries each field’s path, type, required flag and enum, and the caps', () => {
    const d = describeSchema(1)
    expect(field(d, 'manifest.items[].size')).toEqual({
      path: 'manifest.items[].size',
      type: 'integer>=0',
      required: true
    })
    expect(field(d, 'manifest.mode').enum).toEqual(['videos', 'metadata'])
    expect(field(d, 'state.doc.titles{}.watch{}.position.value.translationId').required).toBe(false)
    expect(d.caps).toEqual({ ...CAPS })
  })

  it('an added optional field fails unless LAYOUT_MINORS[1] was bumped', () => {
    const add = (d: SchemaDescription): void => {
      d.fields.push({ path: 'manifest.items[].container', type: 'string', required: false })
    }
    const verdict = compareFingerprint(checkedIn(), changed(add))
    console.log(`added optional field: ${verdict.rule}`)
    expect(verdict.ok).toBe(false)
    expect(
      compareFingerprint(
        checkedIn(),
        changed((d) => {
          add(d)
          d.versions.layout.minor += 1
        })
      ).ok
    ).toBe(true)
  })

  it('an added optional field in state needs a state minor, not a layout one', () => {
    const add = (d: SchemaDescription): void => {
      d.fields.push({ path: 'state.doc.titles{}.note', type: 'string', required: false })
      d.versions.layout.minor += 1
    }
    expect(compareFingerprint(checkedIn(), changed(add)).ok).toBe(false)
  })

  it('items[].size from number to string fails without bumping the layout major', () => {
    const retype = (d: SchemaDescription): void => {
      field(d, 'manifest.items[].size').type = 'string'
    }
    const verdict = compareFingerprint(checkedIn(), changed(retype))
    console.log(`changed type: ${verdict.rule}`)
    expect(verdict.ok).toBe(false)
    expect(
      compareFingerprint(
        checkedIn(),
        changed((d) => {
          retype(d)
          d.versions.layout.minor += 1
        })
      ).ok
    ).toBe(false)
    expect(
      compareFingerprint(
        checkedIn(),
        changed((d) => {
          retype(d)
          d.versions.layout = { version: 2, minor: 0 }
        })
      ).ok
    ).toBe(true)
  })

  it('making sha256 required fails with only a minor bump', () => {
    const verdict = compareFingerprint(
      checkedIn(),
      changed((d) => {
        field(d, 'manifest.items[].sha256').required = true
        d.versions.layout.minor += 1
      })
    )
    console.log(`made required: ${verdict.rule}`)
    expect(verdict.ok).toBe(false)
  })

  it.each([
    ['state.json 32 MB → 64 MB', 'stateBytes', 64 * 1024 * 1024],
    ['the item cap', 'items', 400_000],
    ['the string cap', 'stringBytes', 4096]
  ])('changing a cap (%s) fails without bumping the major', (_, cap, value) => {
    const raise = (d: SchemaDescription): void => {
      d.caps[cap] = value
    }
    const verdict = compareFingerprint(checkedIn(), changed(raise))
    console.log(`changed cap ${cap}: ${verdict.rule}`)
    expect(verdict.ok).toBe(false)
    expect(
      compareFingerprint(
        checkedIn(),
        changed((d) => {
          raise(d)
          d.versions.layout.minor += 1
          d.versions.state.minor += 1
        })
      ).ok
    ).toBe(false)
    expect(
      compareFingerprint(
        checkedIn(),
        changed((d) => {
          raise(d)
          d.versions.layout = { version: 2, minor: 0 }
          d.versions.state = { version: 2, minor: 0 }
        })
      ).ok
    ).toBe(true)
  })

  it('items[].source (#623) is a minor add: from minor 0 it needs LAYOUT_MINORS[1] 1, not a major', () => {
    const minor0 = changed((d) => {
      d.fields = d.fields.filter((f) => !f.path.startsWith('manifest.items[].source'))
      d.versions.layout.minor = 0
    })
    const verdict = compareFingerprint(minor0, describeSchema(1))
    console.log(`items[].source: ${verdict.rule}`)
    expect(verdict.ok).toBe(true)
    expect(verdict.details).toEqual([
      'added optional manifest.items[].source',
      'added optional manifest.items[].source.size',
      'added optional manifest.items[].source.subtitleSize',
      'added optional manifest.items[].source.codec',
      'added optional manifest.items[].source.outputSize'
    ])
    const unbumped = changed((d) => {
      d.versions.layout.minor = 0
    })
    expect(compareFingerprint(minor0, unbumped).ok).toBe(false)
  })

  it('removing a field or an enum value fails without a major bump', () => {
    const removed = changed((d) => {
      d.fields = d.fields.filter((f) => f.path !== 'manifest.name')
      d.versions.layout.minor += 1
    })
    expect(compareFingerprint(checkedIn(), removed).ok).toBe(false)
    const narrowed = changed((d) => {
      field(d, 'manifest.mode').enum = ['videos']
    })
    expect(compareFingerprint(checkedIn(), narrowed).ok).toBe(false)
  })
})

describe('the SyncDoc doc and title levels stay S4’s', () => {
  it('know exactly KNOWN_DOC_FIELDS and KNOWN_TITLE_FIELDS', () => {
    expect([...DOC_LEVEL_FIELDS].sort()).toEqual([...KNOWN_DOC_FIELDS].sort())
    expect([...TITLE_LEVEL_FIELDS].sort()).toEqual([...KNOWN_TITLE_FIELDS].sort())
  })
})

describe('itemKey', () => {
  it('is animeId:episodeInt:translationId with episodeInt opaque', () => {
    expect(itemKey({ animeId: 101, episodeInt: '12.5', translationId: 9002 })).toBe('101:12.5:9002')
    expect(itemKey({ animeId: 101, episodeInt: '01', translationId: 9 })).toBe('101:01:9')
  })
})

describe('carryUnknown', () => {
  it('keeps a read object’s bag on a rebuilt one, in memory and non-enumerable', async () => {
    const r = await readLibrary(fixture('newer-minor-manifest'))
    const read = (r as Extract<SharedLibraryRead, { status: 'ok' }>).manifest.items[0]
    const rebuilt = { ...read }
    expect(unknownFieldsOf(rebuilt)).toBeUndefined()
    expect(carryUnknown(read, rebuilt)).toBe(rebuilt)
    expect(unknownFieldsOf(rebuilt)).toEqual({ container: 'matroska' })
    expect(Object.keys(rebuilt)).not.toContain('container')
    expect(JSON.stringify(rebuilt)).not.toContain('container')
    const plain = {}
    expect(unknownFieldsOf(carryUnknown({}, plain))).toBeUndefined()
  })
})

describe('meta/<animeId>.json and searchResult', () => {
  it('extra keys are absent from toAnimeSearchResult and present when the meta is serialized back', async () => {
    const r = await readMeta(fixture('golden-metadata'), 101)
    const meta = (r as { meta: SharedLibraryMeta }).meta
    const narrowed = toAnimeSearchResult(meta.searchResult!)
    expect(Object.keys(narrowed).sort()).toEqual(
      [
        'id',
        'title',
        'titles',
        'posterUrlSmall',
        'numberOfEpisodes',
        'type',
        'typeTitle',
        'year',
        'season'
      ].sort()
    )
    expect(narrowed.titles).toEqual({
      ru: 'Фрирен',
      romaji: 'Sousou no Frieren',
      ja: '葬送のフリーレン'
    })
    expect(JSON.stringify(narrowed)).not.toMatch(/rating|studio|zh/)
    expect(serializeMeta(meta)).toBe(fixtureText('golden-metadata', 'meta/101.json'))
  })
})

describe('the serializer emits allow-listed fields plus the bag, and nothing else', () => {
  it('an own token on an object is not emitted', () => {
    const m = manifest(1, null, { mode: 'videos' }) as Record<string, any>
    m.token = 'secret'
    m.items[0].token = 'secret'
    const bytes = JSON.stringify(emit(MANIFEST_SCHEMAS[1], m))
    expect(bytes).not.toContain('token')
  })

  it('a bag holding a forbidden name at a nested level has it stripped', async () => {
    const r = await readMeta(fixture('golden-metadata'), 101)
    const meta = (r as { meta: SharedLibraryMeta }).meta
    setUnknownFields(meta.searchResult!.titles, { token: 'x', shikimoriCredentials: 'y', keep: 1 })
    const bytes = serializeMeta(meta)
    expect(bytes).toContain('"keep": 1')
    expect(bytes).not.toMatch(/token|shikimoriCredentials/)
  })
})
