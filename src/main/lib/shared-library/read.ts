// The Shared Library reader (#573). Everything on the drive is untrusted: it
// comes from another PC or another person.
//
// - Only an envelope failure makes a file invalid. A bad entry is dropped from
//   what the reader returns (the writer carries it back), and a bad optional
//   field is left out (the writer writes its raw value back).
// - A newer major, or a file over a cap, opens the library read-only *before*
//   the pair search, with no `.prev` fallback, so the writer's repair never
//   deletes a file the reader did not prove unpaired.
// - Every file is `stat`ed before it is parsed.

import { promises as fsp } from 'fs'
import * as path from 'path'
import {
  CAPS,
  FORBIDDEN_FIELDS,
  LAYOUT_VERSION,
  META_SCHEMA,
  MANIFEST_SCHEMA,
  READ_ONLY_MESSAGES,
  STATE_SCHEMA,
  STATE_VERSION,
  isPlainObject,
  put,
  setUnknownFields,
  type RecordNode,
  type SchemaNode
} from './format'
import { isSafeRelativePath } from './paths'

export const LIBRARY_DIR = '.anime-dl'

// --- validation ----------------------------------------------------------------------

/** Why a value was dropped or left out. `'string'` is the string cap. */
export type Issue = { path: string; kind: 'type' | 'string' }

type Checked = { ok: true; value: unknown } | { ok: false; kind: Issue['kind'] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/

const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8')

function checkString(node: Extract<SchemaNode, { kind: 'string' }>, raw: unknown): Checked {
  if (typeof raw !== 'string') return { ok: false, kind: 'type' }
  if (utf8(raw) > CAPS.stringBytes) return { ok: false, kind: 'string' }
  if (node.enum && !node.enum.includes(raw)) return { ok: false, kind: 'type' }
  switch (node.format) {
    case 'uuid':
      if (!UUID.test(raw)) return { ok: false, kind: 'type' }
      break
    case 'sha256':
      if (!SHA256.test(raw)) return { ok: false, kind: 'type' }
      break
    case 'path':
      if (!isSafeRelativePath(raw)) return { ok: false, kind: 'type' }
      break
    case 'nonEmpty':
      if (raw === '') return { ok: false, kind: 'type' }
      break
  }
  return { ok: true, value: raw }
}

/**
 * `raw` checked against `node`. Records keep their unknown fields (in the bag,
 * or as plain keys at the doc and title levels) minus the forbidden names.
 * Entries of maps and arrays that fail are dropped; an optional record field
 * that fails is left out; a required one fails its record. Every drop is
 * reported to `issues`.
 */
export function check(node: SchemaNode, raw: unknown, at: string, issues: Issue[]): Checked {
  switch (node.kind) {
    case 'string':
      return checkString(node, raw)
    case 'integer':
      return Number.isSafeInteger(raw) && (node.min === undefined || (raw as number) >= node.min)
        ? { ok: true, value: raw }
        : { ok: false, kind: 'type' }
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw)
        ? { ok: true, value: raw }
        : { ok: false, kind: 'type' }
    case 'boolean':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, kind: 'type' }
    case 'true':
      return raw === true ? { ok: true, value: raw } : { ok: false, kind: 'type' }
    case 'nullable':
      return raw === null ? { ok: true, value: null } : check(node.of, raw, at, issues)
    case 'record':
      return checkRecord(node, raw, at, issues)
    case 'map': {
      if (!isPlainObject(raw)) return { ok: false, kind: 'type' }
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(raw)) {
        const where = `${at}.${k}`
        const c: Checked =
          utf8(k) > CAPS.stringBytes
            ? { ok: false, kind: 'string' }
            : check(node.entry, raw[k], where, issues)
        if (c.ok) put(out, k, c.value)
        else issues.push({ path: where, kind: c.kind })
      }
      return { ok: true, value: out }
    }
    case 'array': {
      if (!Array.isArray(raw)) return { ok: false, kind: 'type' }
      const out: unknown[] = []
      raw.forEach((e, i) => {
        const c = check(node.element, e, `${at}[${i}]`, issues)
        if (c.ok) out.push(c.value)
        else issues.push({ path: `${at}[${i}]`, kind: c.kind })
      })
      return { ok: true, value: out }
    }
  }
}

function checkRecord(node: RecordNode, raw: unknown, at: string, issues: Issue[]): Checked {
  if (!isPlainObject(raw)) return { ok: false, kind: 'type' }
  const out: Record<string, unknown> = {}
  const known = new Set<string>()
  for (const f of node.fields) {
    known.add(f.name)
    if (!Object.hasOwn(raw, f.name) || raw[f.name] === undefined) {
      if (f.required) return { ok: false, kind: 'type' }
      continue
    }
    const where = `${at}.${f.name}`
    const c = check(f.node, raw[f.name], where, issues)
    if (c.ok) put(out, f.name, c.value)
    else if (f.required) return c
    else issues.push({ path: where, kind: c.kind })
  }
  const bag: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if (known.has(k) || FORBIDDEN_FIELDS.has(k)) continue
    if (node.unknown === 'plain') put(out, k, raw[k])
    else put(bag, k, raw[k])
  }
  if (Object.keys(bag).length > 0) setUnknownFields(out, bag)
  return { ok: true, value: out }
}

// --- files -----------------------------------------------------------------------------

export type Loaded =
  | { status: 'missing' }
  | { status: 'size' }
  | { status: 'unparseable' }
  | { status: 'ok'; raw: unknown }

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

/** `stat` only: whether `file` exists, and whether it is over `cap`. Never reads it. */
async function statFile(file: string, cap: number): Promise<'missing' | 'size' | 'present'> {
  try {
    const st = await fsp.stat(file)
    if (!st.isFile()) return 'present'
    return st.size > cap ? 'size' : 'present'
  } catch (err) {
    if (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR') return 'missing'
    throw err
  }
}

/** Reads and parses `file`, after a `stat` that keeps an over-cap file unread. */
export async function loadFile(file: string, cap: number): Promise<Loaded> {
  const st = await statFile(file, cap)
  if (st !== 'present') return { status: st }
  return parseFile(file, cap)
}

async function parseFile(file: string, cap: number): Promise<Loaded> {
  let buf: Buffer
  try {
    buf = await fsp.readFile(file)
  } catch (err) {
    if (errno(err) === 'ENOENT') return { status: 'missing' }
    if (errno(err) === 'EISDIR') return { status: 'unparseable' }
    throw err
  }
  if (buf.length > cap) return { status: 'size' }
  try {
    return { status: 'ok', raw: JSON.parse(buf.toString('utf8')) }
  } catch {
    return { status: 'unparseable' }
  }
}

// --- envelopes -----------------------------------------------------------------------

const isInt = (v: unknown): v is number => Number.isSafeInteger(v)

export type Classified<T> =
  | { kind: 'missing' }
  | { kind: 'size' }
  | { kind: 'newer' }
  | { kind: 'invalid' }
  | { kind: 'valid'; raw: Record<string, unknown>; value: T; issues: Issue[] }

/** A manifest file's envelope; `null` when it holds, otherwise why not. */
export function manifestEnvelopeFailure(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'not an object'
  if (raw.layoutVersion !== LAYOUT_VERSION) return 'layoutVersion'
  if (!isInt(raw.layoutMinor) || raw.layoutMinor < 0) return 'layoutMinor'
  if (typeof raw.libraryId !== 'string' || !UUID.test(raw.libraryId)) return 'libraryId'
  if (!isInt(raw.generation)) return 'generation'
  if (raw.stateGeneration !== null && !isInt(raw.stateGeneration)) return 'stateGeneration'
  if (raw.mode !== 'videos' && raw.mode !== 'metadata') return 'mode'
  const owner = raw.owner
  if (raw.mode === 'videos' ? owner !== null : !isPlainObject(owner) || !isInt(owner.shikimoriId)) {
    return 'owner'
  }
  if (!Array.isArray(raw.items)) return 'items'
  if (!Array.isArray(raw.titles)) return 'titles'
  return null
}

/** A state file's envelope; `null` when it holds, otherwise why not. */
export function stateEnvelopeFailure(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'not an object'
  if (raw.stateVersion !== STATE_VERSION) return 'stateVersion'
  if (!isInt(raw.stateMinor) || raw.stateMinor < 0) return 'stateMinor'
  if (typeof raw.libraryId !== 'string' || !UUID.test(raw.libraryId)) return 'libraryId'
  if (!isInt(raw.generation)) return 'generation'
  if (!isInt(raw.manifestGeneration)) return 'manifestGeneration'
  if (!isPlainObject(raw.doc)) return 'doc'
  if (raw.doc.stateVersion !== raw.stateVersion || raw.doc.stateMinor !== raw.stateMinor) {
    return 'doc version'
  }
  return null
}

const isNewer = (v: unknown, known: number): boolean => isInt(v) && v > known

function classify<T>(
  loaded: Loaded,
  versionField: string,
  known: number,
  failure: (raw: unknown) => string | null,
  schema: RecordNode,
  overItems: (raw: Record<string, unknown>) => boolean
): Classified<T> {
  if (loaded.status === 'missing' || loaded.status === 'size') return { kind: loaded.status }
  if (loaded.status !== 'ok' || !isPlainObject(loaded.raw)) return { kind: 'invalid' }
  const raw = loaded.raw
  if (overItems(raw)) return { kind: 'size' }
  if (isNewer(raw[versionField], known)) return { kind: 'newer' }
  if (failure(raw) !== null) return { kind: 'invalid' }
  const issues: Issue[] = []
  const c = check(schema, raw, versionField === 'layoutVersion' ? 'manifest' : 'state', issues)
  if (!c.ok) return { kind: 'invalid' }
  return { kind: 'valid', raw, value: c.value as T, issues }
}

const manifestOverItems = (raw: Record<string, unknown>): boolean =>
  Array.isArray(raw.items) && raw.items.length > CAPS.items

export function classifyManifest(loaded: Loaded): Classified<SharedLibraryManifest> {
  return classify(
    loaded,
    'layoutVersion',
    LAYOUT_VERSION,
    manifestEnvelopeFailure,
    MANIFEST_SCHEMA,
    manifestOverItems
  )
}

export function classifyState(loaded: Loaded): Classified<SharedLibraryState> {
  return classify(
    loaded,
    'stateVersion',
    STATE_VERSION,
    stateEnvelopeFailure,
    STATE_SCHEMA,
    () => false
  )
}

/** One manifest file, `stat`ed, parsed and validated on its own. */
export async function readManifest(file: string): Promise<Classified<SharedLibraryManifest>> {
  return classifyManifest(await loadFile(file, CAPS.manifestBytes))
}

/** One state file, `stat`ed, parsed and validated on its own. */
export async function readState(file: string): Promise<Classified<SharedLibraryState>> {
  return classifyState(await loadFile(file, CAPS.stateBytes))
}

/** `meta/<animeId>.json`. Its unknown fields, `searchResult`'s included, are in the bags. */
export async function readMeta(root: string, animeId: number): Promise<SharedLibraryMetaRead> {
  if (!Number.isSafeInteger(animeId) || animeId < 1) return { status: 'invalid' }
  const loaded = await loadFile(
    path.join(root, LIBRARY_DIR, 'meta', `${animeId}.json`),
    CAPS.metaBytes
  )
  if (loaded.status === 'missing' || loaded.status === 'size') return { status: loaded.status }
  if (loaded.status !== 'ok') return { status: 'invalid' }
  const c = check(META_SCHEMA, loaded.raw, 'meta', [])
  if (!c.ok || (c.value as SharedLibraryMeta).animeId !== animeId) return { status: 'invalid' }
  return { status: 'ok', meta: c.value as SharedLibraryMeta }
}

// --- the pair search -------------------------------------------------------------------

export const MANIFEST = 'manifest.json'
export const MANIFEST_PREV = 'manifest.prev.json'
export const STATE = 'state.json'
export const STATE_PREV = 'state.prev.json'

type ManifestFile = typeof MANIFEST | typeof MANIFEST_PREV
type StateFile = typeof STATE | typeof STATE_PREV

export interface ChosenManifest {
  file: ManifestFile
  raw: Record<string, unknown>
  value: SharedLibraryManifest
}

export interface ChosenState {
  file: StateFile
  raw: Record<string, unknown>
  value: SharedLibraryState
}

/** What the writer needs beyond `readLibrary`'s result: the files the pair came from. */
export interface Inspection {
  dir: string
  result: SharedLibraryRead
  manifest: ChosenManifest | null
  state: ChosenState | null
  // The files the search parsed, by name, so `s₀` doesn't read them twice.
  loaded: Map<string, Loaded>
}

/**
 * The pair rule. `stateGeneration` is exact: every state write takes a
 * generation above everything on the drive, so it names one state write. The
 * back-reference is `<=`, a sanity bound only: a manifest-only write raises
 * `manifest.generation` without touching state. Don't tighten it to `===`.
 */
function pairs(m: SharedLibraryManifest, s: ChosenState | null): s is ChosenState {
  if (!s) return false
  return (
    s.value.libraryId === m.libraryId &&
    m.stateGeneration === s.value.generation &&
    s.value.manifestGeneration <= m.generation
  )
}

/** The pair search, with the files it chose. `readLibrary` is its public face. */
export async function inspectLibrary(root: string): Promise<Inspection> {
  const dir = path.join(root, LIBRARY_DIR)
  const at = (name: string): string => path.join(dir, name)
  const loaded = new Map<string, Loaded>()
  const readOnly = (
    reason: SharedLibraryReadOnlyReason,
    manifest: ChosenManifest | null
  ): Inspection => ({
    dir,
    result: {
      status: 'read-only',
      reason,
      message: READ_ONLY_MESSAGES[reason],
      manifest: manifest?.value ?? null
    },
    manifest: null,
    state: null,
    loaded
  })
  const load = async (st: 'missing' | 'size' | 'present', name: string, cap: number) => {
    const l: Loaded = st === 'present' ? await parseFile(at(name), cap) : { status: st }
    loaded.set(name, l)
    return l
  }

  // Step 0: `stat` both manifests, then read the ones under the cap.
  const mStat = await statFile(at(MANIFEST), CAPS.manifestBytes)
  const pStat = await statFile(at(MANIFEST_PREV), CAPS.manifestBytes)
  if (mStat === 'missing' && pStat === 'missing') {
    return { dir, result: { status: 'none' }, manifest: null, state: null, loaded }
  }
  const m = classifyManifest(await load(mStat, MANIFEST, CAPS.manifestBytes))
  const p = classifyManifest(await load(pStat, MANIFEST_PREV, CAPS.manifestBytes))
  const chosen = (
    c: Classified<SharedLibraryManifest>,
    file: ManifestFile
  ): ChosenManifest | null => (c.kind === 'valid' ? { file, raw: c.raw, value: c.value } : null)
  // The manifest still worth listing on a read-only open: never past an over-cap or newer `manifest.json`.
  const listable =
    m.kind === 'valid'
      ? chosen(m, MANIFEST)
      : m.kind === 'missing' || m.kind === 'invalid'
        ? chosen(p, MANIFEST_PREV)
        : null
  if (m.kind === 'size' || p.kind === 'size') return readOnly('size', listable)
  if (m.kind === 'newer' || p.kind === 'newer') return readOnly('version', listable)

  // Step 1: the manifest, `manifest.prev` when `manifest.json` is missing or invalid.
  const first = chosen(m, MANIFEST) ?? chosen(p, MANIFEST_PREV)
  if (!first) return readOnly('interrupted', null)
  const prev = first.file === MANIFEST ? chosen(p, MANIFEST_PREV) : null

  const ok = (man: ChosenManifest, st: ChosenState | null): Inspection => ({
    dir,
    result: {
      status: 'ok',
      manifest: man.value,
      mode: man.value.mode,
      state: st?.value ?? null,
      stateInitialized: st !== null,
      torn: man.file !== MANIFEST || (st !== null && st.file !== STATE),
      pair: { manifest: man.file, state: st?.file ?? null }
    },
    manifest: man,
    state: st,
    loaded
  })

  // Step 2: a manifest with no state pairs with none; any state file is an orphan.
  if (first.value.stateGeneration === null) return ok(first, null)

  // Step 3: `stat` both states, then their versions, then match.
  const sStat = await statFile(at(STATE), CAPS.stateBytes)
  const spStat = await statFile(at(STATE_PREV), CAPS.stateBytes)
  if (sStat === 'size' || spStat === 'size') return readOnly('size', first)
  const s = classifyState(await load(sStat, STATE, CAPS.stateBytes))
  const sp = classifyState(await load(spStat, STATE_PREV, CAPS.stateBytes))
  if (s.kind === 'size' || sp.kind === 'size') return readOnly('size', first)
  if (s.kind === 'newer' || sp.kind === 'newer') return readOnly('version', first)
  const current: ChosenState | null =
    s.kind === 'valid' ? { file: STATE, raw: s.raw, value: s.value } : null
  const previous: ChosenState | null =
    sp.kind === 'valid' ? { file: STATE_PREV, raw: sp.raw, value: sp.value } : null
  if (pairs(first.value, current)) return ok(first, current)
  if (pairs(first.value, previous)) return ok(first, previous)

  // Step 4: `manifest.prev`, which pairs with no state when its `stateGeneration` is null.
  if (prev) {
    if (prev.value.stateGeneration === null) return ok(prev, null)
    if (pairs(prev.value, previous)) return ok(prev, previous)
  }

  // Step 5.
  return readOnly('interrupted', first)
}

/**
 * Reads the library at `root`: the manifest and state pair, after the version
 * and size checks that come before the pair search. Never calls `realpath`.
 */
export async function readLibrary(root: string): Promise<SharedLibraryRead> {
  return (await inspectLibrary(root)).result
}
