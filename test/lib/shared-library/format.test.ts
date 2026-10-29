// The Shared Library format (#573): the version rule enforced by the schema
// fingerprint, the unknown-field bag, `itemKey` and `searchResult`'s narrowing.
import * as fs from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { KNOWN_DOC_FIELDS, KNOWN_TITLE_FIELDS } from '../../../src/main/lib/sync-state/project'
import {
  CAPS,
  DOC_LEVEL_FIELDS,
  MANIFEST_SCHEMA,
  TITLE_LEVEL_FIELDS,
  carryUnknown,
  compareFingerprint,
  describeSchema,
  emit,
  itemKey,
  serializeMeta,
  setUnknownFields,
  toAnimeSearchResult,
  unknownFieldsOf,
  type SchemaDescription
} from '../../../src/main/lib/shared-library/format'
import { readLibrary, readMeta } from '../../../src/main/lib/shared-library/read'
import {
  SCHEMA_FIXTURE,
  cleanup,
  fixture,
  fixtureText,
  manifest
} from '../../helpers/shared-library'

afterEach(cleanup)

const checkedIn = (): SchemaDescription => JSON.parse(fs.readFileSync(SCHEMA_FIXTURE, 'utf8'))

function changed(edit: (d: SchemaDescription) => void): SchemaDescription {
  const d = structuredClone(describeSchema())
  edit(d)
  return d
}

const field = (d: SchemaDescription, path: string) => d.fields.find((f) => f.path === path)!

describe('the version rule, enforced by the schema fingerprint', () => {
  it('the current schema matches the checked-in fingerprint', () => {
    const verdict = compareFingerprint(checkedIn(), describeSchema())
    console.log(`schema fingerprint: ${verdict.rule}`)
    expect(verdict.details).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('carries each field’s path, type, required flag and enum, and the caps', () => {
    const d = describeSchema()
    expect(field(d, 'manifest.items[].size')).toEqual({
      path: 'manifest.items[].size',
      type: 'integer>=0',
      required: true
    })
    expect(field(d, 'manifest.mode').enum).toEqual(['videos', 'metadata'])
    expect(field(d, 'state.doc.titles{}.watch{}.position.value.translationId').required).toBe(false)
    expect(d.caps).toEqual({ ...CAPS })
  })

  it('an added optional field fails unless LAYOUT_MINOR was bumped', () => {
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

  it('items[].size from number to string fails without bumping LAYOUT_VERSION', () => {
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

  it('items[].source (#623) is a minor add: from minor 0 it needs LAYOUT_MINOR 1, not a major', () => {
    const minor0 = changed((d) => {
      d.fields = d.fields.filter((f) => !f.path.startsWith('manifest.items[].source'))
      d.versions.layout.minor = 0
    })
    const verdict = compareFingerprint(minor0, describeSchema())
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
    const bytes = JSON.stringify(emit(MANIFEST_SCHEMA, m))
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
