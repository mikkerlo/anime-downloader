import type { StorageService } from '../store/types'
import type { SmotretApi, AnimeDetail } from '../smotret-api'
import type { AnimeCacheService } from '../services/anime-cache'
import * as appRouter from './app.ipc'
import * as animeRouter from './anime.ipc'
import * as libraryRouter from './library.ipc'
import * as cacheRouter from './cache.ipc'
import * as homeRouter from './home.ipc'

/**
 * Dependencies passed to every per-domain IPC router (refactor epic #84,
 * Phase 3 — decision 3). Grows as later slices extract more services out of
 * `index.ts`; routers must never reach for module-level singletons.
 */
export interface AppDeps {
  store: StorageService
  smotretApi: SmotretApi
  animeCacheService: AnimeCacheService
  /**
   * Updates `store.recentAnimeMeta[detail.id]` with the freshest poster/title
   * snapshot. Hoisted as a dep so the anime + home routers don't import the
   * index.ts closure.
   */
  rememberAnimeMeta: (detail: AnimeDetail) => void
}

/**
 * Wires every per-domain `*.ipc.ts` router in order. Phase 3 lands these in
 * slices; the legacy `registerIpcHandlers()` in `src/main/index.ts` keeps the
 * un-migrated handlers until 3c–3g finish.
 */
export function registerIpcRouters(deps: AppDeps): void {
  appRouter.register(deps)
  animeRouter.register(deps)
  libraryRouter.register(deps)
  cacheRouter.register(deps)
  homeRouter.register(deps)
}
