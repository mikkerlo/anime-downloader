// Local stand-ins for shikimori.one and smotret-anime.ru (#587). The app is
// pointed at them through S1a (#567)'s `ANIME_DL_SHIKIMORI_ORIGIN` /
// `ANIME_DL_SMOTRET_API_BASE` seam (main only, unpackaged builds only), so no
// run touches the real network.
//
// Shikimori keeps one rate row per MAL id and answers what the app's client
// asks for (`src/main/shikimori.ts`): `whoami`, the profile, the rates list,
// and `user_rates` GET / POST / PATCH. Every other Shikimori path, and every
// smotret path, is a 404, which the app treats as a reachable server with no
// data. Each request is recorded, so a spec can see what reached the server.

import http from 'node:http'

export interface StubUser {
  id: number
  nickname: string
  avatar: string
}

export interface StubRate {
  id: number
  target_id: number
  episodes: number
  status: string
  score: number
  rewatches: number
  updated_at: string
}

export interface StubAnime {
  malId: number
  name: string
  episodes: number
}

export interface Stubs {
  /** For `ANIME_DL_SHIKIMORI_ORIGIN`. */
  readonly origin: string
  /** For `ANIME_DL_SMOTRET_API_BASE`. */
  readonly smotretBase: string
  /** `METHOD path` of every request, in order. */
  readonly calls: string[]
  /** The server's current rate for a MAL id. */
  rate(malId: number): StubRate | undefined
  close(): Promise<void>
}

export async function startStubs(opts: {
  user: StubUser
  anime: StubAnime[]
  rates: Omit<StubRate, 'updated_at'>[]
  /** The rates' `updated_at`; each write moves it to the time of the write. */
  at: number
}): Promise<Stubs> {
  const iso = (t: number): string => new Date(t).toISOString()
  const rates = new Map<number, StubRate>(
    opts.rates.map((r) => [r.target_id, { ...r, updated_at: iso(opts.at) }])
  )
  let nextId = Math.max(0, ...opts.rates.map((r) => r.id)) + 1
  const calls: string[] = []
  const asRow = (r: StubRate) => ({
    ...r,
    user_id: opts.user.id,
    target_type: 'Anime',
    created_at: iso(opts.at)
  })
  const animeOf = (malId: number) => {
    const a = opts.anime.find((x) => x.malId === malId)
    return {
      id: malId,
      name: a?.name ?? `Anime ${malId}`,
      russian: '',
      image: { original: '', preview: '', x96: '', x48: '' },
      episodes: a?.episodes ?? 0,
      episodes_aired: a?.episodes ?? 0,
      kind: 'tv',
      score: '0',
      status: 'released'
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub')
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      calls.push(`${req.method} ${url.pathname}`)
      const json = (code: number, v: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(v))
      }
      const body = (): Record<string, unknown> => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          return (parsed?.user_rate ?? {}) as Record<string, unknown>
        } catch {
          return {}
        }
      }
      const p = url.pathname
      if (p === '/api/users/whoami' || p === `/api/users/${opts.user.id}`) {
        return json(200, opts.user)
      }
      if (p === `/api/users/${opts.user.id}/anime_rates`) {
        return json(
          200,
          [...rates.values()].map((r) => ({ ...asRow(r), anime: animeOf(r.target_id) }))
        )
      }
      if (p === '/api/v2/user_rates' && req.method === 'GET') {
        const malId = Number(url.searchParams.get('target_id'))
        const r = rates.get(malId)
        return json(200, r ? [asRow(r)] : [])
      }
      if (p === '/api/v2/user_rates' && req.method === 'POST') {
        const b = body()
        const malId = Number(b.target_id)
        const r: StubRate = {
          id: nextId++,
          target_id: malId,
          episodes: Number(b.episodes ?? 0),
          status: String(b.status ?? 'planned'),
          score: Number(b.score ?? 0),
          rewatches: Number(b.rewatches ?? 0),
          updated_at: iso(Date.now())
        }
        rates.set(malId, r)
        return json(201, asRow(r))
      }
      const patch = /^\/api\/v2\/user_rates\/(\d+)$/.exec(p)
      if (patch && req.method === 'PATCH') {
        const r = [...rates.values()].find((x) => x.id === Number(patch[1]))
        if (!r) return json(404, { message: 'no such rate' })
        const b = body()
        for (const k of ['episodes', 'score', 'rewatches'] as const) {
          if (b[k] !== undefined) r[k] = Number(b[k])
        }
        if (b.status !== undefined) r.status = String(b.status)
        r.updated_at = iso(Date.now())
        return json(200, asRow(r))
      }
      return json(404, { message: 'stub' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  return {
    origin: `http://127.0.0.1:${port}`,
    smotretBase: `http://127.0.0.1:${port}/smotret/api`,
    calls,
    rate: (malId) => {
      const r = rates.get(malId)
      return r ? { ...r } : undefined
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
