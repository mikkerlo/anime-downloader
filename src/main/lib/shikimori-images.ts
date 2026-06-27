// Shikimori serves avatars and posters from its origin behind hotlink
// protection: a request whose `Referer` is a foreign origin (our renderer's
// dev-server `http://localhost:…` or packaged `file://` origin) gets a
// placeholder instead of the real image, so friend avatars render blank.
// Rewriting the `Referer` to Shikimori's own origin satisfies the check.
//
// Only renderer-initiated <img> loads are affected; the REST calls in
// `src/main/shikimori.ts` run through Node `fetch` (a different network stack)
// and never hit this session interceptor, so their auth headers are untouched.

import { SHIKIMORI_ORIGIN, SHIKIMORI_IMAGE_URL_FILTERS } from '../../shared/shikimori'

const SHIKIMORI_REFERER = `${SHIKIMORI_ORIGIN}/`

// Scoped to the Shikimori origin and its image subdomains (e.g.
// desu.shikimori.io) so no other host is ever touched.
export const SHIKIMORI_IMAGE_URL_FILTER = SHIKIMORI_IMAGE_URL_FILTERS

export function withShikimoriReferer(
  requestHeaders: Record<string, string>
): Record<string, string> {
  return { ...requestHeaders, Referer: SHIKIMORI_REFERER }
}

interface RefererSession {
  webRequest: {
    onBeforeSendHeaders(
      filter: { urls: string[] },
      listener: (
        details: { requestHeaders: Record<string, string> },
        callback: (response: { requestHeaders: Record<string, string> }) => void
      ) => void
    ): void
  }
}

export function installShikimoriReferer(session: RefererSession): void {
  session.webRequest.onBeforeSendHeaders(
    { urls: SHIKIMORI_IMAGE_URL_FILTER },
    (details, callback) => {
      callback({ requestHeaders: withShikimoriReferer(details.requestHeaders) })
    }
  )
}
