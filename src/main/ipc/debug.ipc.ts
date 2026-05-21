import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

interface QualityMismatch {
  translationId: number
  author: string
  type: string
  reported: number
  actual: number
}

export function register({ coldStorageService, mp4StatsService }: AppDeps): void {
  // Quality-mismatch reports are a developer-debug aid only; they live in this
  // session-scoped map and are dumped to disk on demand, never persisted.
  const qualityMismatches = new Map<number, QualityMismatch>()

  ipcMain.handle(CHANNELS.REPORT_QUALITY_MISMATCH, (_event, data: QualityMismatch) => {
    qualityMismatches.set(data.translationId, data)
  })

  ipcMain.handle(CHANNELS.GET_QUALITY_MISMATCH_COUNT, () => {
    return qualityMismatches.size
  })

  ipcMain.handle(CHANNELS.DEBUG_GET_MP4_STATS, () => {
    return mp4StatsService.getStats()
  })

  ipcMain.handle(CHANNELS.DEBUG_RESET_MP4_STATS, () => {
    mp4StatsService.resetStats()
  })

  ipcMain.handle(CHANNELS.DUMP_QUALITY_MISMATCHES, () => {
    const outPath = path.join(coldStorageService.getDownloadDir(), 'quality-mismatches.json')
    const data = [...qualityMismatches.values()]
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2))
    console.log(`[debug] Wrote ${data.length} quality mismatches to ${outPath}`)
    return { count: data.length, path: outPath }
  })
}
