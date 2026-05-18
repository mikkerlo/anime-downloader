import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { CHANNELS, EVENT_CHANNELS } from '../src/shared/ipc/channels'

// Re-derive the channel literals straight from the production source so the
// contract can't silently drift: if someone adds/renames an ipc channel in
// main or preload without updating channels.ts, this fails.
function scan() {
  const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')
  const sources = read('src/main/index.ts') + '\n' + read('src/preload/index.ts')

  const reqRe =
    /(?:ipcMain\.(?:handle|on)|ipcRenderer\.(?:invoke|send))\(\s*[`'"]([a-z][\w:-]+)[`'"]/g
  const evtRe =
    /(?:webContents\.send|ipcRenderer\.(?:on|removeListener|removeAllListeners))\(\s*[`'"]([a-z][\w:-]+)[`'"]/g

  const request = new Set<string>()
  const event = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = reqRe.exec(sources))) request.add(m[1])
  while ((m = evtRe.exec(sources))) event.add(m[1])
  // A channel that is broadcast is an event, not a request.
  for (const c of event) request.delete(c)
  return { request, event }
}

describe('IPC channel contract', () => {
  const requestValues = Object.values(CHANNELS)
  const eventValues = Object.values(EVENT_CHANNELS)

  it('has no duplicate literals', () => {
    const all = [...requestValues, ...eventValues]
    expect(new Set(all).size).toBe(all.length)
  })

  it('keeps request and event channels disjoint', () => {
    const ev = new Set<string>(eventValues)
    expect(requestValues.filter((c) => ev.has(c))).toEqual([])
  })

  it('uses a SCREAMING_SNAKE key derived from each channel name', () => {
    for (const [key, value] of Object.entries(CHANNELS)) {
      expect(key).toBe(value.replace(/[:-]/g, '_').toUpperCase())
    }
    for (const [key, value] of Object.entries(EVENT_CHANNELS)) {
      expect(key).toBe(value.replace(/[:-]/g, '_').toUpperCase())
    }
  })

  it('exhaustively mirrors the channels used in main + preload', () => {
    const { request, event } = scan()
    expect([...request].sort()).toEqual([...requestValues].sort())
    expect([...event].sort()).toEqual([...eventValues].sort())
  })
})
