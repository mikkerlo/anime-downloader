import { describe, it, expect } from 'vitest'
import {
  previewSeek,
  commitSeek,
  resolveSeekTarget,
  sanitizeDuration
} from '../../src/renderer/src/utils'

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

// #237: seek() used to write `Math.max(0, Math.min(clamped, duration.value))`
// straight onto the element. During the load window that follows every episode
// switch the element's duration is `NaN` and the ref is still `0`, so that
// expression produced `NaN` (the restricted-double setter throws) or `0`
// (silently discarding the seek). No DOM here on purpose — this file runs under
// the repo's default `environment: 'node'`, and the helper's contract holds at
// the return-value level.
describe('resolveSeekTarget', () => {
  it('drops the upper clamp when neither duration is known', () => {
    // Old behavior: Math.min(1400, NaN) → NaN → TypeError at the setter.
    expect(resolveSeekTarget(1400, { elementDuration: NaN, refDuration: NaN })).toBe(1400)
  })

  it('drops the upper clamp on the live pre-metadata shape', () => {
    // refDuration: 0 is what the ref holds before the first durationchange
    // (and, post-sanitizeDuration, mid-reload too). Old behavior: 0.
    expect(resolveSeekTarget(1400, { elementDuration: NaN, refDuration: 0 })).toBe(1400)
  })

  it('treats Infinity as unknown, not as a usable bound', () => {
    // Pins the rule as Number.isFinite rather than !Number.isNaN — Infinity is
    // the one non-NaN non-finite value that sails past every downstream guard.
    expect(resolveSeekTarget(1400, { elementDuration: Infinity })).toBe(1400)
  })

  it('still applies the upper clamp when the duration is known', () => {
    expect(resolveSeekTarget(9999, { elementDuration: 1400 })).toBe(1400)
  })

  it('prefers the element over a stale ref from the previous episode', () => {
    expect(resolveSeekTarget(9999, { elementDuration: 1500, refDuration: 1400 })).toBe(1500)
  })

  it('falls back to the ref when the element has no duration yet', () => {
    expect(resolveSeekTarget(9999, { elementDuration: NaN, refDuration: 1400 })).toBe(1400)
  })

  it('keeps the lower clamp for a pre-metadata seekRelative(-5)', () => {
    expect(resolveSeekTarget(-5, { elementDuration: NaN, refDuration: 0 })).toBe(0)
    expect(resolveSeekTarget(-5, { elementDuration: 1400 })).toBe(0)
  })

  it('refuses a non-finite request so the element is never written', () => {
    // Old behavior: Math.max(0, Math.min(NaN, 1400)) → NaN → TypeError.
    expect(resolveSeekTarget(NaN, { elementDuration: 1400 })).toBeNull()
    expect(resolveSeekTarget(NaN, { elementDuration: NaN, refDuration: 0 })).toBeNull()
    expect(resolveSeekTarget(Infinity, { elementDuration: 1400 })).toBeNull()
  })
})

// #237: the sole write to PlayerView's `duration` ref assigned the element's
// duration straight through, so `NaN` reached the seek bar's progress computeds
// (which guard with `<= 0`, false for NaN) and emitted `width: NaN%`; `Infinity`
// escaped every guard in the file, including saveProgress's.
describe('sanitizeDuration', () => {
  it('collapses a non-finite duration to the "unknown" value every consumer bails on', () => {
    expect(sanitizeDuration(NaN)).toBe(0)
    expect(sanitizeDuration(Infinity)).toBe(0)
    expect(sanitizeDuration(-Infinity)).toBe(0)
  })

  it('passes a real duration through untouched', () => {
    expect(sanitizeDuration(1420.5)).toBe(1420.5)
  })

  it('treats zero and negatives as unknown', () => {
    expect(sanitizeDuration(0)).toBe(0)
    expect(sanitizeDuration(-1)).toBe(0)
  })
})
