import { ipcMain, dialog, BrowserWindow } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

// Opening a Shared Library (#578). `SHARED_LIBRARIES_CHANGED` is broadcast by
// the service's `onChanged` hook, wired in `src/main/index.ts`.
export function register({ attachedLibraryService }: AppDeps): void {
  ipcMain.handle(
    CHANNELS.SHARED_LIBRARY_PICK_AND_DISCOVER,
    async (event): Promise<SharedLibraryDiscovery> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts: Electron.OpenDialogOptions = {
        properties: ['openDirectory'],
        title: 'Open Shared Library'
      }
      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts)
      if (result.canceled || result.filePaths.length === 0) return { dir: null, candidates: [] }
      const dir = result.filePaths[0]
      return { dir, candidates: await attachedLibraryService.discover(dir) }
    }
  )

  ipcMain.handle(
    CHANNELS.SHARED_LIBRARY_ATTACH,
    (_event, libraryId: string, choice?: SharedLibraryAttachChoice) => {
      if (typeof libraryId !== 'string') return { ok: false, error: 'No library given.' }
      const c = choice === 'claim' || choice === 'videos' ? choice : undefined
      return attachedLibraryService.attach(libraryId, c)
    }
  )

  ipcMain.handle(CHANNELS.SHARED_LIBRARY_LIST, (): AttachedLibraryInfo[] =>
    attachedLibraryService.list()
  )

  ipcMain.handle(CHANNELS.SHARED_LIBRARY_GET_TITLE, (_event, libraryId: string, animeId: number) =>
    typeof libraryId === 'string' && Number.isSafeInteger(animeId)
      ? attachedLibraryService.getTitle(libraryId, animeId)
      : null
  )
}
