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

import { describe, expect, it } from 'vitest'
import { bootRealServer, connects, freePort } from '../conformance/helpers/real-server'
import { COMPARED_FIELD_PATHS, reachesFieldPath } from '../conformance/helpers/trace-diff'

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
