import { probeMp4Faststart } from '../../mp4-faststart'
import type { Mp4StreamingStats } from '../../mp4-faststart'
import type { StorageService } from '../../store/types'

export interface Mp4StatsServiceDeps {
  store: StorageService
}

export interface Mp4FaststartContext {
  animeId: number
  animeName: string
  episodeInt: string
  episodeLabel: string
}

export interface Mp4StatsService {
  /**
   * Probes `filePath` for MP4 faststart layout and folds the result into
   * `store.mp4StreamingStats`. No-ops if the path was already probed this
   * session. Safe to call concurrently — writes are serialized.
   */
  recordCheck: (filePath: string, context: Mp4FaststartContext) => Promise<void>
  getStats: () => Mp4StreamingStats
  resetStats: () => void
}

/**
 * Owns the mp4-faststart sampling state lifted out of `index.ts` (refactor
 * epic #84, Phase 3 slice 3g): the per-session probed-paths set and the
 * read-modify-write serialization chain — both genuine in-flight state.
 */
export function createMp4StatsService({ store }: Mp4StatsServiceDeps): Mp4StatsService {
  // In-memory set of MP4 paths probed this session, so re-opening the same file
  // in the player doesn't double-count. Stats persist across sessions; this set
  // resets on app restart, which is fine — it's a sampling check, not an exact
  // per-file ledger.
  const checked = new Set<string>()

  // Serialize stats read-modify-write so concurrent download finishes can't
  // clobber each other's increments.
  let writeChain: Promise<void> = Promise.resolve()

  async function recordCheck(filePath: string, context: Mp4FaststartContext): Promise<void> {
    if (checked.has(filePath)) return
    checked.add(filePath)
    const probe = await probeMp4Faststart(filePath)
    if (!probe) return
    const next = writeChain.then(() => {
      const stats = store.get('mp4StreamingStats') as Mp4StreamingStats
      stats.totalChecked += 1
      if (probe.faststart) {
        stats.faststartCount += 1
      } else {
        stats.nonFaststartSamples.push({
          animeId: context.animeId,
          animeName: context.animeName,
          episodeInt: context.episodeInt,
          episodeLabel: context.episodeLabel,
          filePath,
          firstNonFtypBox: probe.firstNonFtypBox,
          checkedAt: Date.now()
        })
        if (stats.nonFaststartSamples.length > 10) {
          stats.nonFaststartSamples = stats.nonFaststartSamples.slice(-10)
        }
        console.warn(
          `[mp4-faststart] non-faststart MP4 detected: ${context.animeName} — ${context.episodeLabel} (first non-ftyp box: ${probe.firstNonFtypBox}) at ${filePath}`
        )
      }
      store.set('mp4StreamingStats', stats)
    })
    writeChain = next.catch(() => undefined)
    await next
  }

  function getStats(): Mp4StreamingStats {
    return store.get('mp4StreamingStats') as Mp4StreamingStats
  }

  function resetStats(): void {
    store.set('mp4StreamingStats', {
      totalChecked: 0,
      faststartCount: 0,
      nonFaststartSamples: []
    })
    checked.clear()
  }

  return { recordCheck, getStats, resetStats }
}
