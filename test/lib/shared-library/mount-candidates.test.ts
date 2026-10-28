// The per-OS mount candidates a re-plugged library is searched under (#574).

import { describe, expect, it } from 'vitest'
import {
  createMountCandidates,
  withBudget
} from '../../../src/main/lib/shared-library/mount-candidates'

const never = <T>(): Promise<T> => new Promise<T>(() => {})

describe('mount candidates (#574)', () => {
  it('Windows: the drive letters D:–Z: that exist', async () => {
    const present = new Set(['E:\\', 'K:\\', 'Z:\\'])
    const list = createMountCandidates({
      platform: 'win32',
      isDir: async (p) => present.has(p),
      listDirs: async () => {
        throw new Error('not used on Windows')
      }
    })
    expect(await list()).toEqual(['E:\\', 'K:\\', 'Z:\\'])
  })

  it('macOS: every folder under /Volumes', async () => {
    const list = createMountCandidates({
      platform: 'darwin',
      user: 'u',
      listDirs: async (dir) => (dir === '/Volumes' ? ['Macintosh HD', 'STICK'] : []),
      isDir: async () => true
    })
    expect(await list()).toEqual(['/Volumes/Macintosh HD', '/Volumes/STICK'])
  })

  it('Linux: /media/$USER, /run/media/$USER and /mnt', async () => {
    const tree: Record<string, string[]> = {
      '/media/u': ['STICK'],
      '/run/media/u': ['SSD'],
      '/mnt': ['usb']
    }
    const list = createMountCandidates({
      platform: 'linux',
      user: 'u',
      listDirs: async (dir) => {
        if (!tree[dir]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return tree[dir]
      },
      isDir: async () => true
    })
    expect(await list()).toEqual(['/media/u/STICK', '/run/media/u/SSD', '/mnt/usb'])
  })

  it('a check that outlasts its budget counts as not there, and does not stall the rest', async () => {
    const list = createMountCandidates({
      platform: 'win32',
      budgetMs: 20,
      isDir: (p) => (p === 'F:\\' ? never<boolean>() : Promise.resolve(p === 'G:\\'))
    })
    const t0 = Date.now()
    expect(await list()).toEqual(['G:\\'])
    expect(Date.now() - t0).toBeLessThan(1000)

    const linux = createMountCandidates({
      platform: 'linux',
      user: 'u',
      budgetMs: 20,
      listDirs: (dir) => (dir === '/mnt' ? never<string[]>() : Promise.resolve(['X'])),
      isDir: async () => true
    })
    expect(await linux()).toEqual(['/media/u/X', '/run/media/u/X'])
  })

  it('withBudget returns the fallback on a rejection too', async () => {
    expect(await withBudget(() => Promise.reject(new Error('x')), 50, 'fb')).toBe('fb')
    expect(await withBudget(async () => 'v', 50, 'fb')).toBe('v')
  })

  it('the default deps produce a list without throwing', async () => {
    const list = createMountCandidates({ budgetMs: 200 })
    expect(Array.isArray(await list())).toBe(true)
  })
})
