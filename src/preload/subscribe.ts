import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { EventSubscriber } from '@shared/ipc/channels'

/**
 * Build a broadcast subscription on `window.api`. Each call creates a fresh
 * wrapped listener and returns a disposer that removes only that listener
 * (epic #84, decision 2). Never call `ipcRenderer.removeAllListeners` — that
 * would clobber every other subscriber on the same channel.
 */
export function subscribe<T>(channel: string): EventSubscriber<T> {
  return (callback) => {
    const wrapped = (_event: IpcRendererEvent, data: T): void => callback(data)
    ipcRenderer.on(channel, wrapped)
    return (): void => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}
