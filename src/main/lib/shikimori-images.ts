// Shikimori serves avatars and posters from shikimori.one behind hotlink
// protection: a request whose `Referer` is a foreign origin (our renderer's
// dev-server `http://localhost:…` or packaged `file://` origin) gets a
// placeholder instead of the real image, so friend avatars render blank.
// Rewriting the `Referer` to Shikimori's own origin satisfies the check.
//
// Only renderer-initiated <img> loads are affected; the REST calls in
// `src/main/shikimori.ts` run through Node `fetch` (a different network stack)
// and never hit this session interceptor, so their auth headers are untouched.

const SHIKIMORI_REFERER = 'https://shikimori.one/'

// Scoped to shikimori.one and its image subdomains (e.g. desu.shikimori.one)
// so no other host is ever touched.
export const SHIKIMORI_IMAGE_URL_FILTER = ['https://shikimori.one/*', 'https://*.shikimori.one/*']

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
