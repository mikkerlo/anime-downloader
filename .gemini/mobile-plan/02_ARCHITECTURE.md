# Architecture: The Unified Bridge Pattern

To keep the codebase maintainable, we must unify how the Vue frontend talks to the "backend" (whether that backend is Electron or Capacitor).

## The Platform Interface
Create `src/renderer/src/platform/interface.ts` which defines every action the app needs.

```typescript
export interface PlatformAdapter {
  // Config
  getSetting(key: string): Promise<any>;
  setSetting(key: string, value: any): Promise<void>;

  // API
  searchAnime(query: string): Promise<any>;
  getAnime(id: number): Promise<any>;
  getEmbed(translationId: number): Promise<any>;

  // Downloads
  enqueue(requests: DownloadRequest[]): Promise<void>;
  getQueue(): Promise<EpisodeGroup[]>;
  cancel(id: string): Promise<void>;

  // Player
  getStreamUrl(trId: number, height: number): Promise<any>;
  findLocalFile(anime: string, ep: string, trId: number): Promise<any>;
}
```

## The Concrete Implementations
1. **ElectronAdapter**: Wraps `window.api.*` (current logic).
2. **CapacitorAdapter**: Wraps `Capacitor.Plugins.NativeStorage` and `Capacitor.Plugins.Http`.

## The Injection Strategy
In `main.ts`, detect the platform and inject the correct adapter into a global `app.platform` or use Vue `provide/inject`.

```typescript
const platform = isCapacitor ? new CapacitorAdapter() : new ElectronAdapter();
app.provide('platform', platform);
```
This ensures that `AnimeDetailView.vue` calls `platform.getAnime(id)` without caring whether it's talking to Node.js or Swift.
