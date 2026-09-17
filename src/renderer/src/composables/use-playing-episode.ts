// #371 — which episode the <video> element is actually decoding, as opposed to
// which episode the UI has navigated to.
//
// `goToEpisode` writes `activeEpisodeIndex` before the new source is resolved,
// so `currentEpisodeInt` flips to N+1 while the element is still playing N. In
// that window nothing pauses the element, `resetEpisodeTracking()` has zeroed
// the save throttle, and the first `timeupdate` writes the OLD element's
// `currentTime` under the NEW episode's key. `resumeFromSavedPosition` then
// faithfully restores it and the fresh episode opens ~2 minutes in.
//
// The organizing rule for every call site is a question, not a list:
//
//     which episode is this about — the one being OPENED, or the one on SCREEN?
//
// Openers (`resumeFromSavedPosition`, `prepareMkvForPlayback`'s saved-position
// fetch, the syncplay announce, the skip-UI reset) keep `currentEpisodeInt` —
// there it is the *correct* value, not a tolerated one. Only readers about the
// media currently decoding take the ref this composable owns.
//
// Two facts decide the shape:
//
//   1. The anchor is the element's own `loadstart`. It fires exactly when the
//      element commits to a new resource, which is true by definition rather
//      than by an argument about what the template patched. A `watch` on
//      `videoSrc` lands on the post-flush microtask queue in no guaranteed
//      order against the element's commit and cannot see `load()`-driven
//      rebinds at all; anchoring on the `activeFilePath`/`activeStreamUrl`
//      write sites reintroduces the same bug on the MKV path with a WIDER
//      window, because `videoSrc` collapses to `''` there, the template merely
//      removes the attribute, and removing the attribute does not empty the
//      source — the old media keeps decoding across the whole ffmpeg spawn.
//
//   2. The mount seed is NOT optional. `PlayerView`'s `onMounted` calls
//      `resumeFromSavedPosition()` *directly* when `video.readyState >= 1`,
//      with no `loadstart` ahead of it — the element was already bound. A
//      `loadstart`-only ref would therefore be unset for the entire first
//      episode on every warm mount, which is a worse bug than the one being
//      fixed. `seedPlayingEpisode()` closes that, and the first test in
//      `use-playing-episode.test.ts` exists so the seed cannot be dropped in
//      review as redundant.
//
// Extracted rather than inlined because `PlayerView` has no mount harness (see
// `player-lifecycle-scope.test.ts`), and this is where the behavior difference
// actually lives: the ref, the seed, and the adopt-on-commit rule are testable
// against a stub element with no component mount at all.

import { ref, type Ref } from 'vue'

export interface UsePlayingEpisodeDeps {
  /**
   * The episode the UI has navigated to — `PlayerView`'s `currentEpisodeInt`.
   * A getter rather than a `Ref` so the composable never holds a second source
   * of truth for the selection, and so a teardown-time `loadstart` (the
   * `video.load()` in the unmount block is the file's only `load()`, and its
   * only synchronous `loadstart` source) reads through the same null-safe
   * lookup instead of assuming a live `activeEpisodeIndex`.
   */
  getSelectedEpisodeInt: () => string
}

export interface UsePlayingEpisode {
  /**
   * The episode the element is decoding. `''` before the seed — readers already
   * guard on a falsy episode int, so the pre-mount window is inert rather than
   * writing under an empty key.
   */
  playingEpisodeInt: Ref<string>
  /** Call synchronously from `onMounted`, above the first await. See (2) above. */
  seedPlayingEpisode: () => void
  /** Bind declaratively as `@loadstart` on the `<video>`. See (1) above. */
  onLoadStart: () => void
  /**
   * True when the element's clock belongs to `epInt` — i.e. it is safe to read
   * `video.currentTime` / `video.duration` as that episode's position.
   *
   * For the writers whose KEY is the selected episode but whose POSITION comes
   * off the element. `persistSelectedTranslation` is the one such site: it
   * records a translation id (about the episode being opened) together with a
   * position (about the episode decoding), and in the nav window those are two
   * different episodes. `TranslationMenu` is not gated by `navigating` the way
   * the two `EpisodeNavButton`s are, and `goToEpisode` swaps `activeTranslations`
   * to the target episode's list in the same synchronous block as the index
   * write — so picking a translation mid-window is a reachable user action, not
   * a contrived race.
   *
   * Unseeded (`''`) answers true: before the seed there is no evidence of a
   * disagreement, and the fallback this gates is a wasted IPC round trip rather
   * than a no-op.
   */
  isPlayingEpisode: (epInt: string) => boolean
}

export function usePlayingEpisode(deps: UsePlayingEpisodeDeps): UsePlayingEpisode {
  const playingEpisodeInt = ref('')

  // The seed and the commit handler adopt the selection identically — what
  // differs is *when*, and that is the whole of the fix. Kept as two named
  // entry points rather than one, because the two call sites are pinned
  // separately by the structural scan: the composable's own tests stay green if
  // either the `@loadstart` attribute or the `onMounted` seed is dropped from
  // `PlayerView.vue`, since both are wiring rather than behaviour.
  const adopt = (): void => {
    playingEpisodeInt.value = deps.getSelectedEpisodeInt()
  }

  return {
    playingEpisodeInt,
    seedPlayingEpisode: adopt,
    onLoadStart: adopt,
    isPlayingEpisode: (epInt: string): boolean =>
      playingEpisodeInt.value === '' || playingEpisodeInt.value === epInt
  }
}
