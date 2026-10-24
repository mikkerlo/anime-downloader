// The apply rule's table (#524).
//
// `wouldSeekOnApply()` is the one predicate both processes call: the renderer
// to decide whether a remote state moves the element, main to decide whether
// to arm its echo target for that move. Before #524 each side carried its own
// copy of the 3 s literal and nothing tied them together. The cases below pin
// the rule's three arms; that both call sites really use it, on the same
// quantity, is pinned at the call sites (the composable's "a pause edge snaps
// to the room" block and test/services/syncplay-pause-edge-lockstep.test.ts).

import { describe, it, expect } from 'vitest'
import {
  APPLY_TOLERANCE_S,
  ECHO_SEEK_EPSILON_S,
  wouldSeekOnApply
} from '../../src/shared/syncplay-apply-rule'
import * as main from '../../src/main/syncplay'

describe('wouldSeekOnApply (#524)', () => {
  it('keeps the two tolerances it is defined by', () => {
    expect(ECHO_SEEK_EPSILON_S).toBe(0.5)
    expect(APPLY_TOLERANCE_S).toBe(3)
  })

  it('is the value main re-exports, so main’s importers see one number', () => {
    expect(main.ECHO_SEEK_EPSILON_S).toBe(ECHO_SEEK_EPSILON_S)
    expect(main.ADOPT_TOLERANCE_S).toBe(APPLY_TOLERANCE_S)
  })

  // [diff, pauseEdge, expected], doSeek false. The 0.6 / 1.5 / 2.9 rows are
  // the band #524 changes: a pause edge seeks there, an ordinary state does not.
  const table: [number, boolean, boolean][] = [
    [0, false, false],
    [0, true, false],
    [0.4, false, false],
    [0.4, true, false],
    [ECHO_SEEK_EPSILON_S, true, false],
    [0.6, false, false],
    [0.6, true, true],
    [1.5, false, false],
    [1.5, true, true],
    [2.9, false, false],
    [2.9, true, true],
    [APPLY_TOLERANCE_S, false, false],
    [APPLY_TOLERANCE_S, true, true],
    [3.1, false, true],
    [3.1, true, true],
    [500, false, true],
    [500, true, true]
  ]

  it.each(table)('diff %s, pause edge %s → %s', (diff, pauseEdge, expected) => {
    expect(wouldSeekOnApply({ doSeek: false, diff, pauseEdge })).toBe(expected)
  })

  it('always seeks on doSeek, at any distance and on either side of the edge', () => {
    for (const diff of [0, 0.4, 1.5, 500]) {
      for (const pauseEdge of [false, true]) {
        expect(wouldSeekOnApply({ doSeek: true, diff, pauseEdge })).toBe(true)
      }
    }
  })

  it('is strict at both boundaries: exactly the tolerance moves nothing', () => {
    // Strict `>` as the renderer's literal was (`diff > 3.0`): a state exactly
    // the tolerance away is a state the rule already calls converged.
    expect(wouldSeekOnApply({ doSeek: false, diff: APPLY_TOLERANCE_S, pauseEdge: false })).toBe(
      false
    )
    expect(wouldSeekOnApply({ doSeek: false, diff: ECHO_SEEK_EPSILON_S, pauseEdge: true })).toBe(
      false
    )
    expect(
      wouldSeekOnApply({ doSeek: false, diff: APPLY_TOLERANCE_S + 1e-9, pauseEdge: false })
    ).toBe(true)
    expect(
      wouldSeekOnApply({ doSeek: false, diff: ECHO_SEEK_EPSILON_S + 1e-9, pauseEdge: true })
    ).toBe(true)
  })
})
