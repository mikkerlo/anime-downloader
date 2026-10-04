// #487 — the follower's Next during a room follow. The helper only sees state,
// never time, so the three timing bands of the issue reduce to three inputs
// here: no token (B pressed before A's change arrived, or after the follow's
// source loaded), a token naming the active index (B pressed after the source
// swap released `navigating` but before metadata — the double-advance band), and
// a stale token naming some other index. The timing sweep itself lives in
// `test/services/syncplay-two-peer-episode-change.test.ts`, where latency and
// resolve time exist.
import { describe, it, expect } from 'vitest'
import { shouldSwallowLocalNext } from '../../src/renderer/src/utils'

describe('shouldSwallowLocalNext (#487)', () => {
  it('lets a press through with no pending follow', () => {
    expect(shouldSwallowLocalNext(null, 0)).toBe(false)
    expect(shouldSwallowLocalNext(null, 7)).toBe(false)
  })

  it('swallows a press while the pending follow names the active index', () => {
    expect(shouldSwallowLocalNext(7, 7)).toBe(true)
    // Index 0 is a real index, not "no token" — a falsy check would let it through.
    expect(shouldSwallowLocalNext(0, 0)).toBe(true)
  })

  it('lets a press through when the token is stale against the active index', () => {
    // A later step moved active past the token (a multi-step walk), or behind it.
    expect(shouldSwallowLocalNext(7, 8)).toBe(false)
    expect(shouldSwallowLocalNext(7, 6)).toBe(false)
  })

  it('swallows once: the caller consumes the token, so the second press goes through', () => {
    // The caller's protocol, written out the way `onUserNext` runs it.
    let pending: number | null = 7
    const active = 7
    const press = (): 'swallowed' | 'stepped' => {
      if (shouldSwallowLocalNext(pending, active)) {
        pending = null
        return 'swallowed'
      }
      return 'stepped'
    }
    expect([press(), press()]).toEqual(['swallowed', 'stepped'])
    expect(pending).toBeNull()
  })
})
