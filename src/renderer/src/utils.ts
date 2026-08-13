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

// Slider seek helpers. Split into "preview" (drag in progress) and "commit"
// (mouseup) so the video element's `currentTime` is written only once per user
// gesture instead of once per drag tick. Each `video.currentTime = …` fires a
// `seeking` event that churns the MSE pipeline, which on Linux/WSL has been
// observed to cause repeated `readyState=1` stalls and audio dropout (#127).
export function previewSeek(rawValue: string, currentTime: { value: number }): number {
  const time = parseFloat(rawValue)
  if (!isFinite(time)) return currentTime.value
  currentTime.value = time
  return time
}

export function commitSeek(time: number, video: { currentTime: number } | null | undefined): void {
  if (!video) return
  if (!isFinite(time)) return
  video.currentTime = time
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
  if (typeof roomPosition === 'number' && Number.isFinite(roomPosition) && roomPosition >= 0) {
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
