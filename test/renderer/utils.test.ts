import { describe, it, expect } from 'vitest'
import {
  previewSeek,
  commitSeek,
  resolveSeekTarget,
  resolveMkvSpawnTarget,
  sanitizeDuration,
  waitingToastVisible,
  toPlayerTranslations,
  walkEpisodeSteps,
  resolveEpisodeTranslation,
  type EpisodeStepOutcome,
  type PlayerTranslationEntry
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

  // #272 review: Syncplay shares one position across peers whose files need not
  // match, so a room position can legitimately exceed *our* file's length — and
  // `initialSeek` reaches ffmpeg's `-ss`, where such a target does not fail:
  // the Matroska demuxer clamps the input seek to the last keyframe and emits
  // the final GOP, so the session opens parked at the last frame and
  // auto-advances to the next episode. The saved record's duration is the only
  // one in reach at this point in the open, and it bounds the room the way
  // `< 0.95` bounds the saved position below it.
  it('refuses a room position past the end of our own file', () => {
    const past = resolveMkvSpawnTarget(saved, 1500)
    expect(past.fromRoom).toBe(false)
    expect(past.resumeTarget).toBe(120)
    // The boundary itself is out: `-ss` at exactly the duration is the same
    // empty run.
    expect(resolveMkvSpawnTarget(saved, 1440).fromRoom).toBe(false)
    expect(resolveMkvSpawnTarget(saved, 1439).fromRoom).toBe(true)
  })

  // The bound is only as good as the duration behind it. With no saved record,
  // or one carrying no usable duration, there is nothing to compare against and
  // nothing better to fall through to — the room still wins.
  it('keeps the room position when no duration is known to bound it', () => {
    expect(resolveMkvSpawnTarget(null, 99999).fromRoom).toBe(true)
    expect(resolveMkvSpawnTarget({ ...saved, duration: 0 }, 99999).fromRoom).toBe(true)
  })
})

// #419. `PlayerView` has no mount harness (see the note above
// `resolveMkvSpawnTarget`), so the two behaviours this issue is about live in
// pure helpers and are asserted here: the walk that could not exit, and the
// resolution chain that could not see an off-page episode.
describe('toPlayerTranslations', () => {
  const detail = {
    translations: [
      { id: 10, type: 'subRu', authorsSummary: 'A', height: 720, isActive: 1 },
      { id: 11, type: 'voiceRu', authorsSummary: 'B', height: 480, isActive: 0 },
      { id: 12, type: 'subRu', authorsSummary: 'C', height: 1080, isActive: 1 }
    ] as Translation[]
  }

  it('maps the active translations and drops the inactive ones', () => {
    expect(toPlayerTranslations(detail)).toEqual([
      { id: 10, label: 'A', type: 'subRu', height: 720 },
      { id: 12, label: 'C', type: 'subRu', height: 1080 }
    ])
  })

  it('reads the declared height by default and the measured one when asked', () => {
    // The producers' one legitimate disagreement, and the reason `getHeight` is
    // a parameter: the detail view substitutes its probe cache here, the join
    // path and the player have no cache to substitute. Same mapper, two
    // rankings — which is why the asymmetry is written down in docs/player.md
    // rather than left to be discovered at a `.sort((a, b) => b.height - a.height)`.
    const probed = new Map([[10, 1440]])
    expect(toPlayerTranslations(detail, (t) => probed.get(t.id) ?? t.height)).toEqual([
      { id: 10, label: 'A', type: 'subRu', height: 1440 },
      { id: 12, label: 'C', type: 'subRu', height: 1080 }
    ])
  })

  it('returns an empty list for an episode whose detail was never loaded', () => {
    // The off-page shape this whole issue is about, at its source.
    expect(toPlayerTranslations(undefined)).toEqual([])
  })
})

// The walk-exit test, and it is the one for the hang. `handleRemoteEpisodeChange`
// stepped toward the room's episode while three reactive terms held, and a step
// that released `navigating` without moving the index left all three true. Every
// await on the way to that release resolved synchronously, so each iteration was
// a microtask continuation and the queue drained to exhaustion — timers, input
// and rAF all starved, with no exit but a translation pick and none at all after
// the player closed.
//
// The three rows are a table because the outcome is a three-case union and the
// asymmetry between the last two is the part a source scan cannot see: both
// break, only one of them is allowed to have said anything to the user.
describe('walkEpisodeSteps', () => {
  // `cap` is what stands in for "forever" — a real infinite walk cannot be
  // asserted on, so the harness gives `shouldStep` a bound and the assertion is
  // on how many steps were actually taken. A helper that ignores the outcome
  // runs to the cap; one that breaks takes exactly one step.
  const CAP = 50

  function harness(outcome: EpisodeStepOutcome): {
    shouldStep: () => boolean
    step: () => Promise<EpisodeStepOutcome>
    taken: () => number
    toasts: () => number
    index: () => number
  } {
    const target = 3
    const state = { index: 0, navigating: false }
    let taken = 0
    let toasts = 0
    return {
      // The real loop's three terms, minus the translation-epoch one that is
      // orthogonal here: index not yet at the target, and nobody else owns
      // `navigating`.
      shouldStep: () => state.index !== target && !state.navigating && taken < CAP,
      step: async () => {
        taken++
        state.navigating = true
        await Promise.resolve()
        if (outcome === 'moved') {
          state.index++
          state.navigating = false
          return 'moved'
        }
        // Both non-moved outcomes release the flag WITHOUT advancing the index —
        // verbatim what the silent `!resolvedTr` arm did, and why the loop's own
        // terms cannot see the difference. The toast is the step's, not the
        // walk's: `goToEpisode` owns the message so a stalled walk shows one, not
        // two.
        state.navigating = false
        if (outcome === 'unreachable') toasts++
        return outcome
      },
      taken: () => taken,
      toasts: () => toasts,
      index: () => state.index
    }
  }

  it('keeps stepping while the steps move, and arrives', async () => {
    const h = harness('moved')
    expect(await walkEpisodeSteps(h.shouldStep, h.step)).toBe('arrived')
    expect(h.taken()).toBe(3)
    expect(h.index()).toBe(3)
    expect(h.toasts()).toBe(0)
  })

  it('breaks on an unreachable step, and the user is told exactly once', async () => {
    const h = harness('unreachable')
    expect(await walkEpisodeSteps(h.shouldStep, h.step)).toBe('unreachable')
    expect(h.taken()).toBe(1)
    expect(h.toasts()).toBe(1)
  })

  it('breaks on a superseded step, and says nothing', async () => {
    // The asymmetry. A superseded step did not fail — it was outranked by the
    // user's own click or by the player closing — so a toast here would report
    // the user's own action as an error.
    const h = harness('superseded')
    expect(await walkEpisodeSteps(h.shouldStep, h.step)).toBe('superseded')
    expect(h.taken()).toBe(1)
    expect(h.toasts()).toBe(0)
  })
})

describe('resolveEpisodeTranslation', () => {
  const onPage: PlayerTranslationEntry[] = [
    { id: 100, label: 'Fansub', type: 'subRu', height: 1080 },
    { id: 101, label: 'Fansub', type: 'subRu', height: 720 },
    { id: 102, label: 'Studio', type: 'voiceRu', height: 1080 }
  ]

  function fetcher(result: PlayerTranslationEntry[]): {
    fill: () => Promise<PlayerTranslationEntry[]>
    calls: () => number
  } {
    let calls = 0
    return {
      fill: async () => {
        calls++
        return result
      },
      calls: () => calls
    }
  }

  // THE red→green case. An off-page episode arrives with `translations: []` and
  // a populated `downloadedTrIds` — the one shape arm (a) cannot use, because it
  // looks the downloaded ids up inside the translation list — so all four arms
  // read the empty array, nothing resolved, and the click did nothing at all.
  // The user could see the app knew about the download elsewhere and still not
  // reach it from the player.
  it('fills an off-page target on demand and resolves its downloaded translation', async () => {
    const f = fetcher(onPage)
    const res = await resolveEpisodeTranslation(
      { translations: [], downloadedTrIds: [101] },
      { translationId: 100, type: 'subRu' },
      f.fill
    )
    expect(res.outcome).toBe('resolved')
    expect(f.calls()).toBe(1)
    if (res.outcome !== 'resolved') return
    expect(res.translation.id).toBe(101)
    expect(res.forceLocal).toBe(true)
    // The filled list is handed back, because `activeTranslations` has to be
    // written from it too — the prop is a frozen snapshot and must not be mutated.
    expect(res.translations).toEqual(onPage)
  })

  it('does not fetch for an episode the page already carries', async () => {
    const f = fetcher(onPage)
    const res = await resolveEpisodeTranslation(
      { translations: onPage, downloadedTrIds: [] },
      { translationId: 100, type: 'subRu' },
      f.fill
    )
    expect(f.calls()).toBe(0)
    expect(res.outcome).toBe('resolved')
  })

  it('reports a failed fetch as unreachable rather than throwing', async () => {
    // Network or API error has to leave by the same path as "no translations":
    // the walk must stop on either, and the user must be told on either.
    const res = await resolveEpisodeTranslation(
      { translations: [], downloadedTrIds: [101] },
      { translationId: 100, type: 'subRu' },
      async () => {
        throw new Error('offline')
      }
    )
    expect(res.outcome).toBe('unreachable')
  })

  it('reports an empty fetch as unreachable', async () => {
    const res = await resolveEpisodeTranslation(
      { translations: [], downloadedTrIds: [101] },
      { translationId: 100, type: 'subRu' },
      async () => []
    )
    expect(res.outcome).toBe('unreachable')
  })

  // The chain itself is transplanted unchanged, so these pin its order rather
  // than propose one. Arm (a)'s last term is deliberately unfiltered — see the
  // author/type note in docs/player.md.
  it('prefers the same downloaded id, then the same type by quality, then any downloaded', async () => {
    const f = fetcher([])
    const sameId = await resolveEpisodeTranslation(
      { translations: onPage, downloadedTrIds: [100, 101] },
      { translationId: 100, type: 'subRu' },
      f.fill
    )
    expect(sameId.outcome === 'resolved' && sameId.translation.id).toBe(100)

    const sameType = await resolveEpisodeTranslation(
      { translations: onPage, downloadedTrIds: [101, 102] },
      { translationId: 100, type: 'subRu' },
      f.fill
    )
    expect(sameType.outcome === 'resolved' && sameType.translation.id).toBe(101)

    // Nothing downloaded of the current type: the fallback crosses type on
    // purpose, and `forceLocal` still holds because the pick is a local file.
    const anyDownloaded = await resolveEpisodeTranslation(
      { translations: onPage, downloadedTrIds: [102] },
      { translationId: 100, type: 'subRu' },
      f.fill
    )
    expect(anyDownloaded.outcome === 'resolved' && anyDownloaded.translation.id).toBe(102)
    expect(anyDownloaded.outcome === 'resolved' && anyDownloaded.forceLocal).toBe(true)
  })

  it('falls through the three streaming arms in order when nothing is downloaded', async () => {
    const f = fetcher([])
    // (b) same id
    const sameId = await resolveEpisodeTranslation(
      { translations: onPage, downloadedTrIds: [] },
      { translationId: 102, type: 'subRu' },
      f.fill
    )
    expect(sameId.outcome === 'resolved' && sameId.translation.id).toBe(102)
    expect(sameId.outcome === 'resolved' && sameId.forceLocal).toBe(false)

    // (c) best quality of the same type
    const sameType = await resolveEpisodeTranslation(
      { translations: onPage, downloadedTrIds: [] },
      { translationId: 999, type: 'subRu' },
      f.fill
    )
    expect(sameType.outcome === 'resolved' && sameType.translation.id).toBe(100)

    // (d) first available
    const first = await resolveEpisodeTranslation(
      { translations: onPage, downloadedTrIds: [] },
      { translationId: 999, type: 'signsRu' },
      f.fill
    )
    expect(first.outcome === 'resolved' && first.translation.id).toBe(100)
  })
})
