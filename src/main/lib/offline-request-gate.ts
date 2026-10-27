// Renderer-side half of Work offline (#567). Posters, avatars and anything
// else the renderer loads over http(s) bypass `fetchWithTimeout` — they go
// through Chromium's network stack — so the session cancels them while the
// app is offline. Local schemes (`anime-video:`, `file:`, `devtools:`) never
// touch the network, and the electron-vite dev server is the renderer itself.

interface GateSession {
  webRequest: {
    onBeforeRequest(
      listener: (
        details: { url: string },
        callback: (response: { cancel: boolean }) => void
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

export function installOfflineRequestGate(
  session: GateSession,
  isOffline: () => boolean,
  devServerUrl?: string
): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: isOffline() && shouldCancelWhileOffline(details.url, devServerUrl) })
  })
}
