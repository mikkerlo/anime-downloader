export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

export function formatSpeed(bps: number): string {
  return formatBytes(bps) + '/s'
}

export function formatEta(item: DownloadProgressItem): string {
  if (item.speed <= 0 || item.totalBytes <= 0) return '--'
  const remaining = item.totalBytes - item.bytesReceived
  const seconds = Math.ceil(remaining / item.speed)
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function getAnimeName(anime: {
  title: string
  titles?: { ru?: string; romaji?: string }
}): string {
  return anime.titles?.romaji || anime.titles?.ru || anime.title
}

export function qualityLabel(height: number): string {
  return height + 'p'
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

// Slider drag preview. The drag only moves the displayed time; the element's
// `currentTime` is written once, on mouseup, by `PlayerView`'s `onSeekEnd`
// through `seek()` — the same door as the keys and skip OP/ED, so a Watch
// Together room hears the drag at intent (#488). Each `video.currentTime = …`
// fires a `seeking` event that churns the MSE pipeline, which on Linux/WSL has
// been observed to cause repeated `readyState=1` stalls and audio dropout
// (#127).
export function previewSeek(rawValue: string, currentTime: { value: number }): number {
  const time = parseFloat(rawValue)
  if (!isFinite(time)) return currentTime.value
  currentTime.value = time
  return time
}

// Seek bounding for `PlayerView.seek()` (#237). `HTMLMediaElement.currentTime`
// is a WebIDL *restricted* double, so a non-finite write throws `TypeError`
// rather than coercing — the value handed to the setter must always be finite.
//
// The upper clamp applies only when a duration is genuinely known (finite and
// `> 0`). During the load window that follows every episode switch the element
// reports `NaN` and the ref is still `0`; clamping against either collapses the
// seek (to `NaN` → a throw, or to `0` → silently discarded intent). Unknown
// means "no upper bound", not "bound of zero". The element is preferred over
// the ref because the ref only moves when the queued `durationchange` task
// runs, so it is stale by construction in exactly this window.
//
// The ref is a fallback, not a second opinion: at the sole caller
// (`PlayerView.seek`) `elementDuration` always comes from a live element, so
// the ref is read only while the element itself reports nothing usable —
// `isKnownDuration` rejects `Infinity` and `<= 0` as well as `NaN`. Between an
// episode switch's `:src` swap and that reload's `NaN` `durationchange`, the
// ref still holds the *previous* episode's length, and a seek there clamps to
// it instead of passing through. Left as-is deliberately (#237): the window is
// brief, skip targets are ~90 s, and `seekRelative` is already capped by the
// playhead. The ref is only trustworthy once that `durationchange` has run it
// through `sanitizeDuration`.
//
// The lower clamp always survives: `seekRelative` feeds `currentTime + delta`
// back in, so a pre-metadata `seekRelative(-5)` arrives as `-5`.
export function resolveSeekTarget(
  requested: number,
  durations: { elementDuration?: number; refDuration?: number }
): number | null {
  if (!Number.isFinite(requested)) return null
  const { elementDuration, refDuration } = durations
  const known = isKnownDuration(elementDuration)
    ? elementDuration
    : isKnownDuration(refDuration)
      ? refDuration
      : null
  if (known === null) return Math.max(0, requested)
  return Math.max(0, Math.min(requested, known))
}

// Who owns the `.mkv-buffering-toast` slot (`top: 100px; right: 24px`), which
// fits exactly one toast (#238). `PlayerView` renders a third toast into that
// class — the MSE `mkvBuffering` / transcode notice — and it stays deliberately
// outside this predicate: the MSE path is entered only under `isMkv`
// (`.mkv`) and the growing-file path only under `isPartial` (`.part`), and one
// path cannot end with both, so a streamed-MKV session and a growing `.part`
// are mutually exclusive modes. (That is the reason, rather than "`mkvBuffering`
// is only set when a session starts" — it is also raised mid-session, on the
// unbuffered-seek respawn in `use-mse-player.ts`.) The growing-`.part` pair do
// both target the slot, so their gate has to be one predicate rather than two
// hand-copied booleans:
//   - "Waiting for download…" renders only while the download is still alive —
//     once it dies the `.streaming-banner` (a different slot, `top: 60px`)
//     carries the message instead, leaving this slot empty.
//   - The short-landing toast may therefore take the slot in the
//     `waiting && dead` state, which is precisely the state where the skip can
//     never land and feedback matters most.
// It must be read *reactively* at the point of use. Sampling it once when the
// short landing fires is not enough: a clamped skip parks the playhead just
// behind the frontier, so `waiting` typically fires a second or two later while
// the short-landing toast is still up, and the two would then render on top of
// each other.
export function waitingToastVisible(waitingForDownload: boolean, downloadDead: boolean): boolean {
  return waitingForDownload && !downloadDead
}

// Where to spawn the MKV/MSE ffmpeg session (#262). The room outranks the saved
// position here for the same reason it outranks it at the playhead (#240) — but
// one layer earlier, because by the time `roomOwnsPlayhead()` runs the session
// has already been spawned. Spawned at the local target while the room sits
// elsewhere, the remote apply at `loadedmetadata` seeks outside the buffer and
// costs a second ffmpeg spawn plus its buffer-ahead wait, and the readiness gate
// holds every peer in the room for the duration.
//
// `roomPosition` is main's projection (`syncplay:get-room-position`), already
// null unless the session is `ready` *and* a non-self state has been seen for
// the current file — so a solo room, a dead session and a fresh file all fall
// through to the saved record, and a null must never be read as 0.
//
// The 1 s pre-roll is unchanged from the saved-position path: it absorbs
// keyframe alignment, and here also the residual projection error.
//
// `fromRoom` is what suppresses the "Resumed at …" toast, in place of a live
// `roomOwnsPlayhead()` reading: if the session drops between the spawn and
// `loadedmetadata`, the predicate goes false while the playhead is still landing
// on the room's position, and the toast would name a position we are not at.
export function resolveMkvSpawnTarget(
  saved: { position: number; duration: number; watched?: boolean } | null,
  roomPosition: number | null
): { initialSeek: number; resumeTarget: number; fromRoom: boolean } {
  if (
    typeof roomPosition === 'number' &&
    Number.isFinite(roomPosition) &&
    roomPosition >= 0 &&
    // A known duration bounds the room position the way `< 0.95` bounds the
    // saved record below. Syncplay shares *one* position across peers whose
    // files need not match — a peer on a different release, or on a version with
    // the extras attached, can legitimately be parked past the end of ours — and
    // main bounds `initialSeek` against the probed duration before it reaches
    // ffmpeg's `-ss` (#275), refusing a target at or past the end and opening at
    // 0 instead. Unbounded, such a target does not fail: ffmpeg's Matroska
    // demuxer clamps the input seek to the last keyframe and emits the final
    // GOP, so the session opens parked at the last frame and auto-advances to
    // the next episode. `saved.duration` is the only duration in reach here
    // (main's probe has not run yet), so this can only bound the case where a
    // saved record exists — which is also the only case with somewhere better to
    // fall through to.
    (!saved || !(saved.duration > 0) || roomPosition < saved.duration)
  ) {
    return {
      initialSeek: Math.max(0, roomPosition - 1),
      resumeTarget: roomPosition,
      fromRoom: true
    }
  }
  if (
    saved &&
    !saved.watched &&
    saved.position > 5 &&
    saved.duration > 0 &&
    saved.position / saved.duration < 0.95
  ) {
    return {
      initialSeek: Math.max(0, saved.position - 1),
      resumeTarget: saved.position,
      fromRoom: false
    }
  }
  return { initialSeek: 0, resumeTarget: 0, fromRoom: false }
}

// Guards the one write to `PlayerView`'s `duration` ref (#237). The HTML load
// algorithm sets `duration` to `NaN` and fires `durationchange` on every
// element reload, and `NaN` slips past the `<= 0` guards the seek bar's
// progress computeds use, emitting `width: NaN%` into the DOM. `Infinity`
// slips past all of them and would be persisted by `saveProgress`. Collapsing
// both to `0` — the value every consumer already reads as "unknown" — repairs
// them.
export function sanitizeDuration(d: number): number {
  return Number.isFinite(d) && d > 0 ? d : 0
}

function isKnownDuration(d: number | undefined): d is number {
  return typeof d === 'number' && Number.isFinite(d) && d > 0
}

// --- episode navigation (#419) -------------------------------------------------

// The shared `EpisodeDetail` → player-translation mapper. Both producers of
// `PlayerEpisode.translations` carried their own copy — `buildAllEpisodes` in
// `use-episode-downloads.ts` and a private `toPlayerTranslations` in
// `use-open-episode.ts` — and the player's on-demand page-window fetch below
// would have been a third. It lives here rather than in either composable
// because a pure mapper is the wrong reason for one composable to import
// another.
//
// `getHeight` is the one place the two producers legitimately disagree, so it is
// a parameter rather than a hidden constant. The detail view has a probe cache
// (`getRealHeight` in `use-episode-list.ts`) that replaces the declared height
// with a measured one; the join path and the player have no such cache and read
// the declared `t.height`. The default is the declared height, so a caller that
// wants the measured one has to ask.
export type PlayerTranslationEntry = { id: number; label: string; type: string; height: number }

export function toPlayerTranslations(
  detail: { translations: Translation[] } | undefined,
  getHeight: (tr: Translation) => number = (tr) => tr.height
): PlayerTranslationEntry[] {
  if (!detail) return []
  return detail.translations
    .filter((t) => t.isActive === 1)
    .map((t) => ({ id: t.id, label: t.authorsSummary, type: t.type, height: getHeight(t) }))
}

// What one `goToEpisode` call did, as seen by whoever asked for it.
//
// `moved` means the `activeEpisodeIndex` write happened, and it is the ONLY
// outcome a multi-step walk may continue past. `unreachable` means the step
// failed on its own terms and the user has been told. `superseded` means the
// step was outranked — the component unmounted, or a newer run took ownership of
// `navigating` — which is not a failure and must stay silent.
export type EpisodeStepOutcome = 'moved' | 'unreachable' | 'superseded'

// The pure form of `PlayerView`'s `stepTowards` walk (#419). Extracted because
// the bug it fixes is invisible to a source scan and unreachable from a mount:
// `handleRemoteEpisodeChange` looped on three reactive terms only, and a step
// that released `navigating` without moving the index left all three true, so
// the walk re-entered forever. Every await on the way to that release resolved
// synchronously, so the microtask queue drained to exhaustion and the renderer
// froze with timers, input and rAF all starved.
//
// The outcome is the fourth term and the only one that can see the difference.
// The caller keeps its own three so a pick or an unmount still stops the walk
// through the route it already had.
//
// It deliberately does NOT toast. `goToEpisode` owns the message, because the
// buttons, the keyboard and auto-advance all need it at the site anyway, and a
// second one here would show two toasts for one stalled walk.
export async function walkEpisodeSteps(
  shouldStep: () => boolean,
  step: () => Promise<EpisodeStepOutcome>
): Promise<EpisodeStepOutcome | 'arrived'> {
  while (shouldStep()) {
    const outcome = await step()
    if (outcome !== 'moved') return outcome
  }
  return 'arrived'
}

// The follower's half of a both-press-next collision (#487). After a room
// follow commits N+1, `navigating` is released at the source swap, well before
// N+1's metadata loads, so a local Next pressed while the user is still looking
// at N would step from the already-committed N+1 to N+2: one episode skipped on
// both peers. `pending` is the index the last remote follow committed to, held
// until that source can show a frame (or a failure arm runs); a local Next while
// it still names `active` is the press the follow has already answered.
//
// Only a remote Next follow sets `pending`, and only the user-facing Next consults
// this — solo chained Next, Prev, auto-advance and the walk itself never do. The
// caller CONSUMES the token on a swallow, so a deliberate second press goes
// through and a follow that never loads cannot trap the user.
export function shouldSwallowLocalNext(pending: number | null, active: number): boolean {
  return pending !== null && pending === active
}

// How long the pending-follow token outlives the followed episode's first
// renderable frame (`loadeddata`) before a local Next counts as deliberate
// (#500). Clearing at `loadedmetadata` let a reflex press 190–590 ms later,
// made while the user still saw N, step to N+2. 600, not 500: on the
// two-instance rig `loadeddata` trails `loadedmetadata` by only 6–10 ms, so the
// grace alone has to cover the 590 ms press.
export const FOLLOW_GRACE_MS = 600

export type EpisodeResolutionTarget = {
  translations: PlayerTranslationEntry[]
  downloadedTrIds: number[]
}

export type EpisodeResolution =
  | {
      outcome: 'resolved'
      translation: PlayerTranslationEntry
      translations: PlayerTranslationEntry[]
      forceLocal: boolean
    }
  | { outcome: 'unreachable' }

// `goToEpisode`'s resolution chain (a)-(d), plus the on-demand fill that makes
// it work off the current page (#419).
//
// The chain itself is unchanged and is documented at docs/player.md's
// `## Episode Navigation` section: (a) any downloaded translation on the target
// — same id first, then same type by quality, then any downloaded — (b) the
// same translation id as a stream, (c) the best of the same type, (d) the first
// available. What changed is the list it runs over. `allEpisodes` names every
// filtered episode but sources `translations` from a map holding only the
// current 30-episode page, so every off-page entry arrived with
// `translations: []` while `downloadedTrIds` stayed populated from the
// anime-wide metadata — the one shape arm (a) cannot use, because it looks the
// downloaded ids up INSIDE the translation list. All four arms then read the
// empty array and nothing resolved.
//
// `fillTranslations` is injected rather than called directly so this stays pure
// and testable: `PlayerView` passes a cache-first page-window fetch. A rejection
// is `unreachable`, not a throw, because a network failure and "no translations"
// are the same outcome to the user and must leave by the same path — the walk
// in `walkEpisodeSteps` has to stop on either.
export async function resolveEpisodeTranslation(
  target: EpisodeResolutionTarget,
  current: { translationId: number | null; type: string },
  fillTranslations: () => Promise<PlayerTranslationEntry[]>
): Promise<EpisodeResolution> {
  let translations = target.translations
  if (translations.length === 0) {
    try {
      translations = await fillTranslations()
    } catch {
      return { outcome: 'unreachable' }
    }
  }
  const { downloadedTrIds } = target
  let resolvedTr: PlayerTranslationEntry | null = null
  let forceLocal = false

  // (a) Prefer any downloaded translation on the target episode
  if (downloadedTrIds.length > 0) {
    const sameIdDownloaded = translations.find(
      (t) => t.id === current.translationId && downloadedTrIds.includes(t.id)
    )
    if (sameIdDownloaded) {
      resolvedTr = sameIdDownloaded
    } else {
      const downloadedTrs = translations.filter((t) => downloadedTrIds.includes(t.id))
      const sameTypeDownloaded = downloadedTrs
        .filter((t) => t.type === current.type)
        .sort((a, b) => b.height - a.height)
      resolvedTr = sameTypeDownloaded[0] || downloadedTrs[0] || null
    }
    if (resolvedTr) forceLocal = true
  }

  // (b) Same translationId if available in the target episode (stream)
  if (!resolvedTr) {
    resolvedTr = translations.find((t) => t.id === current.translationId) || null
  }

  // (c) Best quality of the same type (stream)
  if (!resolvedTr) {
    const sameType = translations
      .filter((t) => t.type === current.type)
      .sort((a, b) => b.height - a.height)
    resolvedTr = sameType[0] || null
  }

  // (d) First available translation (stream)
  if (!resolvedTr) {
    resolvedTr = translations[0] || null
  }

  if (!resolvedTr) return { outcome: 'unreachable' }
  return { outcome: 'resolved', translation: resolvedTr, translations, forceLocal }
}
