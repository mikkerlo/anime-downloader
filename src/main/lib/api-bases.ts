// Test seam (#567): unpackaged builds can point the API clients at stub
// servers. `index.ts` applies the overrides once at startup; packaged builds
// ignore them.
import { SHIKIMORI_ORIGIN } from '../../shared/shikimori'

// smotret moved off `.ru` in November 2026 (#684); its `.ru` hosts now answer
// poster URLs with a "site moved" HTML page.
export const SMOTRET_ORIGIN = 'https://smotret-anime.app'
export const SMOTRET_API_BASE = `${SMOTRET_ORIGIN}/api`
export const LEGACY_SMOTRET_HOSTS: readonly string[] = [
  'smotret-anime.ru',
  'smotretanime.ru',
  'anime-365.ru'
]
export const SMOTRET_API_BASE_ENV = 'ANIME_DL_SMOTRET_API_BASE'
export const SHIKIMORI_ORIGIN_ENV = 'ANIME_DL_SHIKIMORI_ORIGIN'

let smotretBase = SMOTRET_API_BASE
let smotretSiteOrigin = SMOTRET_ORIGIN
let shikiOrigin = SHIKIMORI_ORIGIN

/** The site root an API base was built from: `<root>/api` → `<root>`, else its origin. */
function siteRootOf(apiBase: string): string {
  if (apiBase.endsWith('/api')) return apiBase.slice(0, -'/api'.length)
  try {
    return new URL(apiBase).origin
  } catch {
    return SMOTRET_ORIGIN
  }
}

export function applyApiBaseOverrides(env: NodeJS.ProcessEnv, isPackaged: boolean): void {
  const pick = (name: string, fallback: string): string => {
    const value = env[name]?.trim()
    return !isPackaged && value ? value.replace(/\/+$/, '') : fallback
  }
  smotretBase = pick(SMOTRET_API_BASE_ENV, SMOTRET_API_BASE)
  smotretSiteOrigin = smotretBase === SMOTRET_API_BASE ? SMOTRET_ORIGIN : siteRootOf(smotretBase)
  shikiOrigin = pick(SHIKIMORI_ORIGIN_ENV, SHIKIMORI_ORIGIN)
}

export function smotretApiBase(): string {
  return smotretBase
}

/**
 * The site the subtitle, mp4-fallback and legacy-redirect URLs are built on.
 * Follows an `ANIME_DL_SMOTRET_API_BASE` override, so a stubbed run keeps
 * those requests on the stub too.
 */
export function smotretOrigin(): string {
  return smotretSiteOrigin
}

/**
 * The same path and query on `smotretOrigin()` for an http(s) URL on a legacy
 * smotret host (`www.` included); `null` for anything else, live mirrors too.
 */
export function rewriteLegacySmotretUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.replace(/^www\./, '')
  if (!LEGACY_SMOTRET_HOSTS.includes(host)) return null
  return `${smotretOrigin()}${parsed.pathname}${parsed.search}${parsed.hash}`
}

export function shikimoriOrigin(): string {
  return shikiOrigin
}
