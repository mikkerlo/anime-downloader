// Network mounts are not mount candidates (#581): a per-OS `classifyMounts`
// marks them, it runs only when the candidate set gains a path, and a mount it
// can't classify is still a candidate.

import { describe, expect, it, vi } from 'vitest'
import {
  createClassifyMounts,
  createMountCandidates,
  parseDarwinMount,
  parseMountinfo,
  parseWin32DriveTypes,
  type ClassifyMounts
} from '../../../src/main/lib/shared-library/mount-candidates'

const never = <T>(): Promise<T> => new Promise<T>(() => {})

const MOUNTINFO = [
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
  '41 22 0:44 / /mnt/nas rw,relatime shared:20 - cifs //nas/share rw,vers=3.1.1',
  '42 22 0:45 / /mnt/nfs rw,relatime shared:21 - nfs4 server:/export rw,vers=4.2',
  '43 22 0:46 / /mnt/my\\040share rw,relatime - smb3 //nas/other rw',
  '44 22 8:17 / /mnt/usb rw,relatime shared:22 - vfat /dev/sdb1 rw',
  '45 22 8:33 / /media/u/STICK rw,nosuid shared:23 - exfat /dev/sdc1 rw',
  '46 22 0:47 / /media/u/remote rw,nosuid - fuse.sshfs u@host:/ rw'
].join('\n')

const DARWIN_MOUNT = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  '/dev/disk4s1 on /Volumes/STICK (msdos, local, nodev, nosuid, noowners)',
  '//u@nas._smb._tcp.local/share on /Volumes/share (smbfs, nodev, nosuid, mounted by u)',
  '/dev/disk5s1 on /Volumes/My (USB) (exfat, local, nodev, nosuid, noowners)',
  'nas.local:/export on /Volumes/export (nfs, nodev, nosuid, mounted by u)'
].join('\n')

const WIN_JSON = JSON.stringify([
  { DeviceID: 'C:', DriveType: 3 },
  { DeviceID: 'E:', DriveType: 2 },
  { DeviceID: 'K:', DriveType: 3 },
  { DeviceID: 'Z:', DriveType: 4 }
])

describe('classifyMounts per OS (#581)', () => {
  it('Linux: cifs, nfs4, smb3 and fuse.sshfs under /mnt and /media are not candidates', async () => {
    const tree: Record<string, string[]> = {
      '/media/u': ['STICK', 'remote'],
      '/mnt': ['my share', 'nas', 'nfs', 'usb']
    }
    const list = createMountCandidates({
      platform: 'linux',
      user: 'u',
      listDirs: async (dir) => tree[dir] ?? [],
      classifyMounts: createClassifyMounts({
        platform: 'linux',
        readMountinfo: async () => MOUNTINFO
      })
    })
    expect(await list()).toEqual(['/media/u/STICK', '/mnt/usb'])
  })

  it('macOS: smbfs and nfs under /Volumes are not candidates', async () => {
    const list = createMountCandidates({
      platform: 'darwin',
      listDirs: async () => ['My (USB)', 'STICK', 'export', 'share'],
      classifyMounts: createClassifyMounts({
        platform: 'darwin',
        runMount: async () => DARWIN_MOUNT
      })
    })
    expect(await list()).toEqual(['/Volumes/My (USB)', '/Volumes/STICK'])
  })

  it('Windows: DriveType 4 on Z: is not a candidate', async () => {
    const present = new Set(['E:\\', 'K:\\', 'Z:\\'])
    const list = createMountCandidates({
      platform: 'win32',
      isDir: async (p) => present.has(p),
      classifyMounts: createClassifyMounts({
        platform: 'win32',
        queryDriveTypes: async () => WIN_JSON
      })
    })
    expect(await list()).toEqual(['E:\\', 'K:\\'])
  })

  it('a folder below a network mount is network too; one beside it is not', async () => {
    const classify = createClassifyMounts({
      platform: 'linux',
      readMountinfo: async () => MOUNTINFO
    })
    const kinds = await classify(['/mnt/nas/sub', '/mnt/nasty', '/mnt/plain'])
    expect(Object.fromEntries(kinds)).toEqual({
      '/mnt/nas/sub': 'network',
      '/mnt/nasty': 'local',
      '/mnt/plain': 'local'
    })
  })

  it('the parsers: mountinfo octal escapes, a volume name with brackets, one drive as an object', () => {
    expect(parseMountinfo(MOUNTINFO).find((e) => e.fsType === 'smb3')?.mountPoint).toBe(
      '/mnt/my share'
    )
    expect(parseDarwinMount(DARWIN_MOUNT)).toContainEqual({
      mountPoint: '/Volumes/My (USB)',
      fsType: 'exfat'
    })
    expect([...parseWin32DriveTypes('{"DeviceID":"z:","DriveType":4}')]).toEqual([['Z:', 4]])
  })
})

describe('classifyMounts runs only when the candidate set changes (#581)', () => {
  function setup(classify: ClassifyMounts) {
    let names = ['STICK']
    const spy = vi.fn(classify)
    const list = createMountCandidates({
      platform: 'linux',
      user: 'u',
      listDirs: async (dir) => (dir === '/media/u' ? names : []),
      classifyMounts: spy,
      log: { warn: vi.fn() }
    })
    return { list, spy, set: (n: string[]) => (names = n) }
  }

  it('once per change, only for the new paths; a removal needs no call', async () => {
    const { list, spy, set } = setup(async (paths) => new Map(paths.map((p) => [p, 'local'])))
    for (let i = 0; i < 3; i++) expect(await list()).toEqual(['/media/u/STICK'])
    expect(spy).toHaveBeenCalledTimes(1)
    set(['SSD', 'STICK'])
    await list()
    await list()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[1][0]).toEqual(['/media/u/SSD'])
    set(['STICK'])
    await list()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('a verdict is kept until its path disappears, then asked again', async () => {
    const { list, spy, set } = setup(async (paths) => new Map(paths.map((p) => [p, 'network'])))
    expect(await list()).toEqual([])
    set([])
    expect(await list()).toEqual([])
    set(['STICK'])
    expect(await list()).toEqual([])
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('a failed classification still lists the new candidates', async () => {
    const { list, spy } = setup(async () => {
      throw new Error('powershell blocked')
    })
    expect(await list()).toEqual(['/media/u/STICK'])
    expect(await list()).toEqual(['/media/u/STICK'])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a path it leaves out (unclassified) is still a candidate', async () => {
    const { list } = setup(async () => new Map())
    expect(await list()).toEqual(['/media/u/STICK'])
  })
})

describe('mount candidates: the cost guard (#581)', () => {
  it("a hung check isn't issued again while it is pending", async () => {
    const isDir = vi.fn((p: string) => (p === 'F:\\' ? never<boolean>() : Promise.resolve(false)))
    const list = createMountCandidates({
      platform: 'win32',
      budgetMs: 10,
      isDir,
      classifyMounts: async () => new Map()
    })
    await list()
    await list()
    await list()
    expect(isDir.mock.calls.filter(([p]) => p === 'F:\\')).toHaveLength(1)
  })

  it('`parents` replaces the per-OS list', async () => {
    const list = createMountCandidates({
      platform: 'win32',
      parents: ['/tmp/mounts'],
      listDirs: async (dir) => (dir === '/tmp/mounts' ? ['a', 'b'] : []),
      isDir: async () => {
        throw new Error('letters are not used with parents')
      },
      classifyMounts: async () => new Map()
    })
    expect(await list()).toEqual(['/tmp/mounts/a', '/tmp/mounts/b'])
  })

  it('the default classifier reads this machine without throwing', async () => {
    if (process.platform !== 'linux') return
    const kinds = await createClassifyMounts()(['/'])
    expect(kinds.get('/')).toBe('local')
  })
})
