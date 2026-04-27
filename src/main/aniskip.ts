// Aniskip API client — provisional skip-times provider.
// See DESIGN.md "Aniskip Skip-Intro / Skip-Outro" and CLAUDE.md / project memory:
// keep all aniskip-specific knowledge contained to this file + the
// `aniskip:get-skip-times` IPC so we can swap providers cheaply later.

const ANISKIP_BASE = 'https://api.aniskip.com/v2'
const REQUEST_TIMEOUT_MS = 30_000

export type SkipType = 'op' | 'ed'

export interface SkipTime {
  skipType: SkipType
  interval: { startTime: number; endTime: number }
  episodeLength: number
  skipId: string
}

interface RawSkipTime {
  skipType: string
  interval: { startTime: number; endTime: number }
  episodeLength: number
  skipId: string
}

interface AniskipResponse {
  found?: boolean
  results?: RawSkipTime[]
}

export async function getSkipTimes(
  malId: number,
  episode: number,
  duration: number
): Promise<SkipTime[]> {
  if (!Number.isFinite(malId) || malId <= 0) return []
  if (!Number.isFinite(episode) || episode <= 0) return []

  const params = new URLSearchParams()
  params.append('types[]', 'op')
  params.append('types[]', 'ed')
  if (Number.isFinite(duration) && duration > 0) {
    params.set('episodeLength', String(Math.round(duration)))
  }
  const url = `${ANISKIP_BASE}/skip-times/${malId}/${episode}?${params.toString()}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return []
    const json = (await res.json()) as AniskipResponse
    if (!json.found || !Array.isArray(json.results)) return []
    return json.results
      .filter((r): r is RawSkipTime => r && (r.skipType === 'op' || r.skipType === 'ed'))
      .map((r) => ({
        skipType: r.skipType as SkipType,
        interval: { startTime: r.interval.startTime, endTime: r.interval.endTime },
        episodeLength: r.episodeLength,
        skipId: r.skipId
      }))
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
