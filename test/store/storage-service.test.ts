// Pins the in-memory snapshot semantics of the main StorageService: reads are
// served from memory (electron-store's per-get full-file re-parse was the main
// source of main-process stalls on the anime detail page), every read is an
// isolated copy, and writes still land on disk. Runs against the REAL
// electron-store in a temp dir (via the test-only `cwd` injection — with an
// explicit cwd, electron-store never consults `electron.app`).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createStorageService } from '../../src/main/store'

const DEFAULTS = {
  alpha: 1,
  blob: { nested: true } as Record<string, unknown>
}

describe('createStorageService — in-memory snapshot over electron-store', () => {
  let dir: string
  let cfg: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-service-test-'))
    cfg = path.join(dir, 'config.json')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function create(): ReturnType<typeof createStorageService<typeof DEFAULTS>> {
    return createStorageService(DEFAULTS, { cwd: dir })
  }

  function readDisk(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(cfg, 'utf8'))
  }

  it('serves defaults from the startup snapshot', () => {
    const svc = create()
    expect(svc.get('alpha')).toBe(1)
    expect(svc.get('blob')).toEqual({ nested: true })
  })

  it('set → get round-trips and persists to disk', () => {
    const svc = create()
    svc.set('alpha', 42)
    expect(svc.get('alpha')).toBe(42)
    expect(readDisk().alpha).toBe(42)
  })

  it('a new service instance sees previously persisted values', () => {
    create().set('alpha', 9)
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
    expect('extra' in readDisk()).toBe(false)
  })

  it('dot-notation paths bypass the snapshot and re-sync it', () => {
    const svc = create()
    svc.set('blob.nested', false)
    expect(svc.get('blob.nested')).toBe(false)
    expect((svc.get('blob') as { nested: boolean }).nested).toBe(false)
  })
})
