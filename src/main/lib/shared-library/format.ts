// The Shared Library on-drive format v1 (#573): constants, the v1 schema as
// data, the unknown-field bag and the serializer. Pure: no `fs`.
//
// The serializer emits each object's allow-listed known fields, then its
// unknown fields, and nothing else. Unknown fields live in a non-enumerable,
// symbol-keyed bag, except at the `SyncDoc` doc and title levels, where S4
// (#572)'s plain-key carry is the mechanism (`applySyncDoc` reads them with
// `Object.entries`, which a symbol key never reaches). The forbidden names are
// stripped wherever unknown fields are copied, by `copyUnknown`.

import { STATE_MINOR, STATE_VERSION } from '../sync-state/project'

export { STATE_MINOR, STATE_VERSION }

export const LAYOUT_VERSION = 1 as const
export const LAYOUT_MINOR = 1 as const
export const NAMING_RULE = 'v1' as const

/**
 * Raising any of these is a major bump: an older reader would otherwise drop a
 * newer writer's data on write-back. The `.prev` copies share their file's cap.
 */
export const CAPS = {
  manifestBytes: 32 * 1024 * 1024,
  stateBytes: 32 * 1024 * 1024,
  metaBytes: 1024 * 1024,
  stringBytes: 2048,
  items: 200_000
} as const

/** Never on the drive, at any level, whatever object carries them. */
export const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'token',
  'shikimoriCredentials',
  'syncplayPassword'
])

export const READ_ONLY_MESSAGES: Record<SharedLibraryReadOnlyReason, string> = {
  version: 'This library was written by a newer version of the app. Update the app to change it.',
  size: 'This library is larger than this version can open',
  interrupted:
    'This library was interrupted while being written. Plug it into the PC that last wrote it.'
}

// --- schema as data ------------------------------------------------------------

export type StringFormat = 'uuid' | 'path' | 'sha256' | 'nonEmpty'

/** How an array's elements are matched across a read and a write. */
export type ArrayKey = 'itemKey' | 'animeId' | 'id' | 'episodeInt' | 'self'

export type SchemaNode =
  | { kind: 'string'; format?: StringFormat; enum?: readonly string[] }
  | { kind: 'integer'; min?: number }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'true' }
  | { kind: 'nullable'; of: SchemaNode }
  | RecordNode
  // A keyed collection: entries are matched, dropped and carried by key.
  | { kind: 'map'; entry: SchemaNode }
  | { kind: 'array'; element: SchemaNode; key: ArrayKey }

/**
 * A record: fixed known fields. `unknown` says where its unknown fields live.
 * A field's `role`: `'envelope'` fields decide whether a whole file is valid,
 * `'writer'` fields are set by the writer on every write. Neither is ever
 * written back raw.
 */
export interface RecordNode {
  kind: 'record'
  fields: readonly SchemaField[]
  unknown: 'bag' | 'plain'
}

export interface SchemaField {
  name: string
  node: SchemaNode
  required: boolean
  role?: 'envelope' | 'writer'
}

const str = (format?: StringFormat): SchemaNode =>
  format ? { kind: 'string', format } : { kind: 'string' }
const oneOf = (...values: string[]): SchemaNode => ({ kind: 'string', enum: values })
const int = (min?: number): SchemaNode =>
  min === undefined ? { kind: 'integer' } : { kind: 'integer', min }
const num: SchemaNode = { kind: 'number' }
const nullable = (of: SchemaNode): SchemaNode => ({ kind: 'nullable', of })
const map = (entry: SchemaNode): SchemaNode => ({ kind: 'map', entry })
const array = (element: SchemaNode, key: ArrayKey): SchemaNode => ({ kind: 'array', element, key })
const record = (fields: SchemaField[], unknown: 'bag' | 'plain' = 'bag'): RecordNode => ({
  kind: 'record',
  fields,
  unknown
})
const req = (name: string, node: SchemaNode, role?: SchemaField['role']): SchemaField =>
  role ? { name, node, required: true, role } : { name, node, required: true }
const opt = (name: string, node: SchemaNode, role?: SchemaField['role']): SchemaField =>
  role ? { name, node, required: false, role } : { name, node, required: false }

const OWNER = record([req('shikimoriId', int()), opt('nickname', str())])

const LAST_WRITER = record([req('installId', str()), req('appVersion', str()), req('at', num)])

const TITLE = record([req('animeId', int(1)), req('name', str())])

const ITEM = record([
  req('animeId', int(1)),
  req('episodeInt', str('nonEmpty')),
  req('translationId', int(1)),
  req('translationType', str()),
  req('author', str()),
  req('quality', int(0)),
  req('path', str('path')),
  opt('subtitlePath', str('path')),
  req('size', int(0)),
  opt('sha256', str('sha256')),
  // Minor 1 (#623): the pair an export merged into this `.mkv`.
  opt(
    'source',
    record([
      req('size', int(0)),
      req('subtitleSize', int(0)),
      req('codec', str()),
      req('outputSize', int(0))
    ])
  )
])

const NAMING = record([req('rule', oneOf(NAMING_RULE)), req('renamed', array(str(), 'self'))])

export const MANIFEST_SCHEMA: RecordNode = record([
  req('layoutVersion', int(), 'envelope'),
  req('layoutMinor', int(0), 'envelope'),
  req('libraryId', str('uuid'), 'envelope'),
  opt('name', str()),
  req('owner', nullable(OWNER), 'envelope'),
  req('mode', oneOf('videos', 'metadata'), 'envelope'),
  req('generation', int(), 'writer'),
  req('stateGeneration', nullable(int()), 'writer'),
  opt('lastWriter', LAST_WRITER, 'writer'),
  req('titles', array(TITLE, 'animeId'), 'envelope'),
  req('items', array(ITEM, 'itemKey'), 'envelope'),
  opt('naming', NAMING)
])

const field = (value: SchemaNode): RecordNode =>
  record([req('value', value), req('at', num), req('origin', str())])

const TOMBSTONE = record([req('deleted', { kind: 'true' }), req('at', num), req('origin', str())])

const RANGE = record([req('startSec', num), req('endSec', num), req('pairCount', num)])

const SKIP_EPISODE = record([
  req('file', record([req('translationId', int()), req('fileSize', int(0))])),
  req('episodeLabel', str()),
  req('durationSec', num),
  req('hashesPerSec', num),
  req('op', nullable(RANGE)),
  req('ed', nullable(RANGE))
])

const SKIP = record([
  req(
    'algorithm',
    record([
      req('source', oneOf('local')),
      req('sampleRate', num),
      req('matchBitThreshold', num),
      req('minRunSec', num),
      req('windowSec', num),
      req('refineBitThreshold', num),
      req('refineSustainHashes', num)
    ])
  ),
  req('analyzedAt', num),
  req('episodeCount', int(0)),
  req('perEpisode', map(SKIP_EPISODE))
])

const WATCH_ENTRY = record([
  req(
    'position',
    field(record([req('position', num), req('duration', num), opt('translationId', int())]))
  ),
  req('watched', field({ kind: 'boolean' })),
  req('watchedAt', nullable(num))
])

const RATE = record([
  req('malId', int()),
  req('episodes', field(num)),
  req('status', field(str())),
  req('score', field(num)),
  req('rewatches', field(num))
])

// `KNOWN_TITLE_FIELDS`, in `SyncTitleState` order. Plain-key carry: no bag.
const TITLE_STATE = record(
  [
    opt('watch', map(WATCH_ENTRY)),
    opt('starred', field({ kind: 'true' })),
    opt('priority', field({ kind: 'true' })),
    opt('rate', RATE),
    opt('dismissed', array(str(), 'self')),
    opt('skip', SKIP)
  ],
  'plain'
)

// `KNOWN_DOC_FIELDS`, in `projectSyncDoc` order. Plain-key carry: no bag.
const DOC = record(
  [
    req('stateVersion', int(), 'writer'),
    req('stateMinor', int(0), 'writer'),
    opt('installId', str()),
    opt('titles', map(TITLE_STATE)),
    opt('priorityOrder', field(array(str(), 'self'))),
    opt('tombstones', map(record([opt('starred', TOMBSTONE), opt('priority', TOMBSTONE)])))
  ],
  'plain'
)

export const STATE_SCHEMA: RecordNode = record([
  req('stateVersion', int(), 'envelope'),
  req('stateMinor', int(0), 'envelope'),
  req('libraryId', str('uuid'), 'envelope'),
  req('generation', int(), 'writer'),
  req('manifestGeneration', int(), 'writer'),
  req('doc', DOC, 'envelope')
])

/** `AnimeSearchResult`'s fields (`src/shared/types/anime.d.ts`). */
export const SEARCH_RESULT_SCHEMA: RecordNode = record([
  req('id', int()),
  req('title', str()),
  req('titles', record([opt('ru', str()), opt('romaji', str()), opt('ja', str())])),
  req('posterUrlSmall', str()),
  req('numberOfEpisodes', int(0)),
  req('type', str()),
  req('typeTitle', str()),
  req('year', int()),
  req('season', str())
])

export const META_SCHEMA: RecordNode = record([
  req('animeId', int(1)),
  opt('malId', nullable(int())),
  opt(
    'titles',
    record([opt('ru', str()), opt('romaji', str()), opt('ja', str()), opt('en', str())])
  ),
  opt('genres', array(record([req('id', int()), req('title', str())]), 'id')),
  opt('year', int()),
  opt('type', str()),
  opt(
    'episodes',
    array(record([req('episodeInt', str('nonEmpty')), opt('episodeFull', str())]), 'episodeInt')
  ),
  opt('searchResult', SEARCH_RESULT_SCHEMA)
])

/** The doc and title levels' known fields, which must stay S4's `KNOWN_*` sets. */
export const DOC_LEVEL_FIELDS = DOC.fields.map((f) => f.name)
export const TITLE_LEVEL_FIELDS = TITLE_STATE.fields.map((f) => f.name)

// --- the schema fingerprint ----------------------------------------------------

export interface FieldDescription {
  path: string
  type: string
  required: boolean
  enum?: string[]
}

export interface SchemaDescription {
  versions: {
    layout: { version: number; minor: number }
    state: { version: number; minor: number }
  }
  caps: Record<string, number>
  fields: FieldDescription[]
}

function typeOf(node: SchemaNode): string {
  switch (node.kind) {
    case 'string':
      return node.format ? `string:${node.format}` : 'string'
    case 'integer':
      return node.min === undefined ? 'integer' : `integer>=${node.min}`
    case 'nullable':
      return `${typeOf(node.of)}|null`
    case 'record':
      return 'object'
    case 'map':
      return 'map'
    case 'array':
      return `array:${node.key}`
    default:
      return node.kind
  }
}

function describeNode(node: SchemaNode, path: string, out: FieldDescription[]): void {
  switch (node.kind) {
    case 'nullable':
      return describeNode(node.of, path, out)
    case 'record':
      for (const f of node.fields) {
        const p = `${path}.${f.name}`
        const d: FieldDescription = { path: p, type: typeOf(f.node), required: f.required }
        const inner = f.node.kind === 'nullable' ? f.node.of : f.node
        if (inner.kind === 'string' && inner.enum) d.enum = [...inner.enum]
        out.push(d)
        describeNode(f.node, p, out)
      }
      return
    case 'map':
      return describeNode(node.entry, `${path}{}`, out)
    case 'array':
      return describeNode(node.element, `${path}[]`, out)
  }
}

/** The v1 format as data: every field's path, type, required flag and enum, plus the caps. */
export function describeSchema(): SchemaDescription {
  const fields: FieldDescription[] = []
  describeNode(MANIFEST_SCHEMA, 'manifest', fields)
  describeNode(STATE_SCHEMA, 'state', fields)
  describeNode(META_SCHEMA, 'meta', fields)
  return {
    versions: {
      layout: { version: LAYOUT_VERSION, minor: LAYOUT_MINOR },
      state: { version: STATE_VERSION, minor: STATE_MINOR }
    },
    caps: { ...CAPS },
    fields
  }
}

// Which version pair covers a field or a cap.
const SCOPE_OF_FILE: Record<string, 'layout' | 'state'> = {
  manifest: 'layout',
  meta: 'layout',
  state: 'state'
}
const SCOPES_OF_CAP: Record<string, ('layout' | 'state')[]> = {
  manifestBytes: ['layout'],
  metaBytes: ['layout'],
  items: ['layout'],
  stateBytes: ['state'],
  stringBytes: ['layout', 'state']
}

export interface FingerprintVerdict {
  ok: boolean
  rule: string
  details: string[]
}

/**
 * The version rule, applied to a change of the schema: an added optional field
 * needs a minor bump; anything else, a cap change included, needs a major one.
 */
export function compareFingerprint(
  before: SchemaDescription,
  after: SchemaDescription
): FingerprintVerdict {
  const details: string[] = []
  const rules: string[] = []
  let ok = true
  const old = new Map(before.fields.map((f) => [f.path, f]))
  const cur = new Map(after.fields.map((f) => [f.path, f]))
  const added = after.fields.filter((f) => !old.has(f.path))
  const addedPaths = new Set(added.map((f) => f.path))
  const parentOf = (path: string): string => path.replace(/(\[\]|\{\})?\.[^.]+$/, '')
  for (const scope of ['layout', 'state'] as const) {
    const inScope = (path: string): boolean => SCOPE_OF_FILE[path.split('.')[0]] === scope
    const minorAdds = added.filter(
      (f) => inScope(f.path) && (!f.required || addedPaths.has(parentOf(f.path)))
    )
    const majorChanges: string[] = []
    for (const f of added) {
      if (inScope(f.path) && !minorAdds.includes(f)) majorChanges.push(`added required ${f.path}`)
    }
    for (const f of before.fields) {
      if (!inScope(f.path)) continue
      const now = cur.get(f.path)
      if (!now) majorChanges.push(`removed ${f.path}`)
      else if (
        now.type !== f.type ||
        now.required !== f.required ||
        JSON.stringify(now.enum ?? null) !== JSON.stringify(f.enum ?? null)
      ) {
        majorChanges.push(`changed ${f.path}`)
      }
    }
    for (const cap of new Set([...Object.keys(before.caps), ...Object.keys(after.caps)])) {
      if (before.caps[cap] === after.caps[cap]) continue
      if ((SCOPES_OF_CAP[cap] ?? ['layout', 'state']).includes(scope)) {
        majorChanges.push(`changed cap ${cap}`)
      }
    }
    const was = before.versions[scope]
    const is = after.versions[scope]
    const majorBumped = is.version > was.version
    const minorBumped = is.version === was.version && is.minor > was.minor
    details.push(...majorChanges, ...minorAdds.map((f) => `added optional ${f.path}`))
    if (majorChanges.length > 0) {
      rules.push(`${scope}: a change other than an added optional field needs a major bump`)
      if (!majorBumped) ok = false
    } else if (minorAdds.length > 0) {
      rules.push(`${scope}: an added optional field needs a minor bump`)
      if (!majorBumped && !minorBumped) ok = false
    } else {
      rules.push(`${scope}: unchanged`)
    }
  }
  return { ok, rule: rules.join('; '), details }
}

// --- unknown fields --------------------------------------------------------------

/** The bag holding an object's unknown fields: non-enumerable and symbol-keyed. */
export const UNKNOWN_FIELDS: unique symbol = Symbol('shared-library.unknown-fields')

type Bag = Record<string, unknown>

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Sets an own enumerable data property, even for a key like `__proto__`. */
export function put(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

export function unknownFieldsOf(obj: object): Readonly<Bag> | undefined {
  return (obj as { [UNKNOWN_FIELDS]?: Bag })[UNKNOWN_FIELDS]
}

export function setUnknownFields(obj: object, bag: Readonly<Bag>): void {
  const copy: Bag = Object.create(null)
  for (const k of Object.keys(bag)) copy[k] = bag[k]
  Object.defineProperty(obj, UNKNOWN_FIELDS, {
    value: copy,
    enumerable: false,
    writable: true,
    configurable: true
  })
}

/**
 * `to`, with `from`'s bag. For code that rebuilds a read object in memory and
 * wants it to keep its unknown fields. The writers of `manifest.json` and
 * `state.json` carry unknown fields by path themselves; `meta/<animeId>.json`
 * has no such walk, so S6a (#574)'s meta merge must call this.
 */
export function carryUnknown<T extends object>(from: object, to: T): T {
  const bag = unknownFieldsOf(from)
  if (bag) setUnknownFields(to, bag)
  return to
}

/** Copies `src`'s fields into `out`, minus the forbidden names. The one place they are stripped. */
export function copyUnknown(out: object, src: Readonly<Bag> | undefined): void {
  if (!src) return
  for (const k of Object.keys(src)) {
    if (!FORBIDDEN_FIELDS.has(k)) put(out, k, src[k])
  }
}

/** A plain-key record's own enumerable keys that `node` doesn't know. */
export function plainUnknownOf(node: RecordNode, value: Record<string, unknown>): Bag {
  const known = new Set(node.fields.map((f) => f.name))
  const out: Bag = Object.create(null)
  for (const k of Object.keys(value)) if (!known.has(k)) out[k] = value[k]
  return out
}

// --- keys ---------------------------------------------------------------------------

/** An item's identity: `animeId:episodeInt:translationId`, `episodeInt` opaque. */
export function itemKey(item: {
  animeId: number | string
  episodeInt: string | number
  translationId: number | string
}): string {
  return `${item.animeId}:${item.episodeInt}:${item.translationId}`
}

const isKeyPart = (v: unknown): v is string | number =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v !== '')

/** An array element's key, or undefined when it has none (it is then carried forever). */
export function keyOf(key: ArrayKey, raw: unknown): string | undefined {
  if (key === 'self') return typeof raw === 'string' ? raw : undefined
  if (!isPlainObject(raw)) return undefined
  if (key === 'itemKey') {
    const { animeId, episodeInt, translationId } = raw
    return isKeyPart(animeId) && isKeyPart(episodeInt) && isKeyPart(translationId)
      ? itemKey({ animeId, episodeInt, translationId })
      : undefined
  }
  const v = raw[key]
  return isKeyPart(v) ? String(v) : undefined
}

// --- serializing --------------------------------------------------------------------

/** The bytes of a file: two-space JSON and a final newline. */
export function toFileText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * `value` as `node` allows it: known fields in schema order, then the bag (or
 * the plain unknown keys, at the doc and title levels). Nothing else.
 */
export function emit(node: SchemaNode, value: unknown): unknown {
  switch (node.kind) {
    case 'nullable':
      return value === null ? null : emit(node.of, value)
    case 'record': {
      const src = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const f of node.fields) {
        if (Object.hasOwn(src, f.name) && src[f.name] !== undefined) {
          put(out, f.name, emit(f.node, src[f.name]))
        }
      }
      copyUnknown(out, node.unknown === 'plain' ? plainUnknownOf(node, src) : unknownFieldsOf(src))
      return out
    }
    case 'map': {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        put(out, k, emit(node.entry, v))
      }
      return out
    }
    case 'array':
      return (value as unknown[]).map((e) => emit(node.element, e))
    default:
      return value
  }
}

/** `meta/<animeId>.json`'s bytes. It has no writer walk: what the bag holds is what is kept. */
export function serializeMeta(meta: SharedLibraryMeta): string {
  return toFileText(emit(META_SCHEMA, meta))
}

/** The value `ApplyDeps.sharedSearchResult` returns: only `AnimeSearchResult`'s fields. */
export function toAnimeSearchResult(searchResult: AnimeSearchResult): AnimeSearchResult {
  const titles: AnimeSearchResult['titles'] = {}
  for (const k of ['ru', 'romaji', 'ja'] as const) {
    if (searchResult.titles[k] !== undefined) titles[k] = searchResult.titles[k]
  }
  return {
    id: searchResult.id,
    title: searchResult.title,
    titles,
    posterUrlSmall: searchResult.posterUrlSmall,
    numberOfEpisodes: searchResult.numberOfEpisodes,
    type: searchResult.type,
    typeTitle: searchResult.typeTitle,
    year: searchResult.year,
    season: searchResult.season
  }
}
