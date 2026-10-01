// Single source of truth for the episode-file extension sets (#429).
//
// Two sets, because the app genuinely means two different things:
//   - `VIDEO_EXTS` — the containers a playable episode file can be in.
//   - `EPISODE_ARTIFACT_EXTS` — those plus the `.ass` sidecar, i.e. everything
//     the downloader writes for one episode, which is the set the delete and
//     hot→cold move paths operate on.
//
// Before #429 these were enumerated at 15 call sites in three sizes, six of
// them as regex alternations, so adding a container meant finding all of them
// by hand and nothing recorded which size any given site meant.
//
// They live in a `.ts` rather than beside the episode-file *type* in
// `src/shared/types/storage.d.ts` because a `.d.ts` emits no runtime values.
// `src/shared/shikimori.ts` is the precedent for a runtime constant shared by
// main, preload and the renderer. `EpisodeFileEntry` is deliberately NOT
// re-exported from here: it stays an ambient global so `src/preload/types.d.ts`
// can stay declaration-only.
//
// What is shared is the LISTS, not the matching. Each call site keeps its own
// case handling — `/i` in the player's sidecar regexes and in
// `parseEpisodeFromFilename`, case-sensitive in cold-storage, the downloads
// router and the scanner, `toLowerCase()` first in `sumShowFiles`. A single
// `hasExt()` predicate would have to pick one rule and would change behaviour
// at the others, so there isn't one.
//
// `sumShowFiles` (`src/main/index.ts`) is the deliberate holdout from the
// extraction: its set also carries `.srt`, because it measures what
// `CLEANUP_EXECUTE`'s recursive directory removal reclaims rather than what the
// downloader wrote. It is a superset of `EPISODE_ARTIFACT_EXTS`, and
// `test/lib/episode-files.test.ts` asserts it stays one.

export const VIDEO_EXTS = ['.mkv', '.mp4'] as const
export const EPISODE_ARTIFACT_EXTS = [...VIDEO_EXTS, '.ass'] as const

/**
 * Bare-extension alternation for embedding in a `RegExp` source. The constants
 * carry a leading dot because they feed `endsWith`; a regex needs `mkv|mp4`
 * inside `\.(…)$`, so the dot is stripped here rather than at each call site.
 */
export function extAlternation(exts: readonly string[]): string {
  return exts.map((ext) => (ext.startsWith('.') ? ext.slice(1) : ext)).join('|')
}

export const VIDEO_EXT_ALTERNATION = extAlternation(VIDEO_EXTS)
export const EPISODE_ARTIFACT_EXT_ALTERNATION = extAlternation(EPISODE_ARTIFACT_EXTS)

// Every derived regex below is built once, at module scope, never per call —
// the two in `episode-file-scan.ts` run inside a loop over every directory
// entry, and a per-iteration `new RegExp` turns a free literal into per-file
// allocation. None carry `g`, so sharing one object across call sites is safe:
// `replace`/`match`/`exec` without `g` never read or write `lastIndex`.
//
// The alternation order is `mkv|mp4`, following `VIDEO_EXTS`. Three of the
// sites this replaced spelled it `mp4|mkv`. The two alternatives are disjoint
// fixed-length literals anchored at `$`, so the order cannot change which
// input matches or what the capture group holds.

/** Trailing video container, case-insensitive. `player.ipc.ts`'s sidecar derivation. */
export const VIDEO_EXT_RE = new RegExp(`\\.(${VIDEO_EXT_ALTERNATION})$`, 'i')

/**
 * Trailing video container, optionally still `.part`-suffixed (#63): a growing
 * `x.mp4.part` session has to map to the same sibling `x.ass` as its final file.
 */
export const VIDEO_EXT_OR_PART_RE = new RegExp(`\\.(${VIDEO_EXT_ALTERNATION})(\\.part)?$`, 'i')
