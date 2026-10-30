// #648: a `config.json` that doesn't parse used to throw out of
// `createStorageService` during main-module evaluation, so the app never
// opened a window. A leading UTF-8 BOM now just loads; real corruption is moved
// aside (never deleted or overwritten) and the store opens from
// `config.backup.json` or the defaults, with a notice. Runs against the real
// electron-store in a temp dir, like `storage-service.test.ts`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createStorageService } from '../../src/main/store'
import {
  ConfigUnrecoverableError,
  moveAside,
  unreadableConfigMessage
} from '../../src/main/store/config-recovery'
import { useTempStoreDir } from '../helpers/temp-store-dir'

const DEFAULTS = {
  alpha: 1,
  blob: { nested: true } as Record<string, unknown>
}

const TRUNCATED = '{"alpha":7,"blob":{"nes'
const BOM = String.fromCharCode(0xfeff)

describe('createStorageService — an unparseable config.json (#648)', () => {
  const tmp = useTempStoreDir()
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const create = (): ReturnType<typeof createStorageService<typeof DEFAULTS>> =>
    createStorageService(DEFAULTS, { cwd: tmp.dir })
  const backup = (): string => path.join(tmp.dir, 'config.backup.json')
  const corruptFiles = (): string[] =>
    fs
      .readdirSync(tmp.dir)
      .filter((f) => f.includes('.corrupt-'))
      .sort()
  const parsesAsObject = (file: string): boolean => {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return v !== null && typeof v === 'object' && !Array.isArray(v)
  }

  it('case 1: a BOM-prefixed file loads with its values, no notice, no corrupt copy', () => {
    fs.writeFileSync(tmp.cfg, BOM + '{"alpha":7}')
    expect(fs.readFileSync(tmp.cfg).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    const svc = create()

    expect(svc.get('alpha')).toBe(7)
    expect(svc.startupNotice).toBeNull()
    expect(corruptFiles()).toEqual([])
    svc.set('alpha', 8)
    svc.flush()
    expect(fs.readFileSync(tmp.cfg)[0]).toBe('{'.charCodeAt(0))
  })

  it('case 2: truncated, no backup: defaults, the original kept byte-identical, config-reset', () => {
    fs.writeFileSync(tmp.cfg, TRUNCATED)
    const svc = create()

    expect(svc.get('alpha')).toBe(1)
    expect(svc.get('blob')).toEqual({ nested: true })
    const corrupt = corruptFiles()
    expect(corrupt).toHaveLength(1)
    expect(corrupt[0]).toMatch(/^config\.corrupt-\d{8}-\d{6}\.json$/)
    const corruptPath = path.join(tmp.dir, corrupt[0])
    expect(fs.readFileSync(corruptPath, 'utf8')).toBe(TRUNCATED)
    expect(parsesAsObject(tmp.cfg)).toBe(true)
    expect(svc.startupNotice).toEqual({ kind: 'config-reset', corruptPath })
  })

  it('case 3: truncated, with a valid backup: the backup is served, its mtime is the notice date', () => {
    fs.writeFileSync(backup(), JSON.stringify({ alpha: 5, blob: { fromBackup: true } }))
    const savedAt = new Date('2026-01-02T03:04:05Z')
    fs.utimesSync(backup(), savedAt, savedAt)
    const recordedMtime = fs.statSync(backup()).mtimeMs
    fs.writeFileSync(tmp.cfg, TRUNCATED)
    const svc = create()

    expect(svc.get('alpha')).toBe(5)
    expect(svc.get('blob')).toEqual({ fromBackup: true })
    const corrupt = corruptFiles()
    expect(corrupt).toHaveLength(1)
    expect(svc.startupNotice).toEqual({
      kind: 'config-restored',
      corruptPath: path.join(tmp.dir, corrupt[0]),
      backupSavedAt: recordedMtime
    })
    expect(recordedMtime).toBe(savedAt.getTime())
    expect(JSON.parse(fs.readFileSync(tmp.cfg, 'utf8'))).toEqual({
      alpha: 5,
      blob: { fromBackup: true }
    })
  })

  it('case 4: a clean start writes the last-known-good copy', () => {
    fs.writeFileSync(tmp.cfg, JSON.stringify({ alpha: 3 }))
    const svc = create()

    expect(fs.existsSync(backup())).toBe(true)
    expect(JSON.parse(fs.readFileSync(backup(), 'utf8'))).toEqual({
      alpha: svc.get('alpha'),
      blob: svc.get('blob')
    })
    expect(svc.get('alpha')).toBe(3)
    expect(svc.startupNotice).toBeNull()
  })

  it('case 5: a non-object root is corruption, and merges no "0"/"1" keys', () => {
    fs.writeFileSync(tmp.cfg, '[1,2]')
    const svc = create()

    expect(svc.has('0')).toBe(false)
    expect(svc.has('1')).toBe(false)
    const corrupt = corruptFiles()
    expect(corrupt).toHaveLength(1)
    expect(fs.readFileSync(path.join(tmp.dir, corrupt[0]), 'utf8')).toBe('[1,2]')
    expect(svc.startupNotice).toEqual({
      kind: 'config-reset',
      corruptPath: path.join(tmp.dir, corrupt[0])
    })
  })

  it('case 6: config and backup both corrupt: two distinct files, each byte-identical, config-reset', () => {
    const badBackup = '{"alpha":2,"bl'
    fs.writeFileSync(backup(), badBackup)
    fs.writeFileSync(tmp.cfg, TRUNCATED)
    const svc = create()

    expect(svc.get('alpha')).toBe(1)
    const corrupt = corruptFiles()
    expect(corrupt).toHaveLength(2)
    const cfgCopy = corrupt.find((f) => f.startsWith('config.corrupt-'))!
    const backupCopy = corrupt.find((f) => f.startsWith('config.backup.corrupt-'))!
    expect(cfgCopy).toBeDefined()
    expect(backupCopy).toBeDefined()
    expect(fs.readFileSync(path.join(tmp.dir, cfgCopy), 'utf8')).toBe(TRUNCATED)
    expect(fs.readFileSync(path.join(tmp.dir, backupCopy), 'utf8')).toBe(badBackup)
    expect(svc.startupNotice).toEqual({
      kind: 'config-reset',
      corruptPath: path.join(tmp.dir, cfgCopy)
    })
    // The defaults that replaced the unusable backup are the new last-known-good.
    expect(parsesAsObject(backup())).toBe(true)
  })

  it('a corrupt backup that cannot be moved aside is left in place, not overwritten', () => {
    const badBackup = '{"alpha":2,"bl'
    fs.writeFileSync(backup(), badBackup)
    fs.writeFileSync(tmp.cfg, TRUNCATED)
    const rename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from === backup()) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      rename(from, to)
    })
    const svc = create()

    expect(svc.get('alpha')).toBe(1)
    expect(svc.startupNotice?.kind).toBe('config-reset')
    expect(fs.readFileSync(backup(), 'utf8')).toBe(badBackup)
  })

  it('moveAside never overwrites: a taken name gets a -1, then -2 suffix', () => {
    const now = new Date(2026, 9, 31, 12, 0, 0)
    const contents = ['first', 'second', 'third']
    const moved = contents.map((text) => {
      fs.writeFileSync(tmp.cfg, text)
      return moveAside(tmp.cfg, now)
    })

    expect(moved.map((p) => path.basename(p))).toEqual([
      'config.corrupt-20261031-120000.json',
      'config.corrupt-20261031-120000-1.json',
      'config.corrupt-20261031-120000-2.json'
    ])
    expect(moved.map((p) => fs.readFileSync(p, 'utf8'))).toEqual(contents)
    expect(fs.existsSync(tmp.cfg)).toBe(false)
  })

  it('case 7: the move-aside fails: ConfigUnrecoverableError naming the path, config.json untouched', () => {
    fs.writeFileSync(tmp.cfg, TRUNCATED)
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    })

    let thrown: unknown
    try {
      create()
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ConfigUnrecoverableError)
    expect((thrown as ConfigUnrecoverableError).configPath).toBe(tmp.cfg)
    expect((thrown as Error).message).toContain(tmp.cfg)
    expect(fs.readFileSync(tmp.cfg, 'utf8')).toBe(TRUNCATED)
    expect(corruptFiles()).toEqual([])
  })

  it('a failing last-known-good write is logged, never fatal', () => {
    // A non-empty directory where the backup goes: the rename onto it fails,
    // the way an AV lock on config.backup.json does on Windows.
    fs.mkdirSync(path.join(backup(), 'locked'), { recursive: true })
    fs.writeFileSync(tmp.cfg, JSON.stringify({ alpha: 4 }))
    const svc = create()

    expect(svc.get('alpha')).toBe(4)
    expect(svc.startupNotice).toBeNull()
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('last-known-good'),
      expect.anything()
    )
    expect(fs.existsSync(`${backup()}.tmp`)).toBe(false)
  })
})

describe('unreadableConfigMessage — the fatal box text (#648)', () => {
  it('names the file the move-aside could not touch and its reason', () => {
    const err = new ConfigUnrecoverableError('/p/config.json', new Error('EPERM: denied'))
    expect(unreadableConfigMessage(err, '/other')).toBe(
      "Anime DL can't read its settings file (/p/config.json): EPERM: denied. " +
        'Move or fix the file, then start Anime DL again.'
    )
  })

  it('names <dir>/config.json for any other read failure', () => {
    const err = new Error('EISDIR: illegal operation on a directory, read')
    expect(unreadableConfigMessage(err, '/u')).toContain(
      `(${path.join('/u', 'config.json')}): EISDIR: illegal operation on a directory, read.`
    )
  })
})
