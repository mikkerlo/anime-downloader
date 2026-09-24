// The conformance harness's own seams, asserted from the PR gate.
//
// `conformance/` is deliberately outside the default run — `vitest.config.ts`
// includes `test/**` and `src/**` only, and `vitest.conformance.config.ts` is a
// separate config pointed at a separate directory — so nothing under it is
// exercised by a pull request. That is right for the scenarios, which need a
// provisioned Syncplay server and four minutes. It is wrong for the two pieces
// below, which need neither and which decide whether a nightly run means
// anything: the guard that says a missing server is an error rather than a pass,
// and the predicate the field-coverage assertion is built on.
//
// #392 added a third kind: the `manualAckPeers` / `sendPingOnly` seams. Same
// rationale, with one more turn of the screw. The one scenario that drives them
// does not compare the two backends for agreement: it holds a **pinned expected
// divergence** until #384's item 4 moves the model's stamp. That pin does fail
// in both directions — a `sendPingOnly` that dropped its counter makes both
// backends inert together, which reads as agreement, which the pin rejects as a
// stale pin — but it fails a night later, on a machine with a provisioned server
// and four minutes to spend. Neither of the seams below needs a server, a socket
// or a wait, so they belong on the gate that actually runs on a pull request.

import { describe, expect, it } from 'vitest'
import {
  assertPinnedDivergence,
  type ConformanceRun,
  type PinnedDivergence
} from '../conformance/helpers/conform'
import { bootRealServer, connects, freePort } from '../conformance/helpers/real-server'
import {
  COMPARED_FIELD_PATHS,
  reachesFieldPath,
  type Divergence
} from '../conformance/helpers/trace-diff'
import { peerOptions, type Scenario } from '../conformance/helpers/scenario'
import { Peer, type Transport } from '../conformance/helpers/wire-peer'

describe('conformance harness: freePort hands out a port nothing answers on', () => {
  it('returns a port that is already refusing, not one still answering', async () => {
    // `close()`'s callback is not the end of a listening socket's life: for a
    // window after it fires the kernel still completes the handshake on that
    // port. Measured here at 7-11 ms, answering forty-odd consecutive connects.
    //
    // That window is where `waitForListen()` takes its first sample, a few
    // hundred microseconds after `spawn`. Left open it means "the server is up"
    // can be satisfied by the probe socket the harness itself just closed —
    // which let a run start its first scenario against a server that had not
    // bound yet and fail all five of that file's tests with `ECONNREFUSED`
    // while the rest of the suite passed. Observed once on this tree.
    //
    // Ten ports rather than one: the window is short enough that a single
    // sample could miss it by luck and report a guard that is not there.
    for (let i = 0; i < 10; i++) {
      const port = await freePort()
      expect({ port, answering: await connects(port) }).toEqual({ port, answering: false })
    }
  })
})

describe('conformance harness: a missing server is an error', () => {
  it('fails fast and names ENOENT rather than timing out', async () => {
    // The header of `real-server.ts` promises this **throws** rather than
    // skipping, because a conformance suite that reports "0 passed" on a runner
    // with no server would still be cited as warrant for the model.
    //
    // It did not. Two bugs stacked: `spawn` reports a missing binary
    // asynchronously on `error`, which nothing was watching, and `freePort()`
    // handed out a port whose probe socket still completed handshakes for ~10 ms
    // after `close()` — so `waitForListen()`'s first sample connected to the
    // probe's own corpse and `bootRealServer()` *resolved*, in 9 ms, with
    // `SYNCPLAY_SERVER_BIN=/nonexistent`. Every scenario then failed with
    // `ECONNREFUSED`, which reads as a dead reference rather than as a
    // misconfigured one.
    const prev = process.env.SYNCPLAY_SERVER_BIN
    process.env.SYNCPLAY_SERVER_BIN = '/nonexistent/syncplay-server'
    const t0 = Date.now()
    try {
      await expect(bootRealServer()).rejects.toThrow(/could not spawn .*ENOENT/)
    } finally {
      if (prev === undefined) delete process.env.SYNCPLAY_SERVER_BIN
      else process.env.SYNCPLAY_SERVER_BIN = prev
    }
    // Well inside `waitForListen()`'s 20 s, which is the timeout this used to
    // spend before saying something less useful. Generous enough not to flake on
    // a loaded runner; the point is the order of magnitude.
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('conformance harness: reachesFieldPath', () => {
  // The frame shapes below are the reference's, as `observedFieldPaths()` would
  // render them: `Set.user` is keyed by username, which collapses to `[]`.
  const joinNotice = new Set([
    'Set.user.[].room.name',
    'Set.user.[].event.joined',
    'Set.user.[].event.version'
  ])

  it('rejects a join notice for a file path — the case the old check passed', () => {
    // The regression this exists for. The previous predicate tested the first
    // and last segment as independent substrings anywhere in the raw frame, so
    // `Set.user.[].file.name` was satisfied by any frame containing `"Set"` and
    // `"name"`. A join notice contains both — in `Set` and in `room.name` — and
    // carries no `file` at all, so the suite reported that it had reached a
    // field it had never seen.
    expect(reachesFieldPath(joinNotice, 'Set.user.[].file.name')).toBe(false)
    expect(reachesFieldPath(joinNotice, 'Set.user.[].file')).toBe(false)
  })

  it('reaches a subtree path through a leaf underneath it', () => {
    // `Set.user.[].file` is never its own leaf on the reference's wire:
    // `sendUserSetting` (`protocols.py:682-683`) writes the key only when the
    // file is truthy. It is reached by the relay that carries a real file.
    const relay = new Set(['Set.user.[].room.name', 'Set.user.[].file.name'])
    expect(reachesFieldPath(relay, 'Set.user.[].file')).toBe(true)
    expect(reachesFieldPath(relay, 'Set.user.[].file.name')).toBe(true)
  })

  it('matches on whole segments, not on a shared prefix', () => {
    // `file` must not be reached by `filename`; the separator is part of the
    // test rather than a `startsWith` on the bare string.
    expect(reachesFieldPath(new Set(['Set.user.[].filename']), 'Set.user.[].file')).toBe(false)
  })

  it('reds on a misspelled compared path', () => {
    // The mutation control for the guard's stated purpose: a compared path that
    // no longer names anything on the wire has to be reported unreached.
    const state = new Set([
      'State.playstate.position',
      'State.playstate.paused',
      'State.playstate.doSeek',
      'State.playstate.setBy'
    ])
    expect(reachesFieldPath(state, 'State.playstate.position')).toBe(true)
    expect(reachesFieldPath(state, 'State.playstate.postion')).toBe(false)
  })

  it('leaves no compared path reachable from an empty observation', () => {
    // A run that collected nothing must not report full coverage.
    const none = new Set<string>()
    expect(COMPARED_FIELD_PATHS.filter((p) => reachesFieldPath(none, p))).toEqual([])
  })
})

/**
 * A `Transport` with nothing behind it: `connect()` resolves, `send()` records,
 * and `push()` hands one frame to whatever `Peer.seat()` registered — the same
 * shape `RealTransport.absorb` calls the callback with. Every seam below is a
 * synchronous decision about a single frame, so there is nothing for a server to
 * do and nothing to wait for.
 */
class StubTransport implements Transport {
  readonly sent: string[] = []
  private cb: ((raw: string) => void) | null = null

  connect(): Promise<void> {
    return Promise.resolve()
  }

  send(raw: string): void {
    this.sent.push(raw)
  }

  onLine(cb: (raw: string) => void): void {
    this.cb = cb
  }

  close(): void {
    this.cb = null
  }

  push(obj: unknown): void {
    this.cb?.(JSON.stringify(obj))
  }

  /** Frames sent since `mark`, parsed. `seat()`'s Hello is what `mark` skips. */
  since(mark: number): Array<Record<string, any>> {
    return this.sent.slice(mark).map((raw) => JSON.parse(raw) as Record<string, any>)
  }
}

/** A forced broadcast as the reference renders it: playstate, ping, counter. */
const forcedState = (counter: number): unknown => ({
  State: {
    playstate: { position: 1200, paused: false, doSeek: true, setBy: 'bravo' },
    ping: { latencyCalculation: 1, serverRtt: 0 },
    ignoringOnTheFly: { server: counter }
  }
})

const seated = async (
  name: string,
  options: { ackForcedUpdates?: boolean }
): Promise<{ peer: Peer; t: StubTransport; mark: number }> => {
  const t = new StubTransport()
  const peer = new Peer(name, t, options)
  await peer.seat('conf-stub')
  return { peer, t, mark: t.sent.length }
}

describe('conformance harness: peerOptions resolves manualAckPeers', () => {
  const scenario = (manualAckPeers?: string[]): Scenario => ({
    name: 'conf-stub',
    peers: ['alpha', 'bravo'],
    steps: [],
    ...(manualAckPeers === undefined ? {} : { manualAckPeers })
  })

  it('acks by default, because a peer that does not ack is not a conforming client', () => {
    // The default carries every scenario but one. Without the ack
    // `protocols.py:761` stops the reference sending that watcher its periodic
    // `State` at all, so its last playstate freezes at the seek and the suite
    // reports the reference's silence as a model divergence — measured at 1.8 s
    // and a flipped `setBy`, per `conformance/README.md`.
    expect(peerOptions(scenario(), 'alpha')).toEqual({ ackForcedUpdates: true })
  })

  it('turns acking off for a named peer and leaves its room-mate alone', () => {
    // Both halves, because a sense inversion here fails silently in either
    // direction: the named peer would ack and collapse the wait
    // `conf-forced-ping-stamps` measures, the unnamed one would go quiet and
    // produce the divergence above, and both read as a model bug.
    const s = scenario(['alpha'])
    expect(peerOptions(s, 'alpha')).toEqual({ ackForcedUpdates: false })
    expect(peerOptions(s, 'bravo')).toEqual({ ackForcedUpdates: true })
  })

  it('acks for every peer when the list is present but empty', () => {
    // The `?? []` arm reached from the other side: a declared-but-empty list
    // must not be the same thing as naming everyone.
    expect(peerOptions(scenario([]), 'alpha')).toEqual({ ackForcedUpdates: true })
  })
})

describe('conformance harness: a manual-ack peer captures the counter anyway', () => {
  it('sends no ack, and still echoes the captured counter on sendPingOnly', async () => {
    const { peer, t, mark } = await seated('alpha', { ackForcedUpdates: false })
    t.push(forcedState(7))
    // Half one: silence. An automatic ack would stamp `_lastUpdatedOn` at the
    // instant the forced update arrived, collapsing the very wait
    // `conf-forced-ping-stamps` is built on, and would carry a full playstate
    // besides — the opposite of the frame under test.
    expect(t.since(mark)).toEqual([])
    // Half two: the counter was captured regardless. These two are easy to fuse
    // by accident, and fusing them is not a weaker test but an empty one — the
    // hand-driven frame would carry no counter, the reference would discard it
    // at `protocols.py:788`, the model has no ignore window to discard it with,
    // and `trace-diff` would report agreement on nothing happening.
    peer.sendPingOnly()
    const [ping] = t.since(mark)
    expect(ping.State.ignoringOnTheFly).toEqual({ server: 7 })
    expect('playstate' in ping.State).toBe(false)
  })

  it('echoes the newest counter, not the first one it saw', async () => {
    // A second forced update increments past the first, and
    // `protocols.py:775-777` clears the ignore window only on an exact match, so
    // a peer that kept the first counter it ever saw would echo one that no
    // longer matches and die at `protocols.py:788` exactly as a counter-less
    // frame does.
    const { peer, t, mark } = await seated('alpha', { ackForcedUpdates: false })
    t.push(forcedState(7))
    t.push(forcedState(8))
    peer.sendPingOnly()
    expect(t.since(mark)[0].State.ignoringOnTheFly).toEqual({ server: 8 })
  })

  it('still acks when the gate is left on, so the silence above is the gate', async () => {
    // The control. Same frame, default options, and an ack goes out — without
    // it the `toEqual([])` above would pass just as well on a `Peer` that had
    // stopped acking altogether.
    const { t, mark } = await seated('bravo', {})
    t.push(forcedState(7))
    const acks = t.since(mark)
    expect(acks.length).toBe(1)
    expect(acks[0].State.ignoringOnTheFly).toEqual({ server: 7 })
    // Acking a seek is not requesting one.
    expect(acks[0].State.playstate.doSeek).toBe(false)
  })
})

describe('conformance harness: sendPingOnly refuses a counter-less frame', () => {
  it('throws rather than sending the frame without one', async () => {
    // Refusing is the point rather than defensiveness. A counter-less
    // playstate-free frame is discarded by the reference inside the ignore
    // window and inert in the model, so both backends go inert together — the
    // one failure mode in `conf-forced-ping-stamps` that reads as evidence.
    const { peer, t, mark } = await seated('alpha', { ackForcedUpdates: false })
    expect(() => peer.sendPingOnly()).toThrow(/never received/)
    expect(t.since(mark)).toEqual([])
  })

  it('treats a zero counter as none, which is the only value the reference omits', async () => {
    // `protocols.py:756-757` writes `ignoringOnTheFly.server` only when the
    // counter is non-zero, so `{server: 0}` is not a frame the reference
    // produces; echoing a zero would clear nothing at `protocols.py:775-777`
    // and the throw is the honest outcome.
    const { peer, t } = await seated('alpha', { ackForcedUpdates: false })
    t.push({
      State: {
        playstate: { position: 500, paused: false, doSeek: false, setBy: 'bravo' },
        ignoringOnTheFly: { server: 0 }
      }
    })
    expect(() => peer.sendPingOnly()).toThrow(/never received/)
  })
})

// The predicate that decides whether the pinned scenario means anything, on the
// gate for the reason the header gives: it takes a `ConformanceRun` literal, so
// there is no server, socket or wait, and every case below would otherwise wait
// a night to be asked.
describe('conformance harness: assertPinnedDivergence', () => {
  // The figures are `conf-forced-ping-stamps`'s own, so a case that reds here
  // reds there: `playing: true` selects the ±1.6 s tolerance, the ceiling is
  // `PING_WAIT_MS / 1000 + tolerance`, and 3.907 s is what the run measured.
  const SAMPLE = "alpha's ping-only frame re-elects the room"
  const REPORT = 'scenario "conf-forced-ping-stamps" — 2 divergence(s)\n--- real server ---\n…'

  const PIN: PinnedDivergence = {
    label: SAMPLE,
    fields: ['playstate.setBy', 'playstate.position'],
    setBy: { real: 'alpha', model: 'bravo' },
    positionDeltaCeiling: 4000 / 1000 + 1.6
  }

  const divergence = (over: Partial<Divergence> = {}): Divergence => ({
    label: SAMPLE,
    peer: 'alpha',
    field: 'playstate.setBy',
    real: 'alpha',
    model: 'bravo',
    ...over
  })

  const positionDiverged = divergence({ field: 'playstate.position', real: 1204, model: 1200 })

  // The pinned shape, so each case below states only the one thing it changes.
  const run = (over: Partial<ConformanceRun> = {}): ConformanceRun => ({
    divergences: [divergence(), positionDiverged],
    tolerance: 1.6,
    maxPositionDelta: 3.907,
    realFrames: [],
    modelFrames: [],
    realByPeer: {},
    modelByPeer: {},
    report: REPORT,
    ...over
  })

  /**
   * The message of the red a case expects, and a failure of its own if the run
   * passed. Every red is checked for `run.report` here rather than case by
   * case: carrying the transcripts is a documented property of the helper, and
   * one `fail()` arm built without them would be the one that goes unnoticed.
   */
  const redFor = (over: Partial<ConformanceRun>, pin: PinnedDivergence = PIN): string => {
    let message: string | null = null
    try {
      assertPinnedDivergence(run(over), pin)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toBe(null)
    expect(message).toContain(REPORT)
    return message as string
  }

  it('passes on the shape the scenario pins', () => {
    // The control for all eight reds below. Without it a helper that threw on
    // everything would satisfy every other case in this block.
    expect(() => assertPinnedDivergence(run(), PIN)).not.toThrow()
  })

  it('reds when the run conforms, because a stale pin is news too', () => {
    // The direction a `it.fails` or a skip cannot report at all: #384's item 4
    // moves the model's stamp, the divergence goes away, and the caller has to
    // be told to swap back to `assertConforms` rather than left green forever.
    expect(redFor({ divergences: [] })).toContain(
      'the run conforms — the pin is stale, switch back to assertConforms(run)'
    )
  })

  it('reds on a divergence from a sample the pin does not name', () => {
    // The scenario takes one sample, so a second label is a second moment
    // diverging. The pinned fields are unchanged here, which is the point: a
    // field-set check alone would wave this through.
    const stray = divergence({ label: 'bravo pauses again', field: 'playstate.position' })
    expect(redFor({ divergences: [divergence(), positionDiverged, stray] })).toContain(
      `samples other than ${JSON.stringify(SAMPLE)} diverged: ["bravo pauses again"]`
    )
  })

  it('reds on a field the pin does not list', () => {
    // A second divergence arriving alongside the pinned one — the membership
    // half of the room going wrong while the playstate half stays as pinned.
    const roster = divergence({ field: 'roster', real: ['alpha'], model: ['alpha', 'bravo'] })
    expect(redFor({ divergences: [divergence(), positionDiverged, roster] })).toContain(
      'diverging fields are ["playstate.position","playstate.setBy","roster"], pinned as ' +
        '["playstate.position","playstate.setBy"]'
    )
  })

  it('reds on a pinned field that stopped diverging', () => {
    // The same check from the other side, and the one that matters as the model
    // catches up in pieces: `position` converging while `setBy` still diverges
    // is a partial fix, not the pinned shape, and an "every divergence is
    // listed" check would call it green.
    expect(redFor({ divergences: [divergence()] })).toContain(
      'diverging fields are ["playstate.setBy"], pinned as ' +
        '["playstate.position","playstate.setBy"]'
    )
  })

  it('reds when setBy diverges the other way round', () => {
    // Which side elected whom is the claim the `sendAck()` comment in
    // `src/main/syncplay.ts` rests on. A run where the *model* re-elects and
    // the reference does not carries the pinned label and the pinned fields, so
    // nothing above this check would notice the inversion.
    const flipped = divergence({ real: 'bravo', model: 'alpha' })
    expect(redFor({ divergences: [flipped, positionDiverged] })).toContain(
      'playstate.setBy is real="bravo" model="alpha", pinned as real="alpha" model="bravo"'
    )
  })

  it('reds when the run sampled no position at all', () => {
    // The "green that measures nothing" shape: a run whose sample step never
    // landed reports no delta, and treating that as within bounds would pass
    // the pin on a scenario that never measured the collapse.
    expect(redFor({ maxPositionDelta: null })).toContain(
      'the run sampled no positions, so the position collapse was never measured'
    )
  })

  it('reds on a gap that has shrunk inside the tolerance', () => {
    // The floor. `diffTraces` only pushes `playstate.position` past the
    // tolerance, so this pairs a field set that still says "diverged" with a
    // delta that says "agreed" — the shape a half-landed item 4 would produce.
    expect(redFor({ maxPositionDelta: 1.5 })).toContain(
      'max |real-model| position 1.500s is inside the ±1.6s tolerance — the collapse is gone'
    )
  })

  // The next two are a deliberate adjacent pair — 1 ms under the ceiling and
  // exactly on it — so the bound cannot be quietly dropped again: loosening
  // `>=` to `>`, or deleting the arm outright, reds one of the two rather than
  // neither. Verified by mutation: `>` reds the second case on its own.
  it('passes just under the ceiling', () => {
    expect(() => assertPinnedDivergence(run({ maxPositionDelta: 5.599 }), PIN)).not.toThrow()
  })

  it('reds at the ceiling exactly, and on a gap nowhere near the pinned cause', () => {
    expect(redFor({ maxPositionDelta: 5.6 })).toContain(
      'max |real-model| position 5.600s is at or above the pinned ceiling of 5.6s — the gap ' +
        'is wider than the pinned cause accounts for'
    )
    // Ten minutes of drift, on the same two fields and the same label: the
    // shape the floor alone would report as the pinned divergence.
    expect(redFor({ maxPositionDelta: 600 })).toContain(
      '600.000s is at or above the pinned ceiling'
    )
  })
})
