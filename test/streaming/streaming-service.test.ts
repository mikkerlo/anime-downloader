import { describe, it, expect, beforeEach } from 'vitest'
import type { ChildProcess } from 'child_process'
import { createStreamingService, type MseSession } from '../../src/main/streaming'

function mkSession(over: Partial<MseSession> = {}): MseSession {
  const kills: string[] = []
  const proc = {
    kill: (sig: string): boolean => {
      kills.push(sig)
      return true
    }
  } as unknown as ChildProcess
  return {
    proc,
    pendingBytes: 0,
    stderrTail: [],
    done: false,
    error: null,
    senderId: 1,
    ready: false,
    prelude: [],
    mkvPath: '/tmp/show.mkv',
    generation: 1,
    videoCodec: 'h264',
    transcode: false,
    audioStrategy: 'copy',
    h264Encoder: null,
    ...over
  }
}

describe('StreamingService session management', () => {
  const channels = {
    streamChunk: 'sc',
    streamEnd: 'se',
    streamError: 'sx',
    streamProgress: 'sp'
  }

  let svc: ReturnType<typeof createStreamingService>

  beforeEach(() => {
    svc = createStreamingService({
      getFfmpegPath: () => '/bin/ffmpeg',
      getFfprobePath: () => '/bin/ffprobe',
      channels
    })
  })

  it('exposes the backpressure watermarks + tmpDir constants', () => {
    expect(svc.highWatermark).toBe(64 * 1024 * 1024)
    expect(svc.lowWatermark).toBe(16 * 1024 * 1024)
    expect(svc.tmpDir).toMatch(/anime-dl-remux$/)
  })

  it('registerSession + getSession round-trip; getSession returns undefined for unknown ids', () => {
    const s = mkSession()
    svc.registerSession('abc', s)
    expect(svc.getSession('abc')).toBe(s)
    expect(svc.getSession('missing')).toBeUndefined()
  })

  it('allSessionIds reflects current registrations', () => {
    expect(svc.allSessionIds()).toEqual([])
    svc.registerSession('a', mkSession())
    svc.registerSession('b', mkSession())
    expect(svc.allSessionIds().sort()).toEqual(['a', 'b'])
  })

  it('cleanupSession kills the proc with SIGKILL, marks done, and drops the entry', () => {
    const s = mkSession()
    svc.registerSession('a', s)
    svc.cleanupSession('a')
    expect(s.done).toBe(true)
    expect(svc.getSession('a')).toBeUndefined()
    expect((s.proc as unknown as { kill: (sig: string) => boolean }).kill).toBeTruthy()
  })

  it('cleanupSession on unknown id is a no-op', () => {
    expect(() => svc.cleanupSession('missing')).not.toThrow()
  })

  it('cleanupAllSessions drops every registered session', () => {
    svc.registerSession('a', mkSession())
    svc.registerSession('b', mkSession())
    svc.cleanupAllSessions()
    expect(svc.allSessionIds()).toEqual([])
  })
})

describe('StreamingService h264EncoderCandidates', () => {
  const svc = createStreamingService({
    getFfmpegPath: () => '/bin/ffmpeg',
    getFfprobePath: () => '/bin/ffprobe',
    channels: {
      streamChunk: 'sc',
      streamEnd: 'se',
      streamError: 'sx',
      streamProgress: 'sp'
    }
  })

  it('always includes libx264 as the final fallback', () => {
    const candidates = svc.h264EncoderCandidates()
    expect(candidates[candidates.length - 1].name).toBe('libx264')
  })

  it('libx264 args contain the per-second keyframe expression', () => {
    const lx = svc.h264EncoderCandidates().find((c) => c.name === 'libx264')!
    const idx = lx.videoArgs.indexOf('-force_key_frames')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(lx.videoArgs[idx + 1]).toBe('expr:gte(t,n_forced*1)')
  })

  it('candidate list is platform-aware (linux: nvenc + qsv reachable; mac: nvenc-only after vaapi)', () => {
    const names = svc.h264EncoderCandidates().map((c) => c.name)
    expect(names).toContain('h264_nvenc')
    expect(names).toContain('libx264')
    if (process.platform === 'win32' || process.platform === 'linux') {
      expect(names).toContain('h264_qsv')
    } else {
      expect(names).not.toContain('h264_qsv')
    }
  })
})
