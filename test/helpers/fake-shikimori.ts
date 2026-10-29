// A fake shikimori.one for the merge tests (#584). It imports nothing from
// `src/`, so a `vi.mock` factory can load it without a circular import:
//   vi.mock('../../src/main/shikimori', async (orig) => ({
//     ...(await orig()), ...(await import('../helpers/fake-shikimori')).fakeApi }))
import { vi } from 'vitest'

export const T0 = Date.UTC(2026, 9, 1)

export interface Vals {
  episodes: number
  status: string
  score: number
  rewatches: number
}
export const vals = (v: Partial<Vals> = {}): Vals => ({
  episodes: 0,
  status: 'watching',
  score: 0,
  rewatches: 0,
  ...v
})

interface Row extends Vals {
  id: number
  updated_at: string
}

export const iso = (t: number): string => new Date(t).toISOString()

/** One user's rates, each with a server `updated_at`. */
export const server = {
  rows: new Map<number, Row>(),
  clock: T0 + 1_000_000,
  readError: null as Error | null,
  /** Thrown by the next writes (a 4xx makes the drain drop the item). */
  writeError: null as Error | null,
  /** Runs before each drain read, e.g. to move the server between the leg's read and the drain. */
  beforeDrainRead: null as (() => void) | null,
  reset(): void {
    this.rows.clear()
    this.clock = T0 + 1_000_000
    this.readError = null
    this.writeError = null
    this.beforeDrainRead = null
  },
  set(malId: number, v: Partial<Vals>, at?: number): void {
    const prev = this.rows.get(malId)
    const t = at ?? (this.clock += 1000)
    this.rows.set(malId, {
      id: prev?.id ?? malId * 10,
      ...vals({ ...prev, ...v }),
      updated_at: iso(t)
    })
  },
  get(malId: number): Row | undefined {
    return this.rows.get(malId)
  }
}

const rateOf = (malId: number, r: Row) => ({
  id: r.id,
  target_id: malId,
  target_type: 'Anime',
  episodes: r.episodes,
  status: r.status,
  score: r.score,
  rewatches: r.rewatches
})

export const fakeApi = {
  ensureFreshToken: vi.fn(async () => 'tok'),
  getUserRate: vi.fn(async (_t: string, _u: number, malId: number) => {
    server.beforeDrainRead?.()
    const r = server.rows.get(malId)
    return r ? rateOf(malId, r) : null
  }),
  updateUserRate: vi.fn(
    async (
      _t: string,
      id: number,
      episodes: number,
      status: string,
      score: number,
      rewatches: number
    ) => {
      if (server.writeError) throw server.writeError
      const [malId] = [...server.rows].find(([, r]) => r.id === id)!
      server.set(malId, { episodes, status, score, rewatches })
      return rateOf(malId, server.rows.get(malId)!)
    }
  ),
  createUserRate: vi.fn(
    async (
      _t: string,
      _u: number,
      malId: number,
      episodes: number,
      status: string,
      score: number,
      rewatches: number
    ) => {
      if (server.writeError) throw server.writeError
      server.set(malId, { episodes, status, score, rewatches })
      return rateOf(malId, server.rows.get(malId)!)
    }
  ),
  getUserAnimeRates: vi.fn(async () => {
    if (server.readError) throw server.readError
    return [...server.rows].map(([malId, r]) => ({
      id: r.id,
      score: r.score,
      status: r.status,
      episodes: r.episodes,
      rewatches: r.rewatches,
      updated_at: r.updated_at,
      target_type: 'Anime',
      anime: { id: malId, name: `#${malId}` }
    }))
  })
}
