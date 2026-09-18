// The scenario script both backends execute, and the trace it produces.
//
// A scenario is a flat list of steps. `wait(ms)` is a real `setTimeout` on both
// backends — see the note at the top of `wire-peer.ts` for why that is the one
// thing this suite is allowed to share with itself and why
// `test/helpers/syncplay-two-peer.ts` is not touched.

import { MinElectionServer } from '../../test/helpers/syncplay-min-election-server'
import { ModelTransport, Peer, RealTransport, type Announcement, type Playstate } from './wire-peer'

export type Step =
  | { kind: 'seat'; peer: string }
  | { kind: 'wait'; ms: number }
  /** `Set: {file: …}` — an object announces, `null` clears (`server.py:739-743`). */
  | { kind: 'setFile'; peer: string; file: Record<string, unknown> | null }
  /** A `Set` that carries no `file` key at all, which never reaches `setFile`. */
  | { kind: 'setWithoutFile'; peer: string }
  | { kind: 'state'; peer: string; position: number; paused?: boolean; doSeek?: boolean }
  | { kind: 'requestList'; peer: string }
  | { kind: 'sample'; label: string }

export interface Sample {
  label: string
  peer: string
  playstate: Playstate | null
  roster: Record<string, string | null> | null
  /** `Set: {user}` file relays that arrived since the previous sample, in order. */
  announcements: Announcement[]
}

export type Trace = Sample[]

export interface Scenario {
  /** Doubles as the room name, so it must fit `maxRoomNameLength: 35`. */
  name: string
  peers: string[]
  steps: Step[]
  /**
   * Whether the room ever leaves the paused state. A playing room's sampled
   * position depends on where the 1 Hz broadcast fell relative to the sample,
   * and the two backends' cadences are independently phased — see
   * `POSITION_TOLERANCE_PLAYING_S` in `trace-diff.ts`.
   */
  playing?: boolean
}

export interface RunResult {
  trace: Trace
  /** Verbatim frame logs, printed only when the comparison fails. */
  transcripts: string[]
  /** Every frame each peer received, verbatim, keyed by peer name. */
  inboundByPeer: Record<string, string[]>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const fileFrame = (file: Record<string, unknown> | null): unknown => ({ Set: { file } })

async function drive(
  scenario: Scenario,
  makePeer: (name: string) => Peer,
  room: string
): Promise<RunResult> {
  const peers = new Map<string, Peer>()
  for (const name of scenario.peers) peers.set(name, makePeer(name))
  const trace: Trace = []
  const need = (name: string): Peer => {
    const p = peers.get(name)
    if (!p) throw new Error(`scenario ${scenario.name} names an undeclared peer ${name}`)
    return p
  }

  try {
    for (const step of scenario.steps) {
      switch (step.kind) {
        case 'seat':
          await need(step.peer).seat(room)
          break
        case 'wait':
          await sleep(step.ms)
          break
        case 'setFile':
          need(step.peer).write(fileFrame(step.file))
          break
        case 'setWithoutFile':
          need(step.peer).write({ Set: { ready: { isReady: true, manuallyInitiated: false } } })
          break
        case 'state':
          need(step.peer).sendState(step)
          break
        case 'requestList':
          need(step.peer).requestList()
          break
        case 'sample':
          for (const name of scenario.peers) {
            const p = need(name)
            trace.push({
              label: step.label,
              peer: name,
              playstate: p.lastPlaystate,
              roster: p.lastRoster,
              announcements: p.takeAnnouncements()
            })
          }
          break
      }
    }
  } finally {
    for (const p of peers.values()) p.close()
  }

  const transcripts: string[] = []
  const inboundByPeer: Record<string, string[]> = {}
  for (const name of scenario.peers) {
    const p = need(name)
    inboundByPeer[name] = p.inbound.map((e) => e.raw)
    const lines = [
      ...p.inbound.map((e) => ({ ...e, dir: '<<' })),
      ...p.outbound.map((e) => ({ ...e, dir: '>>' }))
    ]
    lines.sort((a, b) => a.at - b.at)
    const t0 = lines.length > 0 ? lines[0].at : 0
    for (const l of lines)
      transcripts.push(`${String(l.at - t0).padStart(6)}ms ${name} ${l.dir} ${l.raw}`)
  }
  return { trace, transcripts, inboundByPeer }
}

/** Runs the scenario against the live `syncplay-server` on `port`. */
export async function runAgainstReal(scenario: Scenario, port: number): Promise<RunResult> {
  return await drive(scenario, (name) => new Peer(name, new RealTransport(port)), scenario.name)
}

/** Runs the same scenario against `MinElectionServer`, over in-memory sockets. */
export async function runAgainstModel(scenario: Scenario): Promise<RunResult> {
  // A fresh reference room is at `position: 0` and `Room.STATE_PAUSED`
  // (`server.py:543-547`), and `SERVER_STATE_INTERVAL` is 1 s — the model's own
  // defaults for the last two, but the room starts `paused: false` there, so it
  // is passed explicitly rather than inherited.
  const server = new MinElectionServer({ room: scenario.name, position: 0, paused: true })
  try {
    return await drive(
      scenario,
      (name) => new Peer(name, new ModelTransport(server, name)),
      scenario.name
    )
  } finally {
    server.stop()
  }
}
