// `Watcher.setFile` (`server.py:739-743`), the `sendFileUpdate` relay
// (`server.py:175-178`) and the `List` render (`protocols.py:695`).
//
// The model's header makes three separate claims about `Set: {file}` — an
// object stores, `null` stores `None`, an absent key never reaches `setFile` at
// all — and #307 was a bug in exactly that distinction. These are the scenarios
// that put each of the three on a real socket.

import { describe, expect, it, inject } from 'vitest'
import { assertConforms, runConformance } from './helpers/conform'
import type { Scenario } from './helpers/scenario'

const port = inject('syncplayPort')

const file = (name: string): Record<string, unknown> => ({ name, duration: 1440, size: 1 })
const SETTLE_MS = 2600

describe('conformance: file membership', () => {
  it('relays an announcement to the whole room, sender included', async () => {
    // `sendFileUpdate` broadcasts with no sender exclusion — unlike
    // `sendJoinMessage` (`server.py:168-173`), which has an explicit
    // `if w != watcher else None`. `handleSet`'s Rule 0 in
    // `src/main/syncplay.ts` depends on that asymmetry, so the suite asserts it
    // against the reference rather than against the model that asserts it.
    const scenario: Scenario = {
      name: 'conf-file-relay',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'wait', ms: 600 },
        { kind: 'sample', label: 'bravo joined, no announcement yet' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'wait', ms: 600 },
        { kind: 'sample', label: "bravo's announcement reaches both" }
      ]
    }
    const run = await runConformance(scenario, port)
    assertConforms(run)
    // The premise: the relay really did come back to its own sender. Without
    // this, two backends that both suppressed it would agree and the case would
    // attest to nothing.
    expect(
      run.realFrames.some(
        (f) => f.includes('"bravo"') && f.includes('b.mkv') && f.includes('"Set"')
      )
    ).toBe(true)
  })

  it('takes a watcher out of the ordering on Set:{file:null}', async () => {
    const scenario: Scenario = {
      name: 'conf-file-null-clears',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 700, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'state', peer: 'bravo', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'requestList', peer: 'alpha' },
        { kind: 'wait', ms: 400 },
        { kind: 'sample', label: 'bravo owns the room at 500' },
        // The clear #307's `playerClosed()` sends. bravo leaves the ordering,
        // so alpha — the only file-bearing watcher left — takes the room back.
        { kind: 'setFile', peer: 'bravo', file: null },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'requestList', peer: 'alpha' },
        { kind: 'wait', ms: 400 },
        { kind: 'sample', label: 'bravo cleared, alpha takes the room at 700' }
      ]
    }
    assertConforms(await runConformance(scenario, port))
  })

  it('keeps the seat for Set:{file:{}}, which is membership rather than a clear', async () => {
    // `setFile` stores the mapping it was handed; the `if file_ and "name" in
    // file_` guard only truncates the name. `{}` is therefore not `None`, and
    // `__lt__`'s `self._file is None` test still counts it as file-bearing — so
    // an empty mapping keeps its seat in the election where `null` loses it.
    const scenario: Scenario = {
      name: 'conf-file-empty-mapping',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 700, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'state', peer: 'bravo', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'bravo owns the room at 500' },
        { kind: 'setFile', peer: 'bravo', file: {} },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'an empty mapping keeps bravo in the ordering' }
      ]
    }
    assertConforms(await runConformance(scenario, port))
  })

  it('leaves the seat alone for a Set that carries no file key', async () => {
    const scenario: Scenario = {
      name: 'conf-file-absent-key',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 700, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'state', peer: 'bravo', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'bravo owns the room at 500' },
        // `handleSet` dispatches per key (`protocols.py:599-621`), so a `Set`
        // with no `file` key never reaches `setFile`.
        { kind: 'setWithoutFile', peer: 'bravo' },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'a file-less Set is not a clear' }
      ]
    }
    assertConforms(await runConformance(scenario, port))
  })

  it('renders a cleared file as file:{} in the List reply', async () => {
    const scenario: Scenario = {
      name: 'conf-file-list-render',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'wait', ms: 600 },
        { kind: 'requestList', peer: 'alpha' },
        { kind: 'wait', ms: 400 },
        { kind: 'sample', label: 'bravo has never announced' },
        { kind: 'setFile', peer: 'alpha', file: null },
        { kind: 'wait', ms: 600 },
        { kind: 'requestList', peer: 'alpha' },
        { kind: 'wait', ms: 400 },
        { kind: 'sample', label: 'alpha has cleared' }
      ]
    }
    const run = await runConformance(scenario, port)
    assertConforms(run)
    expect(run.realFrames.some((f) => f.includes('"List"') && f.includes('"file": {}'))).toBe(true)
  })
})
