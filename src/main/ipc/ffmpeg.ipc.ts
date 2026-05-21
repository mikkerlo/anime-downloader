import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

export function register({ checkFfmpeg, getFfmpegDir, clearFfmpegPaths }: AppDeps): void {
  ipcMain.handle(CHANNELS.FFMPEG_CHECK, () => checkFfmpeg())

  ipcMain.handle(CHANNELS.FFMPEG_DELETE, () => {
    const dest = getFfmpegDir()
    const ext = process.platform === 'win32' ? '.exe' : ''
    const ffmpegBin = path.join(dest, `ffmpeg${ext}`)
    const ffprobeBin = path.join(dest, `ffprobe${ext}`)
    try {
      fs.unlinkSync(ffmpegBin)
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(ffprobeBin)
    } catch {
      /* ignore */
    }
    // Also clear ffbinaries zip cache so next download is a real network fetch.
    const cacheDir = path.join(os.tmpdir(), 'ffbinaries-cache')
    try {
      for (const f of fs.readdirSync(cacheDir)) {
        fs.unlinkSync(path.join(cacheDir, f))
      }
    } catch {
      /* ignore */
    }
    clearFfmpegPaths()
  })
}
