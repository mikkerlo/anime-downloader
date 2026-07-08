// Pins the in-memory snapshot semantics of the main StorageService: reads are
// served from memory (electron-store's per-get full-file re-parse was the main
// source of main-process stalls on the anime detail page), every read is an
// isolated copy, and writes coalesce into one debounced disk write per
// PERSIST_DEBOUNCE_MS window (issue #204 — a synchronous full-file write per
// `set` stalled playback every watch-progress save). Runs against the REAL
// electron-store in a temp dir (via the test-only `cwd` injection — with an
// explicit cwd, electron-store never consults `electron.app`).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Store from 'electron-store'
import { createStorageService, PERSIST_DEBOUNCE_MS } from '../../src/main/store'

/**
 * Counts disk persists. The service writes the file by assigning the `store`
 * accessor on Conf's prototype (electron-store's base class) — `atomically`
 * writes via fd+rename, so spying `fs.writeFileSync` would see nothing.
 */
function persistSpy(): ReturnType<typeof vi.spyOn> {
  let proto: object | null = Store.prototype
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'store')) {
    proto = Object.getPrototypeOf(proto)
  }
  return vi.spyOn(proto as { store: unknown }, 'store', 'set')
}

const DEFAULTS = {
  alpha: 1,
  blob: { nested: true } as Record<string, unknown>
}

describe('createStorageService — in-memory snapshot over electron-store', () => {
  let dir: string
  let cfg: string

  beforeEach(() => {
    vi.useFakeTimers()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-service-test-'))
    cfg = path.join(dir, 'config.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function create(options?: {
    writeThroughKeys?: readonly string[]
  }): ReturnType<typeof createStorageService<typeof DEFAULTS>> {
    return createStorageService(DEFAULTS, { cwd: dir, ...options })
  }

  function readDisk(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(cfg, 'utf8'))
  }

  it('serves defaults from the startup snapshot', () => {
    const svc = create()
    expect(svc.get('alpha')).toBe(1)
    expect(svc.get('blob')).toEqual({ nested: true })
  })

  it('set → get round-trips immediately; disk lands after the coalescing window', () => {
    const svc = create()
    svc.set('alpha', 42)
    expect(svc.get('alpha')).toBe(42) // read-your-writes during the window
    expect(readDisk().alpha).toBe(1) // disk still pre-write
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(readDisk().alpha).toBe(42)
  })

  it('a write burst coalesces into one disk write with the final values', () => {
    // watchProgressSave-shaped regression: N sets in one window must not
    // produce N full-file writes.
    const svc = create()
    const writeSpy = persistSpy()
    for (let i = 0; i < 10; i++) {
      svc.set('alpha', i)
      svc.set('blob', { tick: i })
    }
    expect(writeSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(readDisk()).toMatchObject({ alpha: 9, blob: { tick: 9 } })
  })

  it('the window does not extend under a continuous writer (bounded staleness)', () => {
    const svc = create()
    svc.set('alpha', 1)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS - 100)
    svc.set('alpha', 2) // second write inside the window must not re-arm it
    vi.advanceTimersByTime(100)
    expect(readDisk().alpha).toBe(2)
  })

  it('flush() persists pending writes immediately and disarms the timer', () => {
    const svc = create()
    const writeSpy = persistSpy()
    svc.set('alpha', 7)
    svc.flush()
    expect(readDisk().alpha).toBe(7)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS * 2)
    expect(writeSpy).toHaveBeenCalledTimes(1) // no second write from a stale timer
  })

  it('flush() with nothing pending writes nothing', () => {
    const svc = create()
    const writeSpy = persistSpy()
    svc.flush()
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('writeThroughKeys persist synchronously, carrying pending writes along', () => {
    const svc = create({ writeThroughKeys: ['blob'] })
    svc.set('alpha', 5) // debounced
    svc.set('blob', { critical: true }) // write-through
    expect(readDisk()).toMatchObject({ alpha: 5, blob: { critical: true } })
  })

  it('a new service instance sees previously flushed values', () => {
    const first = create()
    first.set('alpha', 9)
    first.flush()
    expect(create().get('alpha')).toBe(9)
  })

  it('get returns an isolated copy — mutating the result cannot corrupt later reads', () => {
    const svc = create()
    svc.set('blob', { arr: [1] })
    const first = svc.get('blob') as { arr: number[] }
    first.arr.push(999)
    expect((svc.get('blob') as { arr: number[] }).arr).toEqual([1])
  })

  it('set stores a copy — mutating the passed object afterwards is not visible', () => {
    const svc = create()
    const value: Record<string, unknown> = { nested: false }
    svc.set('blob', value)
    value.nested = true
    expect((svc.get('blob') as { nested: boolean }).nested).toBe(false)
  })

  it('reads come from memory: an external file edit after startup is not observed', () => {
    // Single-writer semantics by design — the main process owns the file, so
    // the snapshot is authoritative and gets never re-parse the file.
    const svc = create()
    svc.set('alpha', 5)
    fs.writeFileSync(cfg, JSON.stringify({ alpha: 777 }))
    expect(svc.get('alpha')).toBe(5)
  })

  it('has/delete operate on the snapshot and persist the removal', () => {
    const svc = create()
    svc.set('extra', 'x')
    expect(svc.has('extra')).toBe(true)
    svc.delete('extra')
    expect(svc.has('extra')).toBe(false)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect('extra' in readDisk()).toBe(false)
  })

  it('dot-notation writes apply to the snapshot and persist debounced', () => {
    const svc = create()
    svc.set('blob.nested', false)
    expect(svc.get('blob.nested')).toBe(false)
    expect((svc.get('blob') as { nested: boolean }).nested).toBe(false)
    expect(svc.has('blob.nested')).toBe(true)
    expect(svc.has('blob.missing')).toBe(false)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect((readDisk().blob as { nested: boolean }).nested).toBe(false)
  })

  it('dot-notation writes create missing intermediates (dot-prop semantics)', () => {
    const svc = create()
    svc.set('blob.deep.leaf', 1)
    expect(svc.get('blob.deep.leaf')).toBe(1)
    svc.set('alpha.forced', 2) // non-object intermediate is replaced
    expect(svc.get('alpha')).toEqual({ forced: 2 })
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(readDisk()).toMatchObject({ blob: { deep: { leaf: 1 } }, alpha: { forced: 2 } })
  })

  it('dot-notation set stores a copy — later mutation of the argument is not visible', () => {
    const svc = create()
    const entry: Record<string, unknown> = { height: 720 }
    svc.set('blob.entry', entry)
    entry.height = 1080
    expect((svc.get('blob.entry') as { height: number }).height).toBe(720)
  })

  it('dot-notation delete removes the leaf and persists debounced', () => {
    const svc = create()
    svc.set('blob.nested', false)
    svc.delete('blob.nested')
    expect(svc.has('blob.nested')).toBe(false)
    svc.delete('blob.missing.path') // no-op, must not throw
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(readDisk().blob).toEqual({})
  })

  it('dot-notation sub-key reads clone only the addressed leaf, isolated from later reads', () => {
    const svc = create()
    svc.set('blob', { entry: { arr: [1] } })
    const leaf = svc.get('blob.entry') as { arr: number[] }
    leaf.arr.push(999)
    expect((svc.get('blob.entry') as { arr: number[] }).arr).toEqual([1])
  })

  it('set(key, undefined) throws like electron-store (JSON would drop the key on persist)', () => {
    const svc = create()
    expect(() => svc.set('alpha', undefined)).toThrow(TypeError)
    expect(() => svc.set('alpha', undefined)).toThrow('Use `delete()` to clear values')
    expect(svc.get('alpha')).toBe(1) // untouched
  })
})
