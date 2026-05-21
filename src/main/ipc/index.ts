import type { StorageService } from '../store/types'
import * as appRouter from './app.ipc'

/**
 * Dependencies passed to every per-domain IPC router (refactor epic #84,
 * Phase 3 slice 3a — decision 3). Grows as later slices extract more services
 * out of `index.ts`; routers must never reach for module-level singletons.
 */
export interface AppDeps {
  store: StorageService
}

/**
 * Wires every per-domain `*.ipc.ts` router in order. Phase 3 lands these in
 * slices; the legacy `registerIpcHandlers()` in `src/main/index.ts` keeps the
 * un-migrated 113 handlers until 3b–3g finish.
 */
export function registerIpcRouters(deps: AppDeps): void {
  appRouter.register(deps)
}
