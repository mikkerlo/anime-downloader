import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { CHANNELS, EVENT_CHANNELS } from '../src/shared/ipc/channels'

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')
const MAIN = read('src/main/index.ts')
const PRELOAD = read('src/preload/index.ts')
const SOURCES = MAIN + '\n' + PRELOAD

// First arg of every IPC-ish call. Post-1c every one must be a CHANNELS./
// EVENT_CHANNELS. reference — a bare string literal here means an un-migrated
// channel bypassing the single source of truth.
const IPC_CALL =
  /(?:ipcMain\.(?:handle|on)|ipcRenderer\.(?:invoke|send|on|removeListener|removeAllListeners)|[\w.]+\.webContents\.send|sender\.send|broadcastToAll)\(\s*(['"`])([a-z][\w:-]+)\1/g

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

  it('leaves no raw IPC channel string literals in main or preload (1c migration complete)', () => {
    const leftovers = new Set<string>()
    let m: RegExpExecArray | null
    IPC_CALL.lastIndex = 0
    while ((m = IPC_CALL.exec(SOURCES))) leftovers.add(m[2])
    expect([...leftovers]).toEqual([])
  })

  it('has no dead contract constants — every channel is referenced by symbol', () => {
    const unreferenced = [...Object.keys(CHANNELS), ...Object.keys(EVENT_CHANNELS)].filter(
      (key) => {
        const sym = (key in CHANNELS ? 'CHANNELS.' : 'EVENT_CHANNELS.') + key
        return !SOURCES.includes(sym)
      }
    )
    expect(unreferenced).toEqual([])
  })
})
