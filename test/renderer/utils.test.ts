import { describe, it, expect } from 'vitest'
import { previewSeek, commitSeek } from '../../src/renderer/src/utils'

// Regression coverage for #127: the slider must not write video.currentTime
// while the user is still dragging. previewSeek updates the displayed time
// only; commitSeek (fired on mouseup / @change) applies the actual seek once.
describe('previewSeek', () => {
  it('updates the displayed time without touching the video element', () => {
    const currentTime = { value: 10 }
    const video = { currentTime: 10 }

    // A burst of drag ticks — each only previews, none seek the element.
    const ticks = ['12.5', '20', '33.2', '41']
    for (const raw of ticks) previewSeek(raw, currentTime)

    expect(currentTime.value).toBe(41)
    expect(video.currentTime).toBe(10) // untouched mid-drag
  })

  it('returns the parsed time', () => {
    const currentTime = { value: 0 }
    expect(previewSeek('25.5', currentTime)).toBe(25.5)
  })

  it('ignores a non-numeric value and keeps the current time', () => {
    const currentTime = { value: 7 }
    expect(previewSeek('not-a-number', currentTime)).toBe(7)
    expect(currentTime.value).toBe(7)
  })
})

describe('commitSeek', () => {
  it('writes the committed time onto the video element exactly once', () => {
    const video = { currentTime: 10 }
    commitSeek(42, video)
    expect(video.currentTime).toBe(42)
  })

  it('is a no-op when there is no video element', () => {
    expect(() => commitSeek(42, null)).not.toThrow()
    expect(() => commitSeek(42, undefined)).not.toThrow()
  })

  it('ignores a non-finite time so the element is never corrupted', () => {
    const video = { currentTime: 10 }
    commitSeek(NaN, video)
    expect(video.currentTime).toBe(10)
  })

  it('preview-then-commit applies the final drag target a single time', () => {
    const currentTime = { value: 0 }
    const video = { currentTime: 0 }

    previewSeek('15', currentTime)
    previewSeek('60', currentTime)
    expect(video.currentTime).toBe(0) // still untouched during drag

    commitSeek(currentTime.value, video)
    expect(video.currentTime).toBe(60)
  })
})
