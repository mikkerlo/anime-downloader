// @vitest-environment happy-dom
//
// #371 — watch progress was written under the NEW episode's key while the
// <video> element was still decoding the OLD one.
//
// `goToEpisode` advances `activeEpisodeIndex` before the new source resolves,
// so `currentEpisodeInt` flips to N+1 immediately while the element plays on.
// In that window `resetEpisodeTracking()` has zeroed the save throttle and
// nothing pauses the element, so the first `timeupdate` writes the old
// element's `currentTime` under the new episode's key;
// `resumeFromSavedPosition` then faithfully restores it and the fresh episode
// opens ~2 minutes in.
//
// These are behavioral tests against the seam, not a `PlayerView` mount —
// `PlayerView` has no mount harness (see
// `test/renderer/components/player-lifecycle-scope.test.ts:15`,
// which says so and falls back to source scans), and building one is out of
// scope for this issue. The keying decision was extracted into
// `usePlayingEpisode` precisely so the behaviour difference could be tested
// without one. The `PlayerView`-side *wiring* — the `@loadstart` attribute and
// the `onMounted` seed call — is pinned by the structural scan in
// `player-lifecycle-scope.test.ts`, because nothing here can see it: every test
// below stays green if either is dropped.
//
// The rig mirrors `PlayerView`'s shape closely enough for the defect to be
// reproducible: a selected index that the nav advances synchronously, a real
// element that only fires `loadstart` when it commits to a new resource, and a
// `saveProgress`-alike that keys a progress row off the composable's ref.

import { describe, it, expect, beforeEach } from 'vitest'
import { usePlayingEpisode } from '../../../src/renderer/src/composables/use-playing-episode'

interface SavedRow {
  episodeInt: string
  position: number
}

/**
 * A miniature of the real flow. `selected` is `currentEpisodeInt`; `video` is
 * the element, wired declaratively the way the template wires it; `save()` is
 * the `saveProgress` reduction — it keys on whatever the composable says is
 * playing and reads the position off the element, which is the exact pairing
 * the bug got wrong.
 */
function makeRig(episodes: string[], startIndex = 0) {
  let index = startIndex
  const rows: SavedRow[] = []

  const video = document.createElement('video')

  const playing = usePlayingEpisode({
    getSelectedEpisodeInt: () => episodes[index] ?? ''
  })

  // The template binds `@loadstart="onLoadStart"`; an explicit listener is the
  // same binding, and it means the tests below drive the composable through a
  // real event dispatch rather than by calling the handler directly.
  video.addEventListener('loadstart', playing.onLoadStart)

  return {
    video,
    rows,
    playingEpisodeInt: playing.playingEpisodeInt,
    isPlayingEpisode: playing.isPlayingEpisode,
    seed: playing.seedPlayingEpisode,
    /** `goToEpisode`'s synchronous index write — no source resolved yet. */
    navigateTo(target: number): void {
      index = target
    },
    selectedEpisodeInt: (): string => episodes[index] ?? '',
    /** The element commits to the new resource. */
    commit(): void {
      video.dispatchEvent(new Event('loadstart'))
    },
    /** The `saveProgress` reduction: key from the ref, position from the element. */
    save(): void {
      const epInt = playing.playingEpisodeInt.value
      if (!epInt) return
      rows.push({ episodeInt: epInt, position: video.currentTime })
    },
    /**
     * The `persistSelectedTranslation` reduction: the key is the SELECTED
     * episode (a translation choice is about the episode being opened) but the
     * position comes off the element, so it is only usable when the element's
     * clock belongs to that episode.
     */
    persistTranslation(): void {
      const epInt = episodes[index] ?? ''
      if (!epInt) return
      let position = video.currentTime
      if (!playing.isPlayingEpisode(epInt)) position = 0
      rows.push({ episodeInt: epInt, position })
    }
  }
}

describe('#371 — the playing episode is seeded at mount', () => {
  let rig: ReturnType<typeof makeRig>

  beforeEach(() => {
    rig = makeRig(['1', '2', '3'])
  })

  // This is the `onMounted` warm-mount path: `resumeFromSavedPosition()` is
  // called DIRECTLY under `if (video.readyState >= 1)`, with no `loadstart`
  // ahead of it, because the element was already bound. A `loadstart`-only ref
  // is empty for the whole first episode there — a worse bug than the one being
  // fixed — so this test exists to make the seed non-droppable.
  it('reads the selected episode after the mount seed, with no loadstart at all', () => {
    rig.seed()

    expect(rig.playingEpisodeInt.value).toBe('1')
  })

  it('persists the first episode under its own key before any loadstart fires', () => {
    rig.seed()
    rig.video.currentTime = 126.325

    rig.save()

    expect(rig.rows).toEqual([{ episodeInt: '1', position: 126.325 }])
  })

  it('is inert rather than mis-keyed before the seed runs', () => {
    rig.video.currentTime = 126.325

    rig.save()

    expect(rig.playingEpisodeInt.value).toBe('')
    expect(rig.rows).toEqual([])
  })
})

describe('#371 — the nav window: the key follows the element, not the selection', () => {
  let rig: ReturnType<typeof makeRig>

  beforeEach(() => {
    rig = makeRig(['1', '2', '3'])
    rig.seed()
    rig.video.currentTime = 126.325
  })

  // THE regression. Navigate, then write progress before the element has
  // committed to anything. Against the old behaviour — where the key was
  // `currentEpisodeInt` and flipped synchronously with the index — the row
  // lands under episode 2 while the element is still at episode 1's playhead,
  // which is the reported defect verbatim.
  it('writes under the OLD episode when progress is saved before loadstart', () => {
    rig.navigateTo(1)
    expect(rig.selectedEpisodeInt()).toBe('2')

    rig.save()

    expect(rig.rows).toEqual([{ episodeInt: '1', position: 126.325 }])
    expect(rig.playingEpisodeInt.value).toBe('1')
  })

  it('switches to the new episode once the element commits', () => {
    rig.navigateTo(1)
    rig.save()

    rig.commit()
    rig.video.currentTime = 4

    rig.save()

    expect(rig.rows).toEqual([
      { episodeInt: '1', position: 126.325 },
      { episodeInt: '2', position: 4 }
    ])
  })

  it('never attributes the outgoing playhead to the incoming episode', () => {
    rig.navigateTo(1)

    // Several timeupdates can land in the window — on the MKV path it is an
    // ffmpeg spawn, seconds rather than the ~200ms of a stub.
    rig.save()
    rig.save()
    rig.save()
    rig.commit()

    expect(rig.rows.every((r) => r.episodeInt === '1')).toBe(true)
    expect(rig.rows.some((r) => r.episodeInt === '2')).toBe(false)
  })
})

describe('#371 — a rebind with no episode change is a no-op', () => {
  // `selectQuality` rebinds the source without touching the index, as do the
  // two source writes inside `selectTranslation`. The ref must not desync from
  // the episode across a quality reload.
  it('holds the episode across a loadstart caused by a quality switch', () => {
    const rig = makeRig(['1', '2', '3'], 1)
    rig.seed()
    expect(rig.playingEpisodeInt.value).toBe('2')

    rig.commit()

    expect(rig.playingEpisodeInt.value).toBe('2')
  })

  it('is idempotent across repeated commits without a navigation', () => {
    const rig = makeRig(['1', '2', '3'], 2)
    rig.seed()

    rig.commit()
    rig.commit()
    rig.commit()

    expect(rig.playingEpisodeInt.value).toBe('3')
  })
})

describe("#371 — maybeMarkWatched's two halves cannot disagree", () => {
  // `maybeMarkWatched` sets `watchedReported` and then calls
  // `saveProgress(true)`, and separately reports `epNum` to Shikimori. The two
  // share one flag, so if they keyed differently one function would report
  // episode N+1 watched while writing episode N's progress row. Both halves
  // take the same source; this pins that they still do.
  it('derives the Shikimori episode number and the progress key from one source', () => {
    const rig = makeRig(['1', '2', '3'])
    rig.seed()
    rig.video.currentTime = 1400

    rig.navigateTo(1)

    // The `saveProgress(true)` half.
    rig.save()
    // The Shikimori half.
    const epNum = parseInt(rig.playingEpisodeInt.value, 10)

    expect(rig.rows).toHaveLength(1)
    expect(String(epNum)).toBe(rig.rows[0].episodeInt)
    expect(epNum).toBe(1)
  })
})

describe('#371 — a selected-episode key with an element-sourced position', () => {
  // `persistSelectedTranslation` is the one writer in this class, and the nav
  // window reaches it: `TranslationMenu` is not gated by `navigating` the way
  // the two `EpisodeNavButton`s are, and `goToEpisode` swaps the menu's
  // contents to the TARGET episode's translations in the same synchronous block
  // as the index write — so what the user is offered mid-window is episode
  // N+1's list, and picking from it is a plausible action.
  let rig: ReturnType<typeof makeRig>

  beforeEach(() => {
    rig = makeRig(['1', '2', '3'])
    rig.seed()
    rig.video.currentTime = 126.325
  })

  it('does not file the outgoing playhead under the incoming episode', () => {
    rig.navigateTo(1)

    rig.persistTranslation()

    // The key is the episode being opened — that is what the translation choice
    // is about — but the position must not be the old element's clock.
    expect(rig.rows).toEqual([{ episodeInt: '2', position: 0 }])
  })

  it('keeps the element position when the element agrees with the selection', () => {
    rig.persistTranslation()

    expect(rig.rows).toEqual([{ episodeInt: '1', position: 126.325 }])
  })

  it('trusts the element again once it has committed to the new episode', () => {
    rig.navigateTo(1)
    rig.commit()
    rig.video.currentTime = 12

    rig.persistTranslation()

    expect(rig.rows).toEqual([{ episodeInt: '2', position: 12 }])
  })

  it('reports agreement before the seed, when there is no evidence of a disagreement', () => {
    const fresh = makeRig(['1', '2'])

    expect(fresh.isPlayingEpisode('1')).toBe(true)
    expect(fresh.isPlayingEpisode('2')).toBe(true)
  })

  it('reports disagreement only for the episode that is not decoding', () => {
    rig.navigateTo(1)

    expect(rig.isPlayingEpisode('1')).toBe(true)
    expect(rig.isPlayingEpisode('2')).toBe(false)
  })
})

describe('#371 — the getter is read through, never cached', () => {
  // The composable holds a getter rather than a `Ref` so it can never carry a
  // second source of truth for the selection, and so a teardown-time
  // `loadstart` — the unmount block's `video.load()` is the file's only
  // `load()`, and its only synchronous `loadstart` source — reads through the
  // same null-safe lookup instead of assuming a live `activeEpisodeIndex`.
  it('adopts an empty episode when the selection has gone away at teardown', () => {
    const rig = makeRig(['1', '2'], 0)
    rig.seed()
    expect(rig.playingEpisodeInt.value).toBe('1')

    // `activeEpisodeIndex` pointing past the end is what an emptied
    // `allEpisodes` looks like through `props.allEpisodes[i]?.episodeInt || ''`.
    rig.navigateTo(99)
    rig.commit()

    expect(rig.playingEpisodeInt.value).toBe('')
  })
})
