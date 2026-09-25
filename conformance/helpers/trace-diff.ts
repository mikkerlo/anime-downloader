// The comparison: two traces, one verdict, and an ignore list that has to earn
// its keep.
//
// #367's rule is a **field-level** ignore list — each entry naming the seam it
// belongs to — rather than a blanket tolerance, "because a blanket tolerance
// hides the divergences the suite exists to find". A list of strings in a
// comment would not be that: nothing stops the reference growing a field nobody
// listed, which then goes uncompared in silence. So the list is checked against
// the wire. `unlistedFieldPaths()` walks every frame the real server actually
// sent and returns anything that is neither compared nor ignored, and
// `syncplay-field-coverage.conformance.ts` pins that to empty. Adding a field to
// the reference — or to the model — reds the suite until someone decides which
// half of the list it belongs in.

import type { Announcement, Playstate } from './wire-peer'
import type { Trace } from './scenario'

/**
 * Sampled positions in a **paused** room, where the reference freezes the
 * playhead outright: `Watcher.getPosition()` (`server.py:780-787`) adds wall
 * time only while the *room* is playing, and `_updatePositionByAge`
 * (`server.py:870-873`) leaves an explicitly-paused frame's position alone. Both
 * backends therefore report the stored number verbatim, and the only slack
 * needed is the JSON float round-trip.
 *
 * Measured across the paused scenarios in this suite: the largest |real − model|
 * observed was 0.000 s. 0.05 s is two orders of magnitude above that and still
 * fifty times smaller than the smallest gap any scenario here turns on (the
 * all-fileless election separates 500 from 700), so a divergence this band
 * cannot see is not one any of these scenarios could have produced.
 */
export const POSITION_TOLERANCE_PAUSED_S = 0.05

/**
 * Sampled positions in a **playing** room. A sample reads the most recent
 * broadcast each peer received, and the two backends' broadcast cadences are
 * independently phased: the reference schedules one `LoopingCall` per watcher
 * (`server.py:841-843`, armed by `Watcher.__init__`'s last line 0.1 s after
 * connection, `server.py:737`), the model one shared `setInterval`. The sampled
 * frame can therefore be anything from fresh to a full `SERVER_STATE_INTERVAL`
 * old on either side, and in a playing room that age is position.
 *
 * Measured across the playing scenarios in this suite, over four full runs: the
 * largest |real − model| observed was 1.102 s, which is the 1 s interval plus
 * the reference's own `LoopingCall` jitter; typical runs sit between 0.129 s and
 * 0.503 s. 1.60 s carries the worst case with room to spare while still being
 * far smaller than the divergences these scenarios are built around (the
 * smallest is 200 s). It is **not** a band for detecting sub-second mismatches:
 * nothing at this tolerance can see the `messageAge` or `forwardDelay` terms,
 * which is one of the reasons those are recorded as unreachable in
 * `conformance/README.md` rather than tested here. Every run prints its own
 * figure — see the `[conformance]` line in `conform.ts`.
 */
export const POSITION_TOLERANCE_PLAYING_S = 1.6

export interface IgnoreEntry {
  /** A dotted path into an inbound frame. A trailing `.*` matches the subtree. */
  path: string
  /** Why this field is not compared, named as a seam rather than as noise. */
  seam: string
}

/** Field paths the comparison actually reads. Everything else must be ignored. */
export const COMPARED_FIELD_PATHS: readonly string[] = [
  'State.playstate.position',
  'State.playstate.paused',
  'State.playstate.doSeek',
  'State.playstate.setBy',
  'Set.user.[].file',
  'Set.user.[].file.name',
  'List.[].[].file',
  'List.[].[].file.name'
]

/**
 * Every field the reference puts on the wire that the comparison does **not**
 * read. Each entry says which seam it belongs to; `ignoringOnTheFly` is first
 * because it is the one the model's own header calls out as deliberately
 * unmodelled.
 */
export const IGNORED_FIELDS: readonly IgnoreEntry[] = [
  {
    path: 'State.ignoringOnTheFly.*',
    seam: 'The ignore window, which the model declares unmodelled in its header and implements as a bare counter stamp — `test/helpers/syncplay-min-election-server.ts:788` is the whole of it, and the window itself never runs — while `test/services/syncplay-ignoring-on-the-fly.test.ts` owns the seam frame by frame. Comparing the counters here would assert parity for a mechanism one side does not implement.'
  },
  {
    path: 'State.ping.latencyCalculation',
    seam: "The server's own send stamp, `time.time()` at broadcast. Wall-clock by construction; the two backends cannot agree on it and nothing in this suite reads it."
  },
  {
    path: 'State.ping.clientLatencyCalculation',
    seam: "The echo of our own stamp, carrying the hold correction. It is a real modelled behaviour (`echoHoldCorrection`), but the quantity it carries is a wall-clock duration rather than a frame value, and on loopback the correction it would have to show is smaller than the clock's own noise. `conformance/README.md` records it under the unreachable, latency-shaped observables; `test/services/syncplay-two-peer-rtt.test.ts` owns it where a link delay can be injected."
  },
  {
    path: 'State.ping.serverRtt',
    seam: "The server's RTT estimate. ~0 on loopback on both sides, which is exactly why the latency scenarios are out of this suite's reach."
  },
  {
    path: 'Set.ready.*',
    seam: 'Readiness. The suite runs `--disable-ready`; the reference still emits a `Set: {ready}` on join and the model emits none. `test/services/syncplay-two-peer-loop.test.ts` owns readiness against the model.'
  },
  {
    path: 'Set.playlistChange.*',
    seam: 'Shared playlists, which this client declares `sharedPlaylists: false` for (`src/main/syncplay.ts:2268`) and the model does not implement at all.'
  },
  {
    path: 'Set.playlistIndex.*',
    seam: 'Shared playlists, as above.'
  },
  {
    path: 'Set.user.[].event.*',
    seam: "`sendJoinMessage` (`server.py:168-173`). A join notice, not a file relay: the model stands a fresh `List` in for it, and `applySet`'s comment says so. The suite compares the relay (`Set.user.[].file`) and the roster instead."
  },
  {
    path: 'Set.user.[].room.name',
    seam: "The relay's room echo. Every peer in every scenario here is seated into the one room the scenario names, so the field is a constant on both sides and carries no discrimination."
  },
  {
    path: 'Set.user.[].file.duration',
    seam: 'File metadata. `__lt__` (`server.py:834-839`) reads `self._file is None` and nothing inside it, so duration takes no part in the election; the model synthesises a constant.'
  },
  {
    path: 'Set.user.[].file.size',
    seam: 'File metadata, as above.'
  },
  {
    path: 'List.[].[].position',
    seam: 'Literal `0` in the reference (`protocols.py:694`) regardless of the watcher, so it is a constant rather than an observable.'
  },
  {
    path: 'List.[].[].controller',
    seam: 'Managed rooms. `ControlledRoom` (`server.py:675`) is out of the model by declaration; this client declares `managedRooms: false`.'
  },
  {
    path: 'List.[].[].isReady',
    seam: "Readiness, as above — and the reference can answer `null` (never set) where the model's `Watcher.ready` is a non-nullable boolean defaulting to `true`."
  },
  {
    path: 'List.[].[].features.*',
    seam: "The peer's declared feature set, echoed back from its own `Hello`. The model synthesises no feature block; `test/services/syncplay-*` covers feature declaration against fixtures."
  },
  {
    path: 'List.[].[].file.duration',
    seam: 'File metadata, as above.'
  },
  {
    path: 'List.[].[].file.size',
    seam: 'File metadata, as above.'
  },
  {
    path: 'Hello.*',
    seam: 'The handshake reply. Version, server features and MOTD: a connection-level negotiation rather than a room observable, and `test/services/syncplay-handshake*.test.ts` owns it.'
  },
  {
    path: 'TLS.*',
    seam: 'The TLS probe reply. The suite runs plaintext on loopback by construction, so this is always `"false"` against the real server and `"true"` against the model, which has no TLS to decline.'
  }
]

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Frame paths whose child keys are usernames or room names rather than field
 * names. They collapse to `[]` so the list stays a list of fields.
 */
const KEYED_BY_NAME = new Set(['List', 'List.[]', 'Set.user'])

function walk(value: unknown, prefix: string, out: Set<string>): void {
  if (!isRecord(value)) {
    out.add(prefix)
    return
  }
  const keys = Object.keys(value)
  if (keys.length === 0) {
    out.add(prefix)
    return
  }
  for (const key of keys) {
    const seg = KEYED_BY_NAME.has(prefix) ? '[]' : key
    walk(value[key], prefix ? `${prefix}.${seg}` : seg, out)
  }
}

/** Every dotted field path present in these raw frames. */
export function observedFieldPaths(rawFrames: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const raw of rawFrames) {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      continue
    }
    walk(msg, '', out)
  }
  return out
}

/**
 * Whether a set of observed leaf paths reaches `path`.
 *
 * `observedFieldPaths()` returns **leaves**, and a compared path is not always
 * one. `Set.user.[].file` is a subtree on the reference's wire and never its own
 * leaf: `sendUserSetting` (`protocols.py:682-683`) writes the key only when the
 * file is truthy, so a cleared or empty file omits `file` altogether rather than
 * sending `null` or `{}`. Measured on the wide scenario, seven of the eight
 * compared paths arrive as exact leaves and that one arrives only as the parent
 * of `Set.user.[].file.name`. (`List.[].[].file` does land as a leaf, because
 * `_addUserOnList` (`protocols.py:695`) substitutes `{}` rather than omitting
 * the key — the two renderings differ, which is itself why both are compared.)
 * So a path counts as reached when it is observed exactly or when an observed
 * leaf sits underneath it.
 *
 * The match is anchored and segment-wise, and that is the whole difference from
 * the first-and-last-substring test this replaces: a
 * `Set: {user: {…: {room: {name: …}}}}` join notice observes
 * `Set.user.[].room.name` and reaches neither `Set.user.[].file` nor
 * `Set.user.[].file.name`, where the substring test accepted both on the
 * strength of `"Set"` and `"name"` appearing somewhere in the frame.
 * `test/conformance-harness.test.ts` pins that case in the PR gate, since this
 * file's own suite runs only in the nightly.
 */
export function reachesFieldPath(observed: ReadonlySet<string>, path: string): boolean {
  if (observed.has(path)) return true
  for (const seen of observed) if (seen.startsWith(path + '.')) return true
  return false
}

function listed(path: string, list: readonly string[]): boolean {
  for (const entry of list) {
    if (entry.endsWith('.*')) {
      const head = entry.slice(0, -2)
      if (path === head || path.startsWith(head + '.')) return true
    } else if (entry === path) {
      return true
    }
  }
  return false
}

/**
 * The paths in these frames that are neither compared nor ignored. Empty is the
 * assertion; a non-empty result is a field the reference sends that nobody has
 * decided about.
 */
export function unlistedFieldPaths(rawFrames: readonly string[]): string[] {
  const compared = [...COMPARED_FIELD_PATHS]
  const ignored = IGNORED_FIELDS.map((e) => e.path)
  return [...observedFieldPaths(rawFrames)]
    .filter((p) => !listed(p, compared) && !listed(p, ignored))
    .sort()
}

export interface Divergence {
  label: string
  peer: string
  field: string
  real: unknown
  model: unknown
}

function diffPlaystate(
  real: Playstate | null,
  model: Playstate | null,
  tolerance: number,
  push: (field: string, r: unknown, m: unknown) => void
): void {
  if (real === null || model === null) {
    if (real !== model) push('playstate', real, model)
    return
  }
  if (real.setBy !== model.setBy) push('playstate.setBy', real.setBy, model.setBy)
  if (real.paused !== model.paused) push('playstate.paused', real.paused, model.paused)
  if (real.doSeek !== model.doSeek) push('playstate.doSeek', real.doSeek, model.doSeek)
  if (Math.abs(real.position - model.position) > tolerance) {
    push('playstate.position', real.position, model.position)
  }
}

function diffAnnouncements(
  real: Announcement[],
  model: Announcement[],
  push: (field: string, r: unknown, m: unknown) => void
): void {
  const key = (a: Announcement[]): string => JSON.stringify(a)
  if (key(real) !== key(model)) push('announcements', real, model)
}

function diffRoster(
  real: Record<string, string | null> | null,
  model: Record<string, string | null> | null,
  push: (field: string, r: unknown, m: unknown) => void
): void {
  const key = (r: Record<string, string | null> | null): string =>
    r === null ? 'null' : JSON.stringify(Object.fromEntries(Object.entries(r).sort()))
  if (key(real) !== key(model)) push('roster', real, model)
}

/** Compares two traces sample for sample. An empty result is agreement. */
export function diffTraces(real: Trace, model: Trace, tolerance: number): Divergence[] {
  const out: Divergence[] = []
  if (real.length !== model.length) {
    out.push({
      label: '(trace)',
      peer: '(all)',
      field: 'sample count',
      real: real.length,
      model: model.length
    })
    return out
  }
  for (let i = 0; i < real.length; i++) {
    const r = real[i]
    const m = model[i]
    if (r.label !== m.label || r.peer !== m.peer) {
      out.push({ label: r.label, peer: r.peer, field: 'sample identity', real: r, model: m })
      continue
    }
    const push = (field: string, rv: unknown, mv: unknown): void => {
      out.push({ label: r.label, peer: r.peer, field, real: rv, model: mv })
    }
    diffPlaystate(r.playstate, m.playstate, tolerance, push)
    diffAnnouncements(r.announcements, m.announcements, push)
    diffRoster(r.roster, m.roster, push)
  }
  return out
}

/**
 * The largest |real − model| sampled position across a pair of traces, in
 * seconds, or `null` if no sample had a position on both sides.
 *
 * This is what the two `POSITION_TOLERANCE_*` constants are set from. It is
 * computed on every run and printed in the report header, so the numbers quoted
 * in those constants' comments stay checkable against a run rather than being
 * prose that was true once.
 */
export function maxPositionDelta(real: Trace, model: Trace): number | null {
  let worst: number | null = null
  const n = Math.min(real.length, model.length)
  for (let i = 0; i < n; i++) {
    const r = real[i].playstate
    const m = model[i].playstate
    if (r === null || m === null) continue
    const d = Math.abs(r.position - m.position)
    if (worst === null || d > worst) worst = d
  }
  return worst
}

/** A divergence list rendered for a failure message. */
export function formatDivergences(divergences: readonly Divergence[]): string {
  return divergences
    .map(
      (d) =>
        `  [${d.label}] ${d.peer}.${d.field}: real=${JSON.stringify(d.real)} model=${JSON.stringify(d.model)}`
    )
    .join('\n')
}
