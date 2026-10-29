// Shared Library IPC: opening a library (#578) and export jobs (#574). The
// work lives in `services/attached-library` and `services/shared-library-export`;
// this router adds the folder pickers. `SHARED_LIBRARIES_CHANGED` is broadcast
// by the attached-library service's `onChanged` hook, and `SHARED_LIBRARY_FOUND`
// by the availability poller (#581), both wired in `src/main/index.ts`.

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { AppDeps } from './index'

async function pickFolder(sender: Electron.WebContents, title: string): Promise<string | null> {
  // The sender's window, not the focused one: an unfocused window can still ask.
  const win = BrowserWindow.fromWebContents(sender)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

export function register({ attachedLibraryService, sharedLibraryExport }: AppDeps): void {
  // --- Open a Shared Library (#578)
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
    (_event, libraryId: string, choice?: SharedLibraryAttachChoice, from?: unknown) => {
      if (typeof libraryId !== 'string') return { ok: false, error: 'No library given.' }
      const c = choice === 'claim' || choice === 'videos' ? choice : undefined
      return attachedLibraryService.attach(libraryId, c, from === 'found' ? 'found' : 'opened')
    }
  )

  // An unplugged library lists from the snapshot cache; a claim PC's rates come
  // from the library base (#582).
  ipcMain.handle(
    CHANNELS.SHARED_LIBRARY_LIST,
    (): Promise<AttachedLibraryInfo[]> => attachedLibraryService.listWithRates()
  )

  ipcMain.handle(CHANNELS.SHARED_LIBRARY_GET_TITLE, (_event, libraryId: string, animeId: number) =>
    typeof libraryId === 'string' && Number.isSafeInteger(animeId)
      ? attachedLibraryService.getTitle(libraryId, animeId)
      : null
  )

  // --- Forget, Re-locate, "Don't ask for this drive" (#581)
  ipcMain.handle(
    CHANNELS.SHARED_LIBRARY_FORGET,
    (_event, libraryId: string, opts?: { confirmDropPending?: boolean }) =>
      typeof libraryId === 'string'
        ? attachedLibraryService.forget(libraryId, {
            confirmDropPending: opts?.confirmDropPending === true
          })
        : { needsConfirm: false }
  )

  ipcMain.handle(
    CHANNELS.SHARED_LIBRARY_RELOCATE,
    async (event, libraryId: string): Promise<SharedLibraryRelocateResult> => {
      if (typeof libraryId !== 'string') return { ok: false, error: 'No library given.' }
      const dir = await pickFolder(event.sender, 'Re-locate the Shared Library')
      if (!dir) return { ok: false, error: null }
      return attachedLibraryService.relocate(libraryId, dir)
    }
  )

  ipcMain.handle(CHANNELS.SHARED_LIBRARY_DISMISS_PROMPT, (_event, libraryIds: unknown) => {
    if (Array.isArray(libraryIds)) {
      attachedLibraryService.dismissPrompt(libraryIds.filter((id) => typeof id === 'string'))
    }
  })

  // --- Export to a Shared Library (#574)
  const svc = sharedLibraryExport
  ipcMain.handle(CHANNELS.EXPORT_PLAN, (_e, req: ExportPlanRequest) => svc.plan(req))
  ipcMain.handle(CHANNELS.EXPORT_START, (_e, req: ExportStartRequest) => svc.start(req))
  ipcMain.handle(CHANNELS.EXPORT_PAUSE, (_e, jobId: string) => svc.pause(jobId))
  ipcMain.handle(CHANNELS.EXPORT_RESUME, (_e, jobId: string) => svc.resume(jobId))
  ipcMain.handle(CHANNELS.EXPORT_CANCEL, (_e, jobId: string) => svc.cancel(jobId))
  ipcMain.handle(CHANNELS.EXPORT_LIST_JOBS, () => svc.list())
  ipcMain.handle(CHANNELS.EXPORT_PICK_TARGET, (e) =>
    pickFolder(e.sender, 'Choose a folder for the Shared Library')
  )
  ipcMain.handle(
    CHANNELS.EXPORT_LOCATE_TARGET,
    async (e, jobId: string): Promise<{ ok: boolean; reason: string | null }> => {
      const dir = await pickFolder(e.sender, 'Locate the Shared Library')
      if (!dir) return { ok: false, reason: null }
      const r = await svc.locate(jobId, dir)
      return r.ok ? { ok: true, reason: null } : { ok: false, reason: r.reason }
    }
  )
}
