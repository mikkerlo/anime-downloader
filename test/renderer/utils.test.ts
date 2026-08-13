import { describe, it, expect } from 'vitest'
import {
  previewSeek,
  commitSeek,
  resolveSeekTarget,
  resolveMkvSpawnTarget,
  sanitizeDuration,
  waitingToastVisible
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
    // The live-stream shape in full: an Infinity element duration pairs with a
    // ref that sanitizeDuration has already collapsed to 0, so neither side
    // supplies a bound and the request passes through.
    expect(resolveSeekTarget(1400, { elementDuration: Infinity, refDuration: 0 })).toBe(1400)
  })

  it('still applies the upper clamp when the duration is known', () => {
    expect(resolveSeekTarget(9999, { elementDuration: 1400 })).toBe(1400)
  })

  it('prefers the element over a stale ref from the previous episode', () => {
    expect(resolveSeekTarget(9999, { elementDuration: 1500, refDuration: 1400 })).toBe(1500)
  })

  it('falls back to the ref, which mid-reload is the previous episode length', () => {
    // The one window where the fallback is not a repair: between an episode
    // switch's :src swap and that reload's NaN durationchange, the element
    // reports nothing while the ref still holds the *previous* episode's
    // duration, so the seek clamps to it rather than passing through. Accepted
    // in #237 (brief window, ~90 s skip targets), pinned here so that any
    // future change to it is a deliberate one rather than an incidental one.
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

// #238 review: the "Waiting for download…" toast and the short-landing toast
// share one absolutely-positioned slot, so the second must be gated on whether
// the first is actually rendering. Both PlayerView `v-if`s read this predicate
// so the two gates cannot drift apart (they did: the fire-time gate checked
// `waitingForDownload` alone, the template checked nothing).
describe('waitingToastVisible', () => {
  it('owns the slot while the playhead is stalled on a live download', () => {
    expect(waitingToastVisible(true, false)).toBe(true)
  })

  it('releases the slot when the download dies, because the banner takes over', () => {
    // The waiting toast is `v-if="waitingForDownload && !downloadDead"`, and
    // `waitingForDownload` is a ref cleared only by `playing` — so a download
    // that dies while stalled leaves it true with nothing rendered. Suppressing
    // the short-landing toast there would blank the one state in which a skip
    // can never land.
    expect(waitingToastVisible(true, true)).toBe(false)
  })

  it('leaves the slot free whenever nothing is waiting', () => {
    expect(waitingToastVisible(false, false)).toBe(false)
    expect(waitingToastVisible(false, true)).toBe(false)
  })
})

// #262: the MKV ffmpeg session is spawned before either #240 guard can run, so
// the room has to outrank the saved position here too — one layer earlier than
// `roomOwnsPlayhead()`. `PlayerView` has no mount harness (see
// `player-syncplay-resume.test.ts`), which is why the decision lives in this
// pure helper: these are the real behavioral assertions for it, and the SFC side
// is a source scan keyed to the call that feeds it.
describe('resolveMkvSpawnTarget', () => {
  const saved = { position: 120, duration: 1440, watched: false }

  // The discriminating case, and the one that fails on the old behavior: a
  // joiner with a stale saved record opening a local .mkv while the room sits
  // mid-episode used to spawn ffmpeg at 119, take the room's seek at
  // `loadedmetadata`, land outside the buffer and respawn at 600 — one wasted
  // spawn plus a second buffer-ahead wait, with the readiness gate holding
  // every peer in the room for the duration.
  it('seeds the spawn from the room, not the saved record', () => {
    expect(resolveMkvSpawnTarget(saved, 600)).toEqual({
      initialSeek: 599,
      resumeTarget: 600,
      fromRoom: true
    })
  })

  it('keeps the 1 s pre-roll and never goes negative', () => {
    expect(resolveMkvSpawnTarget(null, 0.4)).toEqual({
      initialSeek: 0,
      resumeTarget: 0.4,
      fromRoom: true
    })
  })

  // A room position of ~0 with a saved position of 120 is not a tie the saved
  // record wins: the room owns the playhead, so the apply would seek us to 0
  // anyway and a spawn at 119 is the wasted one.
  it('prefers a room position of zero over a saved record', () => {
    expect(resolveMkvSpawnTarget(saved, 0)).toEqual({
      initialSeek: 0,
      resumeTarget: 0,
      fromRoom: true
    })
  })

  // The negatives. Main answers `null` for a session that is not ready, for a
  // solo room (no non-self state), and for a file it has no state for — and a
  // `null` must fall through to the saved record, never to 0.
  it('falls back to the saved record when the room has no position', () => {
    expect(resolveMkvSpawnTarget(saved, null)).toEqual({
      initialSeek: 119,
      resumeTarget: 120,
      fromRoom: false
    })
  })

  it('spawns at 0 with neither a room position nor a usable saved record', () => {
    expect(resolveMkvSpawnTarget(null, null)).toEqual({
      initialSeek: 0,
      resumeTarget: 0,
      fromRoom: false
    })
  })

  it("keeps the saved record's own eligibility rules", () => {
    const at = (o: Partial<typeof saved>): ReturnType<typeof resolveMkvSpawnTarget> =>
      resolveMkvSpawnTarget({ ...saved, ...o }, null)
    // Watched, under the 5 s floor, past the 95% mark, or no known duration.
    expect(at({ watched: true }).resumeTarget).toBe(0)
    expect(at({ position: 3 }).resumeTarget).toBe(0)
    expect(at({ position: 1430 }).resumeTarget).toBe(0)
    expect(at({ duration: 0 }).resumeTarget).toBe(0)
  })

  // A rejected IPC read arrives as `null` through the call site's own catch, but
  // a garbage number must not become a spawn target either — ffmpeg would be
  // handed `NaN`.
  it('ignores a non-finite or negative room position', () => {
    expect(resolveMkvSpawnTarget(saved, NaN).fromRoom).toBe(false)
    expect(resolveMkvSpawnTarget(saved, Infinity).fromRoom).toBe(false)
    expect(resolveMkvSpawnTarget(saved, -3).fromRoom).toBe(false)
    expect(resolveMkvSpawnTarget(saved, -3).resumeTarget).toBe(120)
  })
})
