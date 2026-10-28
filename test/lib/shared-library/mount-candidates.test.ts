// The per-OS mount candidates a re-plugged library is searched under (#574).

import * as path from 'path'
import { describe, expect, it } from 'vitest'
import {
  createMountCandidates,
  mountParents,
  relativeToOldMount,
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

  it('a parents override replaces the per-OS list on Windows too', async () => {
    const list = createMountCandidates({
      platform: 'win32',
      parents: ['C:\\tmp\\mounts'],
      listDirs: async () => ['STICK'],
      isDir: async () => {
        throw new Error('no drive letters with an override')
      }
    })
    expect(await list()).toEqual([path.join('C:\\tmp\\mounts', 'STICK')])
  })
})

describe('mountParents (#620): the folders whose children are the candidates', () => {
  it.each([
    ['Linux', 'linux', 'u', undefined, ['/media/u', '/run/media/u', '/mnt']],
    ['Linux, no user', 'linux', '', undefined, ['/mnt']],
    ['macOS', 'darwin', 'u', undefined, ['/Volumes']],
    ['Windows (drive letters, no parents)', 'win32', 'u', undefined, []],
    ['Windows with the override', 'win32', 'u', ['C:\\tmp\\mounts'], ['C:\\tmp\\mounts']],
    ['Linux with the override', 'linux', 'u', ['/tmp/a', '/tmp/b'], ['/tmp/a', '/tmp/b']]
  ] as const)('%s', (_, platform, user, parents, want) => {
    expect(mountParents({ platform, user, parents: parents && [...parents] })).toEqual(want)
  })
})

describe('relativeToOldMount (#620): a root below its old mount', () => {
  const LINUX = ['/media/u', '/run/media/u', '/mnt']
  it.each([
    ['Windows, depth 2', 'D:\\Anime\\Lib', [], 'Anime\\Lib'],
    ['Windows, depth 3, lower-case letter', 'z:\\a\\b\\Lib', [], 'a\\b\\Lib'],
    ['Windows, forward slashes', 'K:/Anime/Lib', [], 'Anime\\Lib'],
    ['Windows, depth 1', 'D:\\Lib', [], null],
    ['Windows, depth 0', 'D:\\', [], null],
    ['C:', 'C:\\Users\\u\\Anime\\Lib', [], null],
    ['UNC', '\\\\server\\share\\Anime\\Lib', [], null],
    ['Linux, depth 2', '/media/u/STICK/Anime/Lib', LINUX, 'Anime/Lib'],
    ['Linux, /run/media, depth 3', '/run/media/u/SSD/a/b/Lib', LINUX, 'a/b/Lib'],
    ['Linux, /mnt, trailing slash', '/mnt/usb/Anime/Lib/', LINUX, 'Anime/Lib'],
    ['Linux, depth 1', '/media/u/STICK/Lib', LINUX, null],
    ['Linux, depth 0', '/media/u/STICK', LINUX, null],
    ['Linux, the parent itself', '/media/u', LINUX, null],
    ['Linux, under no parent', '/home/u/Anime/Lib', LINUX, null],
    ['Linux, a sibling of a parent', '/media/u2/STICK/Anime/Lib', LINUX, null],
    ['macOS', '/Volumes/STICK/Anime/Lib', ['/Volumes'], 'Anime/Lib'],
    ['Windows with the override', 'C:\\tmp\\m\\STICK\\Anime\\Lib', ['C:\\tmp\\m'], 'Anime\\Lib'],
    ['Windows with the override, outside it', 'D:\\Anime\\Lib', ['C:\\tmp\\m'], null],
    ['a Windows root against posix parents', 'D:\\Anime\\Lib', LINUX, null]
  ] as const)('%s', (_, root, parents, rel) => {
    expect(relativeToOldMount(root, [...parents])).toEqual(rel === null ? null : { rel })
  })
})
