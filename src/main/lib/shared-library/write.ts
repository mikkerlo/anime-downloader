// The Shared Library writer (#573). Nothing in this slice calls `writeState`
// at runtime: S9 (#584) is the first caller.
//
// Every `writeManifest` and `writeState`, in this order:
//   1. re-read the drive through the reader's pair search and run every check
//      (libraryId, the read-only decision, the generation, owner or claim,
//      the takeover rules);
//   2. compute `s₀` (`writeState`), serialize every file the write produces,
//      and check it against every cap (`LibraryTooLargeError`);
//   3. repair a torn pair, manifest side first;
//   4. the atomic write(s).
// Nothing on the drive changes before step 3, so a refused write leaves the
// tree as it was.
//
// The writer carries unknown fields by path itself: it walks what it writes and
// adds the chosen file's unknown fields at every path that file has (by key in
// keyed collections, by `itemKey` for items). Unknown fields the caller's
// objects carry, in a bag or as plain keys, are never written: the output's
// unknown fields are exactly the chosen file's.

import { promises as fsp } from 'fs'
import type { FileHandle } from 'fs/promises'
import * as path from 'path'
import {
  CAPS,
  LAYOUT_MINOR,
  LAYOUT_VERSION,
  MANIFEST_SCHEMA,
  STATE_MINOR,
  STATE_SCHEMA,
  STATE_VERSION,
  copyUnknown,
  isPlainObject,
  keyOf,
  plainUnknownOf,
  put,
  toFileText,
  type RecordNode,
  type SchemaNode
} from './format'
import {
  LIBRARY_DIR,
  MANIFEST,
  MANIFEST_PREV,
  STATE,
  STATE_PREV,
  check,
  inspectLibrary,
  loadFile,
  manifestEnvelopeFailure,
  stateEnvelopeFailure,
  type Inspection,
  type Issue
} from './read'

// --- errors ------------------------------------------------------------------------------

export class SharedLibraryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** No `.anime-dl/manifest.json` (or `.prev`) under the root. */
export class LibraryNotFoundError extends SharedLibraryError {}

/** `createLibrary` on a root that already holds a manifest. */
export class LibraryExistsError extends SharedLibraryError {}

/** The reader decided read-only: a newer major, a file over a cap, or no matching pair. */
export class LibraryReadOnlyError extends SharedLibraryError {
  constructor(
    readonly reason: SharedLibraryReadOnlyReason,
    message: string
  ) {
    super(message)
  }
}

export class LibraryIdMismatchError extends SharedLibraryError {}

/** The drive moved on since the caller's copy was read. */
export class StaleGenerationError extends SharedLibraryError {
  constructor(
    readonly expected: number | null,
    readonly actual: number | null
  ) {
    super(`expected generation ${expected}, the drive has ${actual}`)
  }
}

export class NotOwnerError extends SharedLibraryError {}

/** An `owner` or `mode` change without `{ takeover: true }`. */
export class IdentityChangeError extends SharedLibraryError {}

/** The write would produce a file a v1 reader locks as `'size'`. */
export class LibraryTooLargeError extends SharedLibraryError {}

/** The caller's data fails the v1 schema (other than a cap). */
export class InvalidLibraryDataError extends SharedLibraryError {}

// --- serializing with the drive's unknown fields ------------------------------------------

const isDropped = (node: SchemaNode, raw: unknown): boolean => !check(node, raw, '', []).ok

const keyOverCap = (k: string): boolean => Buffer.byteLength(k, 'utf8') > CAPS.stringBytes

function walkRecord(
  node: RecordNode,
  value: Record<string, unknown>,
  drive: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of node.fields) {
    const onDrive = drive !== undefined && Object.hasOwn(drive, f.name)
    if (Object.hasOwn(value, f.name) && value[f.name] !== undefined) {
      const from = onDrive && f.role !== 'writer' ? drive[f.name] : undefined
      put(out, f.name, walk(f.node, value[f.name], from))
    } else if (onDrive && f.role === undefined && isDropped(f.node, drive[f.name])) {
      // An invalid optional field the reader left out: its raw value goes back.
      put(out, f.name, drive[f.name])
    }
  }
  if (drive) copyUnknown(out, plainUnknownOf(node, drive))
  return out
}

function walkMap(
  entry: SchemaNode,
  value: Record<string, unknown>,
  drive: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const dropped = (k: string): boolean => keyOverCap(k) || isDropped(entry, drive![k])
  const keys = drive
    ? [...Object.keys(drive), ...Object.keys(value).filter((k) => !Object.hasOwn(drive, k))]
    : Object.keys(value)
  for (const k of keys) {
    const onDrive = drive !== undefined && Object.hasOwn(drive, k)
    if (Object.hasOwn(value, k) && value[k] !== undefined) {
      put(out, k, walk(entry, value[k], onDrive && !dropped(k) ? drive[k] : undefined))
    } else if (onDrive && dropped(k)) {
      // A dropped entry goes back at its key.
      put(out, k, drive[k])
    }
  }
  return out
}

function walkArray(
  node: Extract<SchemaNode, { kind: 'array' }>,
  value: unknown[],
  drive: unknown[] | undefined
): unknown[] {
  const byKey = new Map<string, unknown>()
  const carried: [number, unknown][] = []
  drive?.forEach((e, i) => {
    if (isDropped(node.element, e)) carried.push([i, e])
    else {
      const k = keyOf(node.key, e)
      if (k !== undefined && !byKey.has(k)) byKey.set(k, e)
    }
  })
  const out = value.map((e) => {
    const k = keyOf(node.key, e)
    return walk(node.element, e, k === undefined ? undefined : byKey.get(k))
  })
  const nextKeys = new Set(value.map((e) => keyOf(node.key, e)))
  for (const [i, raw] of carried) {
    const k = keyOf(node.key, raw)
    if (k !== undefined && nextKeys.has(k)) continue
    // A dropped entry goes back at its index (at the end when the array is shorter).
    out.splice(Math.min(i, out.length), 0, raw)
  }
  return out
}

/**
 * `value` as the schema allows it, with the drive's copy (`drive`, from the
 * chosen file) supplying the unknown fields at the same path, the dropped
 * entries and the raw values of invalid optional fields.
 */
function walk(node: SchemaNode, value: unknown, drive: unknown): unknown {
  switch (node.kind) {
    case 'nullable':
      return value === null ? null : walk(node.of, value, drive)
    case 'record':
      return walkRecord(
        node,
        value as Record<string, unknown>,
        isPlainObject(drive) ? drive : undefined
      )
    case 'map':
      return walkMap(
        node.entry,
        value as Record<string, unknown>,
        isPlainObject(drive) ? drive : undefined
      )
    case 'array':
      return walkArray(node, value as unknown[], Array.isArray(drive) ? drive : undefined)
    default:
      return value
  }
}

/** Checks the caller's data, then serializes it with the drive's carry. */
function serialize(
  schema: RecordNode,
  value: Record<string, unknown>,
  drive: Record<string, unknown> | undefined,
  what: 'manifest' | 'state'
): { out: Record<string, unknown>; text: string } {
  const issues: Issue[] = []
  const c = check(schema, value, what, issues)
  if (!c.ok) issues.push({ path: what, kind: c.kind })
  const bad = issues.find((i) => i.kind === 'type')
  if (bad) throw new InvalidLibraryDataError(`${bad.path} fails the v1 schema`)
  if (issues.length > 0) {
    throw new LibraryTooLargeError(`${issues[0].path} is over ${CAPS.stringBytes} bytes`)
  }
  const out = walk(schema, value, drive) as Record<string, unknown>
  const failure = what === 'manifest' ? manifestEnvelopeFailure(out) : stateEnvelopeFailure(out)
  if (failure !== null) throw new InvalidLibraryDataError(`${what} envelope: ${failure}`)
  if (what === 'manifest' && (out.items as unknown[]).length > CAPS.items) {
    throw new LibraryTooLargeError(`more than ${CAPS.items} items`)
  }
  const text = toFileText(out)
  const cap = what === 'manifest' ? CAPS.manifestBytes : CAPS.stateBytes
  if (Buffer.byteLength(text, 'utf8') > cap) {
    throw new LibraryTooLargeError(`${what}.json would be over ${cap} bytes`)
  }
  return { out, text }
}

// --- the filesystem sequence ------------------------------------------------------------------

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

// Some filesystems and mounts can't fsync a directory; the rename has landed by then.
const UNSYNCABLE_DIR = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF', 'EACCES'])

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  let fh: FileHandle
  try {
    fh = await fsp.open(dir, 'r')
  } catch (err) {
    if (UNSYNCABLE_DIR.has(errno(err) ?? '')) return
    throw err
  }
  try {
    await fh.sync()
  } catch (err) {
    if (!UNSYNCABLE_DIR.has(errno(err) ?? '')) throw err
  } finally {
    await fh.close()
  }
}

async function unlinkQuiet(file: string): Promise<void> {
  try {
    await fsp.unlink(file)
  } catch (err) {
    if (errno(err) !== 'ENOENT') throw err
  }
}

/**
 * `X.tmp` + fsync, delete `X.prev`, `X` → `X.prev`, `X.tmp` → `X`, fsync the
 * directory. Never renames onto an existing target (FAT32/exFAT, antivirus).
 */
async function atomicWrite(
  dir: string,
  name: string,
  prevName: string,
  text: string
): Promise<void> {
  const file = path.join(dir, name)
  const tmp = `${file}.tmp`
  const fh = await fsp.open(tmp, 'w')
  try {
    await fh.writeFile(text, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  const prev = path.join(dir, prevName)
  await unlinkQuiet(prev)
  try {
    await fsp.rename(file, prev)
  } catch (err) {
    if (errno(err) !== 'ENOENT') throw err
  }
  await fsp.rename(tmp, file)
  await fsyncDir(dir)
}

/**
 * Restores the chosen `.prev` halves as the current files, manifest side
 * first: with the state side first, an unpaired `manifest.json` would sit next
 * to the restored `state.json` with no `state.prev` to fall back to. Every
 * step leaves a tree that reads as the same pair.
 */
async function repairTornPair(insp: Inspection): Promise<void> {
  const at = (name: string): string => path.join(insp.dir, name)
  if (insp.manifest?.file === MANIFEST_PREV) {
    await unlinkQuiet(at(MANIFEST))
    await fsp.rename(at(MANIFEST_PREV), at(MANIFEST))
    await fsyncDir(insp.dir)
  }
  if (insp.state?.file === STATE_PREV) {
    await unlinkQuiet(at(STATE))
    await fsp.rename(at(STATE_PREV), at(STATE))
    await fsyncDir(insp.dir)
  }
}

/**
 * `s₀`: the highest state `generation` in any readable state file (orphans
 * and other libraries' included) and `stateGeneration` in any readable
 * manifest file, or 0. Read before anything on the drive changes.
 */
async function stateGenerationFloor(insp: Inspection): Promise<number> {
  let s0 = 0
  const sources: [string, string, number][] = [
    [MANIFEST, 'stateGeneration', CAPS.manifestBytes],
    [MANIFEST_PREV, 'stateGeneration', CAPS.manifestBytes],
    [STATE, 'generation', CAPS.stateBytes],
    [STATE_PREV, 'generation', CAPS.stateBytes]
  ]
  for (const [name, fieldName, cap] of sources) {
    const l = insp.loaded.get(name) ?? (await loadFile(path.join(insp.dir, name), cap))
    if (l.status !== 'ok' || !isPlainObject(l.raw)) continue
    const g = l.raw[fieldName]
    if (Number.isSafeInteger(g) && (g as number) > s0) s0 = g as number
  }
  return s0
}

// --- checks -------------------------------------------------------------------------------------

/** The re-read and the checks every write shares. Changes nothing. */
async function reread(
  root: string,
  libraryId: string | null
): Promise<Inspection & { manifest: NonNullable<Inspection['manifest']> }> {
  const insp = await inspectLibrary(root)
  const r = insp.result
  if (r.status === 'none') throw new LibraryNotFoundError(`no Shared Library at ${root}`)
  const listed = r.manifest
  if (libraryId !== null && listed && listed.libraryId !== libraryId) {
    throw new LibraryIdMismatchError(
      `the drive holds library ${listed.libraryId}, not ${libraryId}`
    )
  }
  if (r.status === 'read-only') throw new LibraryReadOnlyError(r.reason, r.message)
  return insp as Inspection & { manifest: NonNullable<Inspection['manifest']> }
}

function ownsOrClaims(m: SharedLibraryManifest, actor: SharedLibraryActor): boolean {
  if (m.mode !== 'metadata' || m.owner === null) return false
  if (actor.shikimoriUserId !== null && actor.shikimoriUserId === m.owner.shikimoriId) return true
  return (
    actor.claim !== null &&
    actor.claim.libraryId === m.libraryId &&
    actor.claim.ownerId === m.owner.shikimoriId
  )
}

function writerOf(actor: SharedLibraryActor): SharedLibraryWriter {
  return { installId: actor.installId, appVersion: actor.appVersion, at: Date.now() }
}

function manifestFields(
  input: SharedLibraryManifestInput,
  over: {
    layoutMinor: number
    generation: number
    stateGeneration: number | null
    lastWriter: SharedLibraryWriter
  }
): Record<string, unknown> {
  return {
    layoutVersion: LAYOUT_VERSION,
    layoutMinor: over.layoutMinor,
    libraryId: input.libraryId,
    name: input.name,
    owner: input.owner,
    mode: input.mode,
    generation: over.generation,
    stateGeneration: over.stateGeneration,
    lastWriter: over.lastWriter,
    titles: input.titles,
    items: input.items,
    naming: input.naming
  }
}

// --- the writers ------------------------------------------------------------------------------

/**
 * Writes the first manifest of a new library: `mode: 'videos'` with no owner,
 * or `mode: 'metadata'` owned by the logged-in actor with `stateGeneration:
 * null` (step 1 of the first-write table).
 */
export async function createLibrary(
  root: string,
  manifest: SharedLibraryManifestInput,
  actor: SharedLibraryActor
): Promise<{ generation: number }> {
  const dir = path.join(root, LIBRARY_DIR)
  for (const name of [MANIFEST, MANIFEST_PREV]) {
    const l = await fsp.lstat(path.join(dir, name)).catch((err) => {
      if (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR') return null
      throw err
    })
    if (l) throw new LibraryExistsError(`${path.join(dir, name)} already exists`)
  }
  if (manifest.mode === 'metadata') {
    if (actor.shikimoriUserId === null || manifest.owner?.shikimoriId !== actor.shikimoriUserId) {
      throw new NotOwnerError('a With metadata library is owned by the logged-in actor')
    }
  } else if (manifest.owner !== null) {
    throw new InvalidLibraryDataError('a Videos only library has no owner')
  }
  const generation = 1
  const { text } = serialize(
    MANIFEST_SCHEMA,
    manifestFields(manifest, {
      layoutMinor: LAYOUT_MINOR,
      generation,
      stateGeneration: null,
      lastWriter: writerOf(actor)
    }),
    undefined,
    'manifest'
  )
  await fsp.mkdir(dir, { recursive: true })
  await atomicWrite(dir, MANIFEST, MANIFEST_PREV, text)
  return { generation }
}

/**
 * A manifest-only write. Anyone may add items to a library with no owner; a
 * `metadata` library needs its owner or a matching claim. `owner` and `mode`
 * change only through `{ takeover: true }` on a library with no owner.
 */
export async function writeManifest(
  root: string,
  next: SharedLibraryManifestInput,
  actor: SharedLibraryActor,
  expectedGeneration: number,
  options: { takeover?: boolean } = {}
): Promise<{ generation: number; stateGeneration: number | null }> {
  const insp = await reread(root, next.libraryId)
  const m = insp.manifest.value
  if (expectedGeneration !== m.generation) {
    throw new StaleGenerationError(expectedGeneration, m.generation)
  }
  let stateGeneration = m.stateGeneration
  if (options.takeover) {
    if (m.owner !== null) throw new NotOwnerError('only a library with no owner can be taken over')
    if (actor.shikimoriUserId === null)
      throw new NotOwnerError('a takeover needs a logged-in actor')
    if (next.mode !== 'metadata' || next.owner?.shikimoriId !== actor.shikimoriUserId) {
      throw new IdentityChangeError(
        'a takeover makes the actor the owner of a With metadata library'
      )
    }
    stateGeneration = null
  } else {
    if (m.mode === 'metadata' && !ownsOrClaims(m, actor)) {
      throw new NotOwnerError('only the owner or a matching claim writes this library')
    }
    if (
      next.mode !== m.mode ||
      (next.owner?.shikimoriId ?? null) !== (m.owner?.shikimoriId ?? null)
    ) {
      throw new IdentityChangeError('owner and mode change only through a takeover')
    }
  }
  const generation = m.generation + 1
  const { text } = serialize(
    MANIFEST_SCHEMA,
    manifestFields(next, {
      layoutMinor: Math.max(LAYOUT_MINOR, m.layoutMinor),
      generation,
      stateGeneration,
      lastWriter: writerOf(actor)
    }),
    insp.manifest.raw,
    'manifest'
  )
  if (insp.result.status === 'ok' && insp.result.torn) await repairTornPair(insp)
  await atomicWrite(insp.dir, MANIFEST, MANIFEST_PREV, text)
  return { generation, stateGeneration }
}

/**
 * Writes `doc` as the library's state, then the manifest that pairs with it.
 * Needs a `metadata` library and its owner or a matching claim. The state
 * takes `s₀ + 1`, above every state generation on the drive.
 */
export async function writeState(
  root: string,
  doc: SharedSyncDoc,
  actor: SharedLibraryActor,
  expectedStateGeneration: number | null
): Promise<{ generation: number; stateGeneration: number }> {
  const insp = await reread(root, null)
  const m = insp.manifest.value
  if (expectedStateGeneration !== m.stateGeneration) {
    throw new StaleGenerationError(expectedStateGeneration, m.stateGeneration)
  }
  if (!ownsOrClaims(m, actor)) {
    throw new NotOwnerError('only the owner or a matching claim writes state')
  }
  const s0 = await stateGenerationFloor(insp)
  const stateGeneration = s0 + 1
  const generation = m.generation + 1
  const stateMinor = Math.max(STATE_MINOR, insp.state?.value.stateMinor ?? STATE_MINOR)
  const state = serialize(
    STATE_SCHEMA,
    {
      stateVersion: STATE_VERSION,
      stateMinor,
      libraryId: m.libraryId,
      generation: stateGeneration,
      manifestGeneration: generation,
      doc: { ...doc, stateVersion: STATE_VERSION, stateMinor }
    },
    insp.state?.raw,
    'state'
  )
  const manifest = serialize(
    MANIFEST_SCHEMA,
    manifestFields(m, {
      layoutMinor: Math.max(LAYOUT_MINOR, m.layoutMinor),
      generation,
      stateGeneration,
      lastWriter: writerOf(actor)
    }),
    insp.manifest.raw,
    'manifest'
  )
  if (insp.result.status === 'ok' && insp.result.torn) await repairTornPair(insp)
  if (m.stateGeneration === null) {
    // Orphans are replaced, not rotated: as `state.prev.json` a newer-major or
    // over-cap orphan would stop being ignored and open the library read-only.
    await unlinkQuiet(path.join(insp.dir, STATE_PREV))
    await unlinkQuiet(path.join(insp.dir, STATE))
  }
  await atomicWrite(insp.dir, STATE, STATE_PREV, state.text)
  await atomicWrite(insp.dir, MANIFEST, MANIFEST_PREV, manifest.text)
  return { generation, stateGeneration }
}
