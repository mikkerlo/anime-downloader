import * as fs from 'fs'
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
    clearFfmpegPaths()
  })
}
