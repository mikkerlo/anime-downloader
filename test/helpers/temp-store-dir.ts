import { beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface TempStoreDir {
  /** A fresh temp dir per test, handed to `createStorageService` as `cwd`. */
  readonly dir: string
  /** `<dir>/config.json`, the file electron-store reads and writes. */
  readonly cfg: string
}

/** Registers a per-test temp config dir for the real electron-store, removed after each test. */
export function useTempStoreDir(): TempStoreDir {
  const state = { dir: '', cfg: '' }
  beforeEach(() => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-service-test-'))
    state.cfg = path.join(state.dir, 'config.json')
  })
  afterEach(() => {
    fs.rmSync(state.dir, { recursive: true, force: true })
  })
  return state
}
