// The real `runFfmpeg` body (#516), driven through the `setFfmpegDriver` seam
// with a fake fluent command: the probe re-check, the `'start'` priority drop,
// and `destroy()` killing an in-flight merge on quit without undoing the queue
// it just persisted. The merge-scheduling tests replace `runFfmpeg` wholesale,
// so none of this ran under test before the seam.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  type DownloadItem,
  type FfmpegDriver,
  type MergeStatus
} from '../../src/main/download-manager'

const FFMPEG = '/fake/ffmpeg'
const FFPROBE = '/fake/ffprobe'
const PRIORITY_LOW = os.constants.priority.PRIORITY_LOW

function makeItem(overrides: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: 'ep1.mp4',
    animeName: 'Anime',
    episodeLabel: 'ep1',
    animeId: 100,
    episodeInt: '1',
    quality: 720,
    translationType: 'subRu',
    author: 'Author',
    status: 'completed',
    bytesReceived: 0,
    totalBytes: 0,
    speed: 0,
    ...overrides
  }
}

type Internals = {
  queue: DownloadItem[]
  mergeStatuses: Map<number, { status: MergeStatus; error?: string; percent?: number }>
  ffmpegDriver: FfmpegDriver
}

/**
 * A fluent-ffmpeg command as `runFfmpeg` sees it: chainable builders, an
 * EventEmitter, `run()` that does not spawn yet, and a `kill()` that — like
 * fluent-ffmpeg's own — is a silent no-op until `ffmpegProc` exists.
 */
class FakeCommand extends EventEmitter {
  ffmpegProc: { pid: number; kill: (signal: string) => void } | undefined
  ran = false
  readonly signals: string[] = []
  readonly output_: string[] = []
  /** Called on every kill that reached a process, before recording it. */
  onKill: (() => void) | null = null

  constructor(readonly input_: string) {
    super()
  }
  input(): this {
    return this
  }
  outputOptions(): this {
    return this
  }
  videoCodec(): this {
    return this
  }
  audioCodec(): this {
    return this
  }
  output(p: string): this {
    this.output_.push(p)
    return this
  }
  run(): void {
    this.ran = true
  }
  kill(signal: string): this {
    if (this.ffmpegProc) this.ffmpegProc.kill(signal)
    return this
  }
  /** fluent-ffmpeg's spawn callback: assign the process, then emit 'start'. */
  spawned(pid = 4242): void {
    this.ffmpegProc = {
      pid,
      kill: (signal) => {
        this.onKill?.()
        this.signals.push(signal)
      }
    }
    this.emit('start', 'ffmpeg -i …')
  }
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('DownloadManager runFfmpeg through the driver seam (#516)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager
  let commands: FakeCommand[]
  let priorities: [number, number][]
  let priorityError: Error | null
  let probe: () => Promise<number>
  let held: boolean
  let mergeCompletes: string[]
  let unlink: (file: string) => void

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-run-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-run-dl-'))
    dm = new DownloadManager(downloadDir, {} as never, userDataDir)
    commands = []
    priorities = []
    priorityError = null
    probe = async () => 60
    held = false
    mergeCompletes = []
    unlink = (file) => fs.unlinkSync(file)
    dm.setFfmpegDriver({
      createCommand: (input) => {
        const cmd = new FakeCommand(input)
        commands.push(cmd)
        return cmd as never
      },
      probeDuration: () => probe(),
      setPriority: (pid, priority) => {
        priorities.push([pid, priority])
        if (priorityError) throw priorityError
      },
      unlinkSync: (file) => unlink(file)
    })
    // Throws instead of spinning: a held pass that re-entered the cycle would
    // loop on microtasks, which starves every timer including the test timeout.
    let checks = 0
    dm.setMergeHoldCheck(() => {
      if (++checks > 50) throw new Error('merge cycle spun on the hold check')
      return held
    })
    dm.onMergeComplete((info) => {
      mergeCompletes.push(info.mkvFilename)
    })
  })

  afterEach(() => {
    dm.destroy()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  const putFile = (rel: string): string => {
    const abs = path.join(downloadDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'bytes')
    return abs
  }

  /** Two completed episodes in the queue; A merges first. */
  function seedTwo(): { aMp4: string; aMkv: string } {
    const aMp4 = putFile('ep1.mp4')
    putFile('ep2.mp4')
    const internals = dm as unknown as Internals
    internals.queue = [
      makeItem({}),
      makeItem({ id: 'video-2', translationId: 2, filename: 'ep2.mp4', episodeInt: '2' })
    ]
    return { aMp4, aMkv: path.join(downloadDir, 'ep1.mkv') }
  }

  const persisted = (tid: number): string | undefined => {
    const file = path.join(userDataDir, 'queue.json')
    if (!fs.existsSync(file)) return undefined
    return JSON.parse(fs.readFileSync(file, 'utf-8')).mergeStatuses?.[String(tid)]?.status
  }

  describe("the 'start' handler", () => {
    it('lowers the merge to PRIORITY_LOW exactly once, with the spawned PID', async () => {
      seedTwo()
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      expect(commands).toHaveLength(1)
      expect(commands[0].ran).toBe(true)
      expect(priorities).toEqual([])

      commands[0].spawned(4242)
      expect(priorities).toEqual([[4242, PRIORITY_LOW]])

      commands[0].emit('end')
      await flush()
      commands[1].spawned(4343)
      commands[1].emit('end')
      await cycle
      expect(priorities).toEqual([
        [4242, PRIORITY_LOW],
        [4343, PRIORITY_LOW]
      ])
      expect(dm.getMergeStatus(1)).toBe('completed')
    })

    it('does not fail the merge when setPriority throws (ESRCH)', async () => {
      seedTwo()
      priorityError = Object.assign(new Error('setPriority ESRCH'), { code: 'ESRCH' })
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      commands[0].spawned()
      commands[0].emit('end')
      await flush()
      commands[1].spawned()
      commands[1].emit('end')
      await cycle
      expect(dm.getMergeStatus(1)).toBe('completed')
      expect(dm.getMergeStatus(2)).toBe('completed')
    })

    it('a hold that rises between run() and spawn still lowers priority, kills nothing and completes', async () => {
      const { aMp4 } = seedTwo()
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      expect(commands[0].ffmpegProc).toBeUndefined()

      held = true
      commands[0].spawned(4242)
      expect(priorities).toEqual([[4242, PRIORITY_LOW]])
      expect(commands[0].signals).toEqual([])

      commands[0].emit('end')
      await cycle
      expect(dm.getMergeStatus(1)).toBe('completed')
      expect(fs.existsSync(aMp4)).toBe(false)
      expect(mergeCompletes).toEqual(['ep1.mkv'])
      // ...and the next group waits for the hold.
      expect(commands).toHaveLength(1)
      expect(dm.takeHeldRequest()).toBe(true)
    })
  })

  describe('the re-check between probeDuration and run()', () => {
    it('puts a group whose probe outlived a rising hold back to pending, spawning nothing', async () => {
      const { aMp4, aMkv } = seedTwo()
      // A sentinel at the output path: the failure path would unlink it.
      fs.writeFileSync(aMkv, 'someone else')
      let finishProbe!: (d: number) => void
      probe = () => new Promise<number>((resolve) => (finishProbe = resolve))

      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      expect(dm.getMergeStatus(1)).toBe('merging')

      held = true
      finishProbe(60)
      await flush()
      // Before awaiting the cycle: a spawned command would leave it pending.
      expect(commands).toHaveLength(0)
      await cycle
      await flush()

      expect(dm.getMergeStatus(1)).toBe('pending')
      expect(fs.existsSync(aMkv)).toBe(true)
      expect(fs.existsSync(aMp4)).toBe(true)
      expect(mergeCompletes).toEqual([])
      expect(dm.takeHeldRequest()).toBe(true)
      // Disk follows memory: the start persisted 'merging', the revert persists 'pending'.
      expect(persisted(1)).toBe('pending')
    })

    it('stops a scan file the same way, reporting what was left', async () => {
      const a = putFile(path.join('Show', 'a.mp4'))
      putFile(path.join('Show', 'b.mp4'))
      let finishProbe!: (d: number) => void
      probe = () => new Promise<number>((resolve) => (finishProbe = resolve))

      const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
      await flush()
      held = true
      finishProbe(60)
      await flush()
      expect(commands).toHaveLength(0)
      const result = await scan

      expect(fs.existsSync(a)).toBe(true)
      expect(result).toEqual({
        merged: 0,
        failed: ['Merging is paused while the player is open: 2 files left']
      })
      expect(dm.takeHeldRequest()).toBe(true)
    })
  })

  describe('the merge start is on disk (crash sequence)', () => {
    it('persists merging before ffmpeg spawns, with no destroy() at all', async () => {
      seedTwo()
      void dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      expect(commands[0].ran).toBe(true)
      // The app dies here: kill -9 / power loss. Whatever is in queue.json now
      // is what the next boot sees.
      expect(persisted(1)).toBe('merging')
      commands[0].emit('error', new Error('cleanup'))
      await flush()
    })
  })

  describe('destroy() on quit', () => {
    it("kills the active merge after persisting, unlinks the partial .mkv, and the 'error' that follows undoes nothing", async () => {
      const { aMp4, aMkv } = seedTwo()
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      commands[0].spawned()
      fs.writeFileSync(aMkv, 'partial')
      let persistedAtKill: string | undefined
      commands[0].onKill = () => {
        persistedAtKill = persisted(1)
      }

      dm.destroy()
      expect(commands[0].signals).toEqual(['SIGKILL'])
      expect(persistedAtKill).toBe('merging')
      expect(fs.existsSync(aMkv)).toBe(false)

      // What a real SIGKILL produces.
      commands[0].emit('error', new Error('ffmpeg was killed with signal SIGKILL'))
      await cycle
      await flush()

      expect(persisted(1)).toBe('merging')
      expect(dm.getMergeStatus(1)).toBe('merging')
      expect(commands).toHaveLength(1)
      expect(fs.existsSync(aMp4)).toBe(true)
      expect(mergeCompletes).toEqual([])
    })

    describe('the partial-.mkv unlink while Windows still holds the handle', () => {
      const fsError = (code: string): NodeJS.ErrnoException =>
        Object.assign(new Error(`${code}: fake`), { code })

      /** A merge in flight with a partial .mkv on disk, killed by destroy(). */
      async function quitMidMerge(): Promise<{
        aMkv: string
        calls: string[]
        elapsedMs: number
        finish: () => Promise<void>
      }> {
        const { aMkv } = seedTwo()
        const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
        await flush()
        commands[0].spawned()
        fs.writeFileSync(aMkv, 'partial')
        const calls: string[] = []
        const inner = unlink
        unlink = (file) => {
          calls.push(file)
          inner(file)
        }
        const t0 = performance.now()
        dm.destroy()
        const elapsedMs = performance.now() - t0
        expect(commands[0].signals).toEqual(['SIGKILL'])
        return {
          aMkv,
          calls,
          elapsedMs,
          finish: async () => {
            commands[0].emit('error', new Error('ffmpeg was killed with signal SIGKILL'))
            await cycle
            await flush()
            expect(persisted(1)).toBe('merging')
          }
        }
      }

      it('retries through EBUSY / EPERM until the unlink goes through', async () => {
        // Windows 11: TerminateProcess returns before ffmpeg's handle closes,
        // so the first unlink right after the kill fails and one ~5 ms later
        // succeeds.
        const faults = ['EBUSY', 'EPERM', 'EBUSY']
        unlink = (file) => {
          const code = faults.shift()
          if (code) throw fsError(code)
          fs.unlinkSync(file)
        }
        const { aMkv, calls, finish } = await quitMidMerge()

        expect(calls).toEqual([aMkv, aMkv, aMkv, aMkv])
        expect(fs.existsSync(aMkv)).toBe(false)
        await finish()
      })

      it('gives up on a persistent EBUSY within the deadline, without throwing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
          unlink = () => {
            throw fsError('EBUSY')
          }
          const { aMkv, calls, elapsedMs, finish } = await quitMidMerge()

          expect(calls.length).toBeGreaterThan(1)
          expect(elapsedMs).toBeGreaterThanOrEqual(150)
          expect(elapsedMs).toBeLessThan(1000)
          // Left for the boot fallback (dropTruncatedMerge).
          expect(fs.existsSync(aMkv)).toBe(true)
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('EBUSY'))
          await finish()
        } finally {
          warn.mockRestore()
        }
      })

      it('does not retry any other error', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
          unlink = () => {
            throw fsError('EACCES')
          }
          const { aMkv, calls, elapsedMs, finish } = await quitMidMerge()

          expect(calls).toEqual([aMkv])
          expect(elapsedMs).toBeLessThan(100)
          expect(fs.existsSync(aMkv)).toBe(true)
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
          await finish()
        } finally {
          warn.mockRestore()
        }
      })

      it('takes ENOENT as already removed', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
          unlink = (file) => {
            fs.unlinkSync(file)
            throw fsError('ENOENT')
          }
          const { aMkv, calls, finish } = await quitMidMerge()

          expect(calls).toEqual([aMkv])
          expect(fs.existsSync(aMkv)).toBe(false)
          expect(warn).not.toHaveBeenCalled()
          await finish()
        } finally {
          warn.mockRestore()
        }
      })
    })

    it("kills a merge caught before its PID exists the moment 'start' fires", async () => {
      seedTwo()
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      dm.destroy()
      // fluent-ffmpeg's kill() without ffmpegProc is a silent no-op.
      expect(commands[0].signals).toEqual([])

      commands[0].spawned()
      expect(commands[0].signals).toEqual(['SIGKILL'])
      expect(priorities).toEqual([])

      commands[0].emit('error', new Error('ffmpeg was killed with signal SIGKILL'))
      await cycle
      expect(commands).toHaveLength(1)
    })

    it("treats an 'end' that lands after destroy() as a stopped merge, not a finished one", async () => {
      // ffmpeg exited 0 just before destroy(), and 'end' arrives once stderr
      // closes: destroy() has already unlinked the finished .mkv, so the
      // sources must stay and nothing may record 'completed'.
      const { aMp4, aMkv } = seedTwo()
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      commands[0].spawned()
      fs.writeFileSync(aMkv, 'finished')

      dm.destroy()
      commands[0].emit('end')
      await cycle
      await flush()

      expect(fs.existsSync(aMp4)).toBe(true)
      expect(fs.existsSync(aMkv)).toBe(false)
      expect(persisted(1)).toBe('merging')
      expect(mergeCompletes).toEqual([])
      expect(commands).toHaveLength(1)
    })

    it('stops a probe in flight without spawning', async () => {
      const { aMp4 } = seedTwo()
      let finishProbe!: (d: number) => void
      probe = () => new Promise<number>((resolve) => (finishProbe = resolve))
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await flush()
      dm.destroy()
      finishProbe(60)
      await flush()
      expect(commands).toHaveLength(0)
      await cycle
      await flush()
      expect(persisted(1)).toBe('merging')
      expect(fs.existsSync(aMp4)).toBe(true)
    })

    describe('during scanAndMerge', () => {
      function seedScan(): { a: string; aMkv: string } {
        const a = putFile(path.join('Show', 'a.mp4'))
        putFile(path.join('Show', 'b.mp4'))
        return { a, aMkv: path.join(downloadDir, 'Show', 'a.mkv') }
      }

      it("does not record the killed file as failed, and starts no next file ('error')", async () => {
        const { a, aMkv } = seedScan()
        const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
        await flush()
        commands[0].spawned()
        fs.writeFileSync(aMkv, 'partial')

        dm.destroy()
        expect(commands[0].signals).toEqual(['SIGKILL'])
        expect(fs.existsSync(aMkv)).toBe(false)
        commands[0].emit('error', new Error('ffmpeg was killed with signal SIGKILL'))
        const result = await scan

        expect(result).toEqual({ merged: 0, failed: [] })
        expect(commands).toHaveLength(1)
        expect(fs.existsSync(a)).toBe(true)
      })

      it("keeps the source when 'end' lands after destroy()", async () => {
        const { a, aMkv } = seedScan()
        const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
        await flush()
        commands[0].spawned()
        fs.writeFileSync(aMkv, 'finished')

        dm.destroy()
        commands[0].emit('end')
        const result = await scan

        expect(fs.existsSync(a)).toBe(true)
        expect(fs.existsSync(aMkv)).toBe(false)
        expect(result).toEqual({ merged: 0, failed: [] })
        expect(commands).toHaveLength(1)
      })
    })
  })

  it.runIf(process.platform === 'linux')(
    'the default driver lowers a real child process to nice 19',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e3)'], {
        stdio: 'ignore'
      })
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', () => resolve())
          child.once('error', reject)
        })
        const fresh = new DownloadManager(downloadDir, {} as never, userDataDir)
        const driver = (fresh as unknown as Internals).ffmpegDriver
        fresh.destroy()
        driver.setPriority(child.pid!, PRIORITY_LOW)
        expect(os.getPriority(child.pid!)).toBe(19)
      } finally {
        child.kill('SIGKILL')
      }
    }
  )
})
