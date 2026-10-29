// The re-resolvable holder that replaced the boot-time `ffmpegReady` (#592).
import { describe, it, expect } from 'vitest'
import { createFfmpegStatus } from '../../src/main/lib/ffmpeg-status'

describe('createFfmpegStatus', () => {
  it('get() waits for the first refresh, then follows each refresh', async () => {
    let available = false
    const status = createFfmpegStatus(async () => ({ available }))
    let first: { available: boolean } | null = null
    const waiting = status.get().then((v) => (first = v))
    await Promise.resolve()
    expect(first).toBeNull()

    await status.refresh()
    await waiting
    expect(first).toEqual({ available: false })

    available = true
    // The boot value is not cached forever: a refresh replaces it.
    expect(await status.get()).toEqual({ available: false })
    await status.refresh()
    expect(await status.get()).toEqual({ available: true })
  })

  it('a refresh before the boot check settles the callers already waiting', async () => {
    const status = createFfmpegStatus(async () => ({ available: true }))
    const early = status.get()
    await status.refresh()
    await expect(early).resolves.toEqual({ available: true })
  })
})
