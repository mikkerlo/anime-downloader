// Test seam (#567): unpackaged builds can point the API clients at stub
// servers. `index.ts` applies the overrides once at startup; packaged builds
// ignore them.
import { SHIKIMORI_ORIGIN } from '../../shared/shikimori'

export const SMOTRET_API_BASE = 'https://smotret-anime.ru/api'
export const SMOTRET_API_BASE_ENV = 'ANIME_DL_SMOTRET_API_BASE'
export const SHIKIMORI_ORIGIN_ENV = 'ANIME_DL_SHIKIMORI_ORIGIN'

let smotretBase = SMOTRET_API_BASE
let shikiOrigin = SHIKIMORI_ORIGIN

export function applyApiBaseOverrides(env: NodeJS.ProcessEnv, isPackaged: boolean): void {
  const pick = (name: string, fallback: string): string => {
    const value = env[name]?.trim()
    return !isPackaged && value ? value.replace(/\/+$/, '') : fallback
  }
  smotretBase = pick(SMOTRET_API_BASE_ENV, SMOTRET_API_BASE)
  shikiOrigin = pick(SHIKIMORI_ORIGIN_ENV, SHIKIMORI_ORIGIN)
}

export function smotretApiBase(): string {
  return smotretBase
}

export function shikimoriOrigin(): string {
  return shikiOrigin
}
