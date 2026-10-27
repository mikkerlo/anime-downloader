// SyncBaseStore (#572 §5): one base per party under userData/sync-bases/,
// written atomically (temp file, then rename).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  createSyncBaseStore,
  isSyncBaseParty,
  type SyncBaseFs
} from '../../../src/main/lib/sync-state/bases'

function doc(installId: string): SyncDoc {
  return {
    stateVersion: 1,
    stateMinor: 0,
    installId,
    titles: {},
    priorityOrder: { value: [], at: 0, origin: 'legacy' },
    tombstones: {}
  }
}

const realFs: SyncBaseFs = {
  readFile: (p, e) => fsp.readFile(p, e),
  writeFile: (p, d, e) => fsp.writeFile(p, d, e),
  rename: (a, b) => fsp.rename(a, b),
  mkdir: (p, o) => fsp.mkdir(p, o),
  rm: (p, o) => fsp.rm(p, o)
}

describe('SyncBaseStore', () => {
  let userData: string
  let dir: string

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-bases-'))
    dir = path.join(userData, 'sync-bases')
  })
  afterEach(() => fs.rmSync(userData, { recursive: true, force: true }))

  it('writes and reads back a base per party, and a missing one reads as null', async () => {
    const bases = createSyncBaseStore(dir, realFs)
    expect(await bases.read('library-abc')).toBeNull()
    await bases.write('library-abc', { stateGeneration: 4, doc: doc('one') })
    await bases.write('shikimori-7', { stateGeneration: null, doc: doc('two') })
    expect(await bases.read('library-abc')).toEqual({
      baseVersion: 1,
      party: 'library-abc',
      stateGeneration: 4,
      doc: doc('one')
    })
    expect((await bases.read('shikimori-7'))!.doc.installId).toBe('two')
    expect(fs.readdirSync(dir).sort()).toEqual(['library-abc.json', 'shikimori-7.json'])
  })

  it('a crash between the temp write and the rename leaves the old base intact', async () => {
    await createSyncBaseStore(dir, realFs).write('library-abc', {
      stateGeneration: 1,
      doc: doc('old')
    })
    const crashing: SyncBaseFs = {
      ...realFs,
      rename: async () => {
        throw new Error('power cut')
      }
    }

    await expect(
      createSyncBaseStore(dir, crashing).write('library-abc', {
        stateGeneration: 2,
        doc: doc('new')
      })
    ).rejects.toThrow('power cut')

    const after = await createSyncBaseStore(dir, realFs).read('library-abc')
    expect(after).toMatchObject({ stateGeneration: 1, doc: { installId: 'old' } })
    // The torn temp file is overwritten by the next write and removed with the base.
    await createSyncBaseStore(dir, realFs).remove('library-abc')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('refuses a party that is not library-<id> or shikimori-<id>', async () => {
    expect(isSyncBaseParty('library-x1_y-2')).toBe(true)
    expect(isSyncBaseParty('../config')).toBe(false)
    expect(isSyncBaseParty('library-a/b')).toBe(false)
    await expect(createSyncBaseStore(dir, realFs).read('other-1')).rejects.toThrow(
      'invalid sync base party'
    )
  })
})
