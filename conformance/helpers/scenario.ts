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
  /**
   * A `State` with a `ping` and the counter the server last handed this peer,
   * and no `playstate` key — `sendAck()`'s shape. `state` cannot express it:
   * its `position` is mandatory, here and in `Peer.sendState`.
   */
  | { kind: 'pingOnly'; peer: string }
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
  /**
   * Peers that do **not** answer a forced update with an automatic
   * acknowledgement. Everything else does, because that is what a conforming
   * client does; a scenario that drives the acknowledgement by hand names its
   * peer here. See `ackForcedUpdates` on `Peer` for what turning it off costs.
   */
  manualAckPeers?: string[]
  /**
   * `PROTOCOL_TIMEOUT` as a modelled disconnect, in milliseconds, or `null`/absent
   * for a model that never drops anyone. Only the **model** backend reads this:
   * the real server has the behaviour unconditionally and at its own constant, so
   * a scenario that sets this to anything but `PROTOCOL_TIMEOUT_MS` is asking the
   * two backends a different question and is sweeping rather than comparing.
   *
   * Absent by default, which keeps every scenario written before #384's item 4
   * running against the model it was written against.
   */
  protocolTimeout?: number | null
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
        case 'pingOnly':
          need(step.peer).sendPingOnly()
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

/**
 * `manualAckPeers` resolved for one peer. Exported only so
 * `test/conformance-harness.test.ts` can assert it from the PR gate: getting
 * this backwards would turn every scenario's peers silent rather than red, and
 * `conformance/` itself runs nightly.
 */
export const peerOptions = (scenario: Scenario, name: string): { ackForcedUpdates: boolean } => ({
  ackForcedUpdates: !(scenario.manualAckPeers ?? []).includes(name)
})

/**
 * The model-side options a scenario asks for, resolved. Exported and pinned from
 * the PR gate for exactly `peerOptions`'s reason, and the failure here is the
 * quieter of the two: a resolver that dropped `protocolTimeout` on the floor
 * leaves `conf-timeout-idle-drop` comparing a dropping server against a model
 * that never drops — which is the **red** that scenario was first run in, so it
 * at least fails loudly. A resolver that turned the option on for *every*
 * scenario is the inert direction, and `conformance/` runs nightly only.
 *
 * `room`, `position` and `paused` are not scenario-settable and are stated here
 * rather than at the construction site: a fresh reference room is `position: 0`
 * and `Room.STATE_PAUSED` (`server.py:543-547`), and the room name is the
 * scenario name because the suite gives every scenario its own room.
 */
export const modelOptions = (
  scenario: Scenario
): { room: string; position: number; paused: boolean; protocolTimeoutMs: number | null } => ({
  room: scenario.name,
  position: 0,
  paused: true,
  protocolTimeoutMs: scenario.protocolTimeout ?? null
})

/** Runs the scenario against the live `syncplay-server` on `port`. */
export async function runAgainstReal(scenario: Scenario, port: number): Promise<RunResult> {
  return await drive(
    scenario,
    (name) => new Peer(name, new RealTransport(port), peerOptions(scenario, name)),
    scenario.name
  )
}

/** Runs the same scenario against `MinElectionServer`, over in-memory sockets. */
export async function runAgainstModel(scenario: Scenario): Promise<RunResult> {
  // Through `modelOptions()` rather than built here, so the PR gate can assert the
  // resolution without a server: `SERVER_STATE_INTERVAL` is 1 s and that is the
  // model's own default, but the room starts `paused: false` there, so the pause
  // flag is passed explicitly rather than inherited.
  const server = new MinElectionServer(modelOptions(scenario))
  try {
    return await drive(
      scenario,
      (name) => new Peer(name, new ModelTransport(server, name), peerOptions(scenario, name)),
      scenario.name
    )
  } finally {
    server.stop()
  }
}
