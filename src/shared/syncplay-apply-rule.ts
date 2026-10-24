// The Syncplay apply rule: whether a remote state moves our playhead (#524).
//
// One predicate, called from both processes. The renderer enacts it in
// `applyRemoteStateToElement()` against the element's `currentTime`; main
// arms its echo target with it in `handleState()` against its projection of
// our last snapshot. The echo target is the #220 belt: it swallows the
// `seeked` an applied seek fires if the renderer's own value-keyed operation
// has already let go of it. So main has to answer "will the renderer seek?"
// with the renderer's own rule, or the belt silently stops covering the seeks
// the renderer makes. Before #524 the two sides each carried a copy of the 3 s
// literal; this file is what keeps them one rule.

// A "seek" this close to where the room already is didn't come from the user —
// it's the element finishing the seek we applied from the room, arriving after
// the renderer's own seek operation stopped waiting for it (TTL expiry, or an
// eviction from the operation registry). Tight on purpose: a real user seek
// lands somewhere else, and a real seek to within half a second of the room's
// own position is a no-op for everyone anyway. This is the backstop for the
// renderer's value-keyed registry, not for any wall-clock window — the renderer
// has had none since #304.
//
// Since #524 it is also the pause edge's tolerance, for the same reason: under
// half a second there is nothing worth moving the element for.
export const ECHO_SEEK_EPSILON_S = 0.5

// How far the room may be from us before an ordinary state (a periodic, or a
// pause that reaches an element already paused) moves the playhead. Loose on
// purpose: a periodic is up to one heartbeat and one snapshot push old by the
// time it is compared, so anything tighter would seek a playing peer back and
// forth every second.
export const APPLY_TOLERANCE_S = 3.0

export interface ApplyRuleInput {
  /** The frame carries the server's `doSeek`: a peer's deliberate seek. */
  doSeek: boolean
  /** `|our position − the frame's position|`, in seconds. */
  diff: number
  /** The frame says `paused` and we are still playing: the room's pause has
   *  just reached us. */
  pauseEdge: boolean
}

/** Whether applying a remote state seeks us to its position.
 *
 *  A `doSeek` frame always does: last writer wins. A pause edge seeks past
 *  `ECHO_SEEK_EPSILON_S`, which is upstream's `SYNC_ON_PAUSE` with our echo
 *  tolerance on top: the reference client seeks to the room's position on every
 *  foreign pause, in `_serverPaused`:
 *  client.py:376 ("if constants.SYNC_ON_PAUSE and self.getUsername() != setBy:")
 *  so two peers end a pause on the same frame however late the pause reached
 *  either. Without it a pause
 *  that reaches a playing peer 0.5–3 s late leaves the two paused that far
 *  apart, and nothing pulls them together again. Everything else seeks only
 *  past `APPLY_TOLERANCE_S`. */
export function wouldSeekOnApply({ doSeek, diff, pauseEdge }: ApplyRuleInput): boolean {
  return doSeek || diff > (pauseEdge ? ECHO_SEEK_EPSILON_S : APPLY_TOLERANCE_S)
}
