// Single source of truth for the Shikimori web/API origin.
//
// Shikimori has migrated domains over its lifetime (shikimori.org →
// shikimori.one → shikimori.io). When the domain moves, every hardcoded
// `https://shikimori.<tld>` literal silently breaks — and worst of all the
// breakage is asymmetric: public GET reads transparently follow the 301 to
// the new host and still return data, but authenticated writes fail because
// undici (Node/Electron `fetch`) strips the `Authorization` header on a
// cross-origin redirect. The result is the app appearing to work (details,
// friends, recommendations load) while every rate update 404s and live rate
// lookups fall back to defaults. Centralizing the origin here makes the next
// migration a one-line change.
export const SHIKIMORI_ORIGIN = 'https://shikimori.io'

// Image hotlink filters: the origin plus its image subdomains
// (e.g. desu.shikimori.io). Derived from SHIKIMORI_ORIGIN's host so they stay
// in lockstep with the API origin.
const SHIKIMORI_HOST = new URL(SHIKIMORI_ORIGIN).host
export const SHIKIMORI_IMAGE_URL_FILTERS = [
  `${SHIKIMORI_ORIGIN}/*`,
  `https://*.${SHIKIMORI_HOST}/*`
]
