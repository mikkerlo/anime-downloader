// Watch-while-downloading (#63) review fixes: the two-way merge lock on the
// player-open path (a mid-merge translation must resolve to null → CDN
// fallback, never the half-written .mkv), and the .part-aware sibling-.ass
// mapping in player:get-local-subtitles (the late subtitle load depends on
// it; the old regex returned the video bytes as ASS for a .mp4.part path).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { register } from '../../src/main/ipc/player.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('player.ipc — watch-while-downloading guards', () => {
  let handlers: Map<string, Handler>
  let dir: string
  let getMergeStatus: ReturnType<typeof vi.fn>
  let getPartialVideoPath: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-ipc-partial-'))
    getMergeStatus = vi.fn().mockReturnValue(null)
    getPartialVideoPath = vi.fn().mockReturnValue(null)
    const deps = {
      store: new InMemoryStorage({ downloadedEpisodes: {} }),
      smotretApi: {},
      coldStorageService: { getDownloadDir: () => dir, isAdvanced: () => false },
      streamingService: {},
      mp4StatsService: {},
      downloadManager: { getMergeStatus, getPartialVideoPath },
      playerLockService: { open: vi.fn(), close: vi.fn() },
      getFfmpegPath: () => '',
      getFfprobePath: () => ''
    } as unknown as AppDeps
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    register(deps)
    handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
  })

  const findLocalFile = (translationId: number): unknown =>
    handlers.get(CHANNELS.PLAYER_FIND_LOCAL_FILE)!({}, 'Anime', '1', translationId, 'ep1')

  describe('two-way merge lock in player:find-local-file', () => {
    it('returns null while the translation is merging, without consulting the queue', async () => {
      getMergeStatus.mockReturnValue('merging')

      expect(await findLocalFile(7)).toBeNull()
      expect(getPartialVideoPath).not.toHaveBeenCalled()
    })

    it('resolves normally when no merge is running (control)', async () => {
      expect(await findLocalFile(7)).toBeNull()
      // The miss came from the normal resolution path, not the merge guard.
      expect(getPartialVideoPath).toHaveBeenCalledWith(7)
    })
  })

  describe('player:get-local-subtitles is .part-aware', () => {
    const getSubs = (filePath: string): unknown =>
      handlers.get(CHANNELS.PLAYER_GET_LOCAL_SUBTITLES)!({}, filePath)

    it('maps a growing .mp4.part to the same sibling .ass as the final file', async () => {
      fs.writeFileSync(path.join(dir, 'ep.ass'), 'Dialogue: subs')

      expect(await getSubs(path.join(dir, 'ep.mp4.part'))).toBe('Dialogue: subs')
      expect(await getSubs(path.join(dir, 'ep.mp4'))).toBe('Dialogue: subs')
    })

    it('never reads the video file itself back as ASS for unmapped extensions', async () => {
      const odd = path.join(dir, 'ep.webm')
      fs.writeFileSync(odd, 'video-bytes')

      expect(await getSubs(odd)).toBeNull()
    })
  })
})
