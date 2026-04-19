# Networking & Storage: Bypassing Mobile Constraints

## 1. Native HTTP (CORS & User-Agent)
Browsers on iPad block `fetch()` to `smotret-anime.ru` because of CORS.
- **Solution**: Use `@capacitor-community/http`.
- **Why**: Native plugins make requests from the iOS networking stack, not the WebView. This allows us to set the `User-Agent: smotret-anime-dl` header and bypass all CORS preflight checks.

## 2. Shared API Logic
The current `src/main/smotret-api.ts` is a class. We should move this class into a "Shared API" folder.
- **Electron**: Instantiate it in the `main` process.
- **Capacitor**: Instantiate it directly in the **Renderer** (since Native HTTP makes it safe to call from JS).

## 3. Persistent Storage
- **Current**: `electron-store` writes to a JSON file.
- **iPad**: Use `Capacitor Preferences` for small settings (Token, Theme) and `Capacitor SQLite` for the library/watch history.
- **Data Migration**: Since the iPad starts fresh, no migration is needed, but the **Library Sync** via Shikimori becomes the primary way users "move" their desktop library to their tablet.
