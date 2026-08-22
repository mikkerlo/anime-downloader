// Regression coverage for #275: both MSE open handlers must bound the
// renderer's requested open position against the probed duration before it
// reaches ffmpeg's `-ss`.
//
// The bug it pins is not a crash. An out-of-range `-ss` does not fail —
// ffmpeg's Matroska demuxer clamps the input seek to the last keyframe and
// emits the final GOP, so `-ss 3000` on a 1420 s file opens a real, playable
// session parked at the last frame; `ended` fires and the player auto-advances
// to the next episode. The user picks episode 7 and lands on episode 8.
//
// These assertions read the 4th argument of the *injected* `spawnFfmpegForSession`,
// which is only possible because the bound lives in the handler: implemented
// inside `spawnFfmpegForSession` it would be invisible here, and it would also
// let ffmpeg run at one seek while the offset probe measured another (#198).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { register } from '../../src/main/ipc/player.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc'
import type { MkvProbeResult } from '../../src/main/streaming'

type Handler = (event: unknown, ...args: unknown[]) => unknown

// The real Re:Zero S4 E01 [Crunchyroll] duration the #275 measurements were
// taken against, so the boundary numbers below are the measured ones.
const DURATION = 1420.063

const mkEvent = (): unknown => ({
  sender: { id: 1, isDestroyed: (): boolean => false, send: (): void => {} }
})

function mkProbe(): MkvProbeResult {
  return {
    duration: DURATION,
    videoCodec: 'h264',
    audioCodecName: 'aac',
    audioStrategy: 'copy',
    streamCopyMimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    audioCodecString: 'mp4a.40.2'
  }
}

describe('player.ipc — the open seek is bounded against the probed duration (#275)', () => {
  let handlers: Map<string, Handler>
  let spawnFfmpegForSession: ReturnType<typeof vi.fn>
  let probeCopyTimestampOffset: ReturnType<typeof vi.fn>
  let probeSeekAnchor: ReturnType<typeof vi.fn>
  let mkvPath: string
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-ipc-seek-'))
    mkvPath = path.join(dir, 'show.mkv')
    fs.writeFileSync(mkvPath, 'not a real mkv')
    spawnFfmpegForSession = vi.fn().mockReturnValue({ kill: vi.fn() })
    // Distinct non-zero resolutions so an assertion on the reply's
    // `contentStart` can tell "the probe ran" from "the probe was skipped".
    probeCopyTimestampOffset = vi.fn().mockResolvedValue(1234)
    probeSeekAnchor = vi.fn().mockResolvedValue(5678)
    const streamingService = {
      tmpDir: path.join(dir, 'remux'),
      probeMkvForMse: vi.fn().mockResolvedValue(mkProbe()),
      probeCopyTimestampOffset,
      probeSeekAnchor,
      pickH264Encoder: vi.fn().mockResolvedValue({ name: 'libx264' }),
      registerSession: vi.fn(),
      cleanupSession: vi.fn(),
      spawnFfmpegForSession
    }
    const deps = {
      store: new InMemoryStorage({ hevcTranscodeOnPlay: 'ask' }),
      streamingService,
      smotretApi: {},
      coldStorageService: {},
      mp4StatsService: {},
      // Empty ffprobe path skips the fluent-ffmpeg subtitle probe, keeping the
      // test hermetic; ffmpeg must be non-empty to pass the availability gate.
      getFfmpegPath: () => '/bin/ffmpeg',
      getFfprobePath: () => ''
    } as unknown as AppDeps
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    register(deps)
    handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function openCopy(initialSeek?: number): Promise<Record<string, unknown>> {
    return (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(
      mkEvent(),
      mkvPath,
      initialSeek
    )) as Record<string, unknown>
  }

  async function openTranscode(initialSeek?: number): Promise<Record<string, unknown>> {
    return (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM_TRANSCODE)!(
      mkEvent(),
      mkvPath,
      initialSeek
    )) as Record<string, unknown>
  }

  const spawnSeek = (): unknown => spawnFfmpegForSession.mock.calls[0][3]

  // The reaching input: a syncplay room parked past the end of a shorter local
  // file, or a stale watch-progress record whose `saved.duration` describes a
  // file that is no longer on disk.
  it('copy handler refuses a seek far past the end and spawns at 0', async () => {
    await openCopy(2999)
    expect(spawnFfmpegForSession).toHaveBeenCalledTimes(1)
    // Today, without the bound: 2999 — and ffmpeg emits the final GOP.
    expect(spawnSeek()).toBe(0)
    expect(warn).toHaveBeenCalled()
  })

  it('transcode handler refuses a seek far past the end and spawns at 0', async () => {
    await openTranscode(2999)
    expect(spawnFfmpegForSession).toHaveBeenCalledTimes(1)
    expect(spawnSeek()).toBe(0)
    expect(warn).toHaveBeenCalled()
  })

  it('copy handler passes a seek just inside the file through verbatim', async () => {
    await openCopy(DURATION - 0.001)
    expect(spawnSeek()).toBe(DURATION - 0.001)
    expect(warn).not.toHaveBeenCalled()
  })

  it('transcode handler passes a seek just inside the file through verbatim', async () => {
    await openTranscode(DURATION - 0.001)
    expect(spawnSeek()).toBe(DURATION - 0.001)
    expect(warn).not.toHaveBeenCalled()
  })

  // The boundary window `[duration, duration + 1)`. This is the input where the
  // main-side and renderer-side predicates could drift apart in a later edit,
  // so it is pinned here *and* at the composable seam in
  // `use-mse-player.test.ts`. `>= duration`, not `> duration`: `duration` itself
  // is already the point where ffmpeg stops answering the question and starts
  // substituting the final GOP (`-ss 1420.063` and `-ss 999999` are the same
  // 15-packet run).
  describe.each([
    { label: 'exactly the duration', seek: DURATION },
    { label: 'half a second past the duration', seek: DURATION + 0.5 }
  ])('the boundary window — $label', ({ seek }) => {
    it('copy handler refuses it', async () => {
      await openCopy(seek)
      expect(spawnSeek()).toBe(0)
    })

    it('transcode handler refuses it', async () => {
      await openTranscode(seek)
      expect(spawnSeek()).toBe(0)
    })
  })

  // The existing normalisation the bound folds in, unchanged.
  it.each([
    { label: 'undefined', seek: undefined },
    { label: 'zero', seek: 0 },
    { label: 'negative', seek: -5 },
    { label: 'NaN', seek: NaN },
    { label: 'Infinity', seek: Infinity }
  ])('copy handler still normalises $label to 0', async ({ seek }) => {
    await openCopy(seek)
    expect(spawnSeek()).toBe(0)
  })

  // The #198 desync guard: the offset probe and ffmpeg must read *one* value.
  // The two handlers have different shapes here and both statements matter.
  describe('the offset probe sees the same value the spawn does', () => {
    it('copy: the probe is skipped entirely on the rejection, and contentStart is 0', async () => {
      // `probeCopyTimestampOffset` is conditional on `requestedSeek > 0`, so on
      // the rejection there is no call to compare against — asserting "same
      // value" would be vacuous. What is assertable is that the reply's
      // `contentStart` is the 0 of the skipped probe, not the probe's 1234.
      const res = await openCopy(2999)
      expect(probeCopyTimestampOffset).not.toHaveBeenCalled()
      expect(res.contentStart).toBe(0)
      // The two fields have to agree on this path: `offsetPromise` short-circuits
      // to `Promise.resolve(0)`, so a truthful `refusedSeek` sits next to a
      // structural `contentStart` of 0 (#295). No transcode twin of this — that
      // handler probes unconditionally, so its refused `contentStart` is
      // whatever the anchor probe measures, i.e. the mock.
      expect(res.refusedSeek).toBe(true)
    })

    it('copy: the probe is called with exactly the spawned seek on a pass-through', async () => {
      await openCopy(DURATION - 0.001)
      expect(probeCopyTimestampOffset).toHaveBeenCalledTimes(1)
      expect(probeCopyTimestampOffset.mock.calls[0][1]).toBe(spawnSeek())
      expect(probeCopyTimestampOffset.mock.calls[0][1]).toBe(DURATION - 0.001)
    })

    it('transcode: probeSeekAnchor is called with the bounded 0 on the rejection', async () => {
      // Unconditional on this path, so the same-value assertion is meaningful
      // in both directions here.
      await openTranscode(2999)
      expect(probeSeekAnchor).toHaveBeenCalledTimes(1)
      expect(probeSeekAnchor.mock.calls[0][1]).toBe(0)
      expect(probeSeekAnchor.mock.calls[0][1]).toBe(spawnSeek())
    })

    it('transcode: probeSeekAnchor is called with the spawned seek on a pass-through', async () => {
      await openTranscode(DURATION - 0.001)
      expect(probeSeekAnchor).toHaveBeenCalledTimes(1)
      expect(probeSeekAnchor.mock.calls[0][1]).toBe(spawnSeek())
      expect(probeSeekAnchor.mock.calls[0][1]).toBe(DURATION - 0.001)
    })
  })

  // #295: the decision itself rides the reply, so the renderer reads a boolean
  // instead of re-deriving `requested >= duration` from two transported numbers.
  // One pin per handler — the two return literals are wired independently, and a
  // single case would leave copy/transcode drift unpinned, which is this issue's
  // own failure class relocated from cross-process to cross-handler. Both
  // directions per handler, because a hardcoded `true` passes a refusal-only
  // test (and a hardcoded `false` passes a pass-through-only one).
  describe('the reply reports the refusal decision main took (#295)', () => {
    it('copy: a refused open reports refusedSeek: true', async () => {
      const res = await openCopy(2999)
      expect(res.refusedSeek).toBe(true)
    })

    it('copy: an open bounded through unchanged reports refusedSeek: false', async () => {
      const res = await openCopy(DURATION - 0.001)
      expect(res.refusedSeek).toBe(false)
    })

    it('transcode: a refused open reports refusedSeek: true', async () => {
      const res = await openTranscode(2999)
      expect(res.refusedSeek).toBe(true)
    })

    it('transcode: an open bounded through unchanged reports refusedSeek: false', async () => {
      const res = await openTranscode(DURATION - 0.001)
      expect(res.refusedSeek).toBe(false)
    })

    // The normalisation path zeroes the seek too, and it is *not* a refusal.
    // This is why the decision travels as its own boolean rather than being
    // inferred from the spawned 0 — on either side of the IPC boundary. It is
    // also the pin that bites a `refused` computed from the handler's raw
    // `initialSeek` parameter instead of from the expression inside
    // `boundInitialSeek` that actually takes the branch.
    it.each([
      { label: 'undefined', seek: undefined },
      { label: 'zero', seek: 0 },
      { label: 'negative', seek: -5 },
      { label: 'NaN', seek: NaN },
      { label: 'Infinity', seek: Infinity }
    ])('copy: normalising $label to 0 is not a refusal', async ({ seek }) => {
      const res = await openCopy(seek)
      expect(spawnSeek()).toBe(0)
      expect(res.refusedSeek).toBe(false)
    })
  })

  // The bound sits *below* #283's pre-spawn self-reap, not above it: a session
  // nobody will use must not spend a `console.warn` on a seek that will never
  // reach ffmpeg. Placement is otherwise invisible — both orderings spawn at 0
  // on this input — so it is asserted through the diagnostic.
  it('does not warn about a refused seek on an open a cleanup already overtook', async () => {
    let releaseProbe: (v: unknown) => void = () => {}
    const probeGate = new Promise((res) => {
      releaseProbe = res
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-ipc-seek-reap-'))
    const p = path.join(dir, 'show.mkv')
    fs.writeFileSync(p, 'not a real mkv')
    const spawn = vi.fn().mockReturnValue({ kill: vi.fn() })
    const streamingService = {
      tmpDir: path.join(dir, 'remux'),
      probeMkvForMse: vi.fn(async () => {
        await probeGate
        return mkProbe()
      }),
      probeCopyTimestampOffset: vi.fn().mockResolvedValue(0),
      probeSeekAnchor: vi.fn().mockResolvedValue(0),
      pickH264Encoder: vi.fn().mockResolvedValue({ name: 'libx264' }),
      registerSession: vi.fn(),
      cleanupSession: vi.fn(),
      allSessionIds: (): string[] => [],
      spawnFfmpegForSession: spawn
    }
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    register({
      store: new InMemoryStorage({ hevcTranscodeOnPlay: 'ask' }),
      streamingService,
      smotretApi: {},
      coldStorageService: {},
      mp4StatsService: {},
      getFfmpegPath: () => '/bin/ffmpeg',
      getFfprobePath: () => ''
    } as unknown as AppDeps)
    const h = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
    warn.mockClear()

    // The open parks in `probeMkvForMse`; the cleanup overtakes it there.
    const open = h.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(mkEvent(), p, 2999)
    await h.get(CHANNELS.PLAYER_CLEANUP_REMUX)!(mkEvent())
    releaseProbe(undefined)

    expect(await open).toEqual({ error: 'cancelled' })
    expect(spawn).not.toHaveBeenCalled()
    // Above the self-reap, this would log a refusal for a session that was
    // already dead.
    expect(warn).not.toHaveBeenCalled()
  })

  // The reply keeps naming the run's measured content start under its new name
  // (#275 renamed `MseOpenResult.initialSeek` → `contentStart`, so the request
  // and the measurement stop sharing a spelling across the IPC boundary).
  it('replies with the measured contentStart, not the request', async () => {
    const copy = await openCopy(600)
    expect(copy.contentStart).toBe(1234)
    expect(copy.initialSeek).toBeUndefined()
    const transcode = await openTranscode(600)
    expect(transcode.contentStart).toBe(5678)
    expect(transcode.initialSeek).toBeUndefined()
  })
})
