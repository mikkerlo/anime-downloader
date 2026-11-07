// Renderer-side half of Work offline (#567). Posters, avatars and anything
// else the renderer loads over http(s) bypass `fetchWithTimeout` — they go
// through Chromium's network stack — so the session cancels them while the
// app is offline. Local schemes (`anime-video:`, `file:`, `devtools:`) never
// touch the network, and the electron-vite dev server is the renderer itself.
// Online, the same listener redirects legacy smotret hosts (#684).

interface GateSession {
  webRequest: {
    onBeforeRequest(
      listener: (
        details: { url: string },
        callback: (response: { cancel?: boolean; redirectURL?: string }) => void
      ) => void
    ): void
  }
}

export function shouldCancelWhileOffline(url: string, devServerUrl?: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (devServerUrl) {
    try {
      if (parsed.origin === new URL(devServerUrl).origin) return false
    } catch {
      /* not a URL: no dev-server exemption */
    }
  }
  return true
}

/**
 * `redirect` (#684) moves a request that is not cancelled to the URL it
 * returns; `null` lets it through unchanged. It lives here because Electron
 * keeps only the last `onBeforeRequest` listener per session.
 */
export function installOfflineRequestGate(
  session: GateSession,
  isOffline: () => boolean,
  devServerUrl?: string,
  redirect?: (url: string) => string | null
): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    if (isOffline() && shouldCancelWhileOffline(details.url, devServerUrl)) {
      callback({ cancel: true })
      return
    }
    const redirectURL = redirect?.(details.url)
    callback(redirectURL ? { redirectURL } : { cancel: false })
  })
}
