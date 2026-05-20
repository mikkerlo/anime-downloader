import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import { InMemoryStorage } from '../helpers/in-memory-storage'

function buildSvc(initial: Record<string, unknown>) {
  const store = new InMemoryStorage(initial)
  return createColdStorageService({
    store,
    downloadsFallbackDir: '/users/me/Downloads',
    sanitizeFilename: (s) => s,
    parseEpisodeFromFilename: () => null,
    broadcast: () => {},
    usageProgressChannel: 'usage-progress'
  })
}

describe('ColdStorageService path helpers', () => {
  it('falls back to <downloads>/anime-dl when no downloadDir set in simple mode', () => {
    const svc = buildSvc({ storageMode: 'simple', downloadDir: '', hotStorageDir: '' })
    expect(svc.getDownloadDir()).toBe(join('/users/me/Downloads', 'anime-dl'))
  })

  it('prefers downloadDir over the fallback in simple mode', () => {
    const svc = buildSvc({ storageMode: 'simple', downloadDir: '/custom/dl' })
    expect(svc.getDownloadDir()).toBe('/custom/dl')
  })

  it('prefers hotStorageDir over downloadDir in advanced mode', () => {
    const svc = buildSvc({
      storageMode: 'advanced',
      hotStorageDir: '/hot',
      downloadDir: '/custom/dl'
    })
    expect(svc.getDownloadDir()).toBe('/hot')
  })

  it('falls back to downloadDir when advanced mode has no hot dir set', () => {
    const svc = buildSvc({ storageMode: 'advanced', hotStorageDir: '', downloadDir: '/custom/dl' })
    expect(svc.getDownloadDir()).toBe('/custom/dl')
  })

  it('isAdvanced reflects storageMode exactly', () => {
    expect(buildSvc({ storageMode: 'advanced' }).isAdvanced()).toBe(true)
    expect(buildSvc({ storageMode: 'simple' }).isAdvanced()).toBe(false)
  })

  it('getColdStorageDir returns empty string when unset', () => {
    expect(buildSvc({}).getColdStorageDir()).toBe('')
    expect(buildSvc({ coldStorageDir: '/cold' }).getColdStorageDir()).toBe('/cold')
  })

  it('dirsForScan only includes cold dir when advanced+configured', () => {
    expect(
      buildSvc({
        storageMode: 'simple',
        downloadDir: '/hot',
        coldStorageDir: '/cold'
      }).dirsForScan()
    ).toEqual(['/hot'])
    expect(
      buildSvc({
        storageMode: 'advanced',
        hotStorageDir: '/hot',
        coldStorageDir: '/cold'
      }).dirsForScan()
    ).toEqual(['/hot', '/cold'])
    expect(
      buildSvc({ storageMode: 'advanced', hotStorageDir: '/hot', coldStorageDir: '' }).dirsForScan()
    ).toEqual(['/hot'])
  })
})
