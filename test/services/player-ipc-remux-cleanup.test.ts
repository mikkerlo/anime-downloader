// A legacy `player:remux-mkv` whose input disappears mid-remux (#582) leaves no
// partial `${baseName}-${stamp}.mp4` or `.ass` in the streaming tmpDir: a
// drive pulled during the full-file copy would otherwise leave them behind.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc'

// The fake writes its output as it starts, the way ffmpeg creates its output
// file before copying, then fails (the input vanished) or finishes. The
// subtitle extraction writes its `.ass` and finishes after the remux failed.
const behaviour = { remux: 'fail' as 'fail' | 'ok' }
vi.mock('fluent-ffmpeg', () => {
  const Ffmpeg = (input: string): Record<string, unknown> => {
    let output = ''
    const handlers: Record<string, (arg?: unknown) => void> = {}
    const builder: Record<string, unknown> = {
      outputOptions: () => builder,
      output: (p: string) => {
        output = p
        return builder
      },
      on: (evt: string, cb: (arg?: unknown) => void) => {
        handlers[evt] = cb
        return builder
      },
      run: () => {
        fs.writeFileSync(output, 'partial bytes')
        const isAss = output.endsWith('.ass')
        setTimeout(
          () => {
            if (!isAss && behaviour.remux === 'fail') {
              handlers.error?.(new Error(`${input}: No such file or directory`))
            } else {
              handlers.end?.()
            }
          },
          isAss ? 40 : 10
        )
      }
    }
    return builder
  }
  Ffmpeg.setFfmpegPath = (): void => {}
  Ffmpeg.setFfprobePath = (): void => {}
  Ffmpeg.ffprobe = (_p: string, cb: (e: unknown, m: unknown) => void): void =>
    cb(null, { streams: [{ codec_type: 'subtitle' }] })
  return { default: Ffmpeg }
})

const { register } = await import('../../src/main/ipc/player.ipc')

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('player:remux-mkv: a failed remux cleans its partial output', () => {
  let dir: string
  let tmpDir: string
  let input: string
  let remux: () => Promise<{ mp4Path: string } | PlayerOpenError>
  const classifyMissing = vi.fn(async (): Promise<PlayerFailureReason | null> => null)

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-ipc-remux-cleanup-'))
    tmpDir = path.join(dir, 'remux')
    input = path.join(dir, 'drive', 'Show - 01.mkv')
    fs.mkdirSync(path.dirname(input), { recursive: true })
    fs.writeFileSync(input, 'mkv')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    register({
      store: new InMemoryStorage({}),
      streamingService: { tmpDir },
      smotretApi: {},
      coldStorageService: {},
      mp4StatsService: {},
      getFfmpegPath: () => '/bin/ffmpeg',
      getFfprobePath: () => '/bin/ffprobe',
      attachedLibraryService: { spawnPathFor: (p: string) => p, classifyMissing }
    } as unknown as AppDeps)
    const handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
    remux = () =>
      Promise.resolve(handlers.get(CHANNELS.PLAYER_REMUX_MKV)!({}, input)) as Promise<
        { mp4Path: string } | PlayerOpenError
      >
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the input disappears mid-remux: an error, and no .mp4 or .ass left in the tmpDir', async () => {
    behaviour.remux = 'fail'
    classifyMissing.mockResolvedValueOnce('drive-disconnected')
    const res = await remux()
    expect(res).toEqual({
      error: expect.stringContaining('No such file'),
      reason: 'drive-disconnected'
    })
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })

  it('a remux that succeeds keeps its output', async () => {
    behaviour.remux = 'ok'
    const res = await remux()
    expect(res).toMatchObject({ mp4Path: expect.stringMatching(/Show - 01-\d+\.mp4$/) })
    const mp4 = path.basename((res as { mp4Path: string }).mp4Path)
    expect(fs.readdirSync(tmpDir).sort()).toEqual([mp4.replace(/\.mp4$/, '.ass'), mp4])
  })
})
