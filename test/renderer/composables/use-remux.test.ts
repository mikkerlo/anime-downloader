import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useRemux } from '../../../src/renderer/src/composables/use-remux'

type Api = {
  playerRemuxMkv: (
    mkvPath: string
  ) => Promise<{ mp4Path: string; subtitleContent?: string } | { error: string }>
}

function setApi(api: Partial<Api>): void {
  const w = (globalThis as { window?: { api?: Partial<Api> } }).window
  const prev = w?.api ?? {}
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api: { ...prev, ...api } }
}

beforeEach(() => {
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api: {} }
})

describe('useRemux — initial state', () => {
  it('starts not remuxing with no remuxed path', () => {
    const r = useRemux()
    expect(r.remuxing.value).toBe(false)
    expect(r.remuxedPath.value).toBe('')
  })
})

describe('useRemux — runLegacyRemux happy path', () => {
  it('flips remuxing during IPC and stores the mp4 path on success', async () => {
    let resolveIpc: (v: { mp4Path: string }) => void = () => {}
    setApi({
      playerRemuxMkv: () =>
        new Promise((res) => {
          resolveIpc = res
        })
    })
    const r = useRemux()
    const promise = r.runLegacyRemux('/tmp/foo.mkv')
    // remuxing is true during the IPC await
    expect(r.remuxing.value).toBe(true)
    resolveIpc({ mp4Path: '/tmp/foo.mp4' })
    const result = await promise
    expect(result).toEqual({ ok: true, subtitleContent: undefined })
    expect(r.remuxing.value).toBe(false)
    expect(r.remuxedPath.value).toBe('/tmp/foo.mp4')
  })

  it('threads subtitle content through when main extracts it', async () => {
    setApi({
      playerRemuxMkv: vi.fn().mockResolvedValue({
        mp4Path: '/tmp/x.mp4',
        subtitleContent: 'fake ass'
      })
    })
    const r = useRemux()
    const result = await r.runLegacyRemux('/tmp/x.mkv')
    expect(result).toEqual({ ok: true, subtitleContent: 'fake ass' })
  })
})

describe('useRemux — error path', () => {
  it('returns ok:false + clears remuxing when main reports an error', async () => {
    setApi({
      playerRemuxMkv: vi.fn().mockResolvedValue({ error: 'ffmpeg crashed' })
    })
    const r = useRemux()
    const result = await r.runLegacyRemux('/tmp/foo.mkv')
    expect(result).toEqual({ ok: false, error: 'ffmpeg crashed' })
    expect(r.remuxing.value).toBe(false)
    expect(r.remuxedPath.value).toBe('')
  })

  it('clears remuxing even when the IPC promise rejects', async () => {
    setApi({
      playerRemuxMkv: vi.fn().mockRejectedValue(new Error('boom'))
    })
    const r = useRemux()
    await expect(r.runLegacyRemux('/tmp/foo.mkv')).rejects.toThrow('boom')
    expect(r.remuxing.value).toBe(false)
  })
})

describe('useRemux — clear', () => {
  it('resets the remuxed path', async () => {
    setApi({ playerRemuxMkv: vi.fn().mockResolvedValue({ mp4Path: '/tmp/a.mp4' }) })
    const r = useRemux()
    await r.runLegacyRemux('/tmp/a.mkv')
    expect(r.remuxedPath.value).toBe('/tmp/a.mp4')
    r.clear()
    expect(r.remuxedPath.value).toBe('')
  })

  it('is safe to call without prior remux', () => {
    const r = useRemux()
    expect(() => r.clear()).not.toThrow()
    expect(r.remuxedPath.value).toBe('')
  })
})
