// The Shared Library login run on an AniList or MAL login (#714): T3b ran it
// from Shikimori's own steps only, so a claim wasn't dropped (and the owner's
// libraries weren't merged) until some later run. The lifecycle's
// `afterLogin` dep now runs for every tracker with no steps of its own.
import { describe, it, expect, vi } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { createCredentialVault } from '../../src/main/trackers/credential-vault'
import { createTrackerLifecycle } from '../../src/main/trackers/lifecycle'

function rig(afterLogin?: (id: TrackerId) => void) {
  const store = new InMemoryStorage(structuredClone(STORE_DEFAULTS) as Record<string, unknown>)
  const safe = createFakeSafeStorage({ async: true })
  const vault = createCredentialVault({ store, safeStorage: safe.holder, warn: () => {} })
  const lifecycle = createTrackerLifecycle({
    store,
    vault,
    trackerRates: { instance: () => null, refreshInBackground: () => {} },
    ...(afterLogin ? { afterLogin } : {})
  })
  return { store, lifecycle }
}

const user = (id: number): TrackerUser => ({ id, nickname: `u${id}`, avatar: null })
const load = (id: number) => async () => ({ credentials: { access_token: 't' }, user: user(id) })

describe('afterLogin (#714)', () => {
  it.each(['anilist', 'mal'] as const)(
    'a %s login runs it once, after the user is written',
    async (id) => {
      const seen: unknown[] = []
      const r = rig((t) =>
        seen.push([t, r.store.get(id === 'mal' ? 'myanimelistUser' : 'anilistUser')])
      )
      expect(await r.lifecycle.completeLogin(id, load(9))).toMatchObject({ status: 'connected' })
      expect(seen).toEqual([[id, user(9)]])
    }
  )

  it('a tracker with steps of its own (Shikimori’s router) keeps its own afterLogin', async () => {
    const dep = vi.fn()
    const own = vi.fn()
    const r = rig(dep)
    r.lifecycle.setSteps('shikimori', {
      startTimer: () => {},
      drain: () => {},
      stopTimer: () => {},
      broadcastStatus: () => {},
      broadcastQueue: () => {},
      afterLogin: own
    })
    await r.lifecycle.completeLogin('shikimori', load(5))
    expect(own).toHaveBeenCalledTimes(1)
    expect(dep).not.toHaveBeenCalled()
  })

  it('a logout never runs it', () => {
    const dep = vi.fn()
    const r = rig(dep)
    r.store.set('anilistUser', user(9))
    r.lifecycle.logout('anilist')
    expect(dep).not.toHaveBeenCalled()
  })
})
