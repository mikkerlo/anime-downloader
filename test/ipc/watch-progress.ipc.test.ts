// Field clocks on the watch-progress router (#572).
//
// The load-bearing case is "opening beats watching": `persistSelectedTranslation`
// saves position 0 on a watched row the moment an episode is opened, before
// `loadedmetadata`. Only a `'playback'` save may move `sync.position`, so that
// save keeps the row's old clock and real watching elsewhere wins the tie.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { register } from '../../src/main/ipc/watch-progress.ipc'
import type { AppDeps } from '../../src/main/ipc/index'

const INSTALL = 'install-a'
const T0 = Date.UTC(2026, 0, 1)
const T2 = T0 + 2 * 60 * 60 * 1000
const KEY = '5:3'

function registerRouter(watchProgress: Record<string, WatchProgressEntry> = {}): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  row: () => WatchProgressEntry
  store: InMemoryStorage
} {
  const store = new InMemoryStorage({ installId: INSTALL, watchProgress })
  register({ store } as unknown as AppDeps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as Mock).mock.calls.map(([channel, handler]) => [channel, handler])
  )
  return {
    invoke: async (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler for ${channel}`)
      return handler({}, ...args)
    },
    row: () => (store.get('watchProgress') as Record<string, WatchProgressEntry>)[KEY],
    store
  }
}

/** `watch-progress:save(5, '3', position, duration, watched, translationId, source)`. */
function save(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  position: number,
  watched: boolean | undefined,
  translationId: number | undefined,
  source: WatchProgressSaveSource | undefined
): Promise<unknown> {
  return invoke(
    CHANNELS.WATCH_PROGRESS_SAVE,
    5,
    '3',
    position,
    1420,
    watched,
    translationId,
    source
  )
}

const local = (at: number): SyncClock => ({ at, origin: INSTALL })
const legacy = (at: number): SyncClock => ({ at, origin: 'legacy' })

/** A watched row, last watched at T0 on this install. */
function watchedRow(): WatchProgressEntry {
  return {
    position: 1300,
    duration: 1420,
    updatedAt: T0,
    watched: true,
    watchedAt: T0,
    translationId: 77,
    sync: { position: local(T0), watched: local(T0) }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(T2)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('watch-progress:save — opening beats watching', () => {
  it("a 'choice' save writes position 0 as today but keeps sync.position at T0", async () => {
    const { invoke, row } = registerRouter({ [KEY]: watchedRow() })

    await save(invoke, 0, true, 77, 'choice')

    expect(row().position).toBe(0)
    expect(row().updatedAt).toBe(T2)
    expect(row().sync?.position).toEqual(local(T0))
  })

  it("the same values saved with 'playback' stamp T2", async () => {
    const { invoke, row } = registerRouter({ [KEY]: watchedRow() })

    await save(invoke, 0, true, 77, 'playback')

    expect(row().sync?.position).toEqual(local(T2))
  })

  it("a legacy row opened with 'choice' materializes position.at = updatedAt, not now", async () => {
    const { sync: _sync, ...legacyRow } = watchedRow()
    const { invoke, row } = registerRouter({ [KEY]: { ...legacyRow, watchedAt: T0 - 1000 } })

    await save(invoke, 0, true, 77, 'choice')

    expect(row().sync).toEqual({ position: legacy(T0), watched: legacy(T0 - 1000) })
  })

  it('a legacy row with no watchedAt projects watched.at from updatedAt', async () => {
    const { invoke, row } = registerRouter({
      [KEY]: { position: 400, duration: 1420, updatedAt: T0 }
    })

    await save(invoke, 401, false, undefined, 'playback')

    expect(row().sync).toEqual({ position: legacy(T0), watched: legacy(T0) })
  })
})

describe("watch-progress:save — 'playback' stamps only a real change", () => {
  function partRow(): WatchProgressEntry {
    return {
      position: 600,
      duration: 1420,
      updatedAt: T0,
      watched: false,
      translationId: 77,
      sync: { position: local(T0) }
    }
  }

  it('a move under 5 s keeps the clock', async () => {
    const { invoke, row } = registerRouter({ [KEY]: partRow() })
    await save(invoke, 604.9, false, 77, 'playback')
    expect(row().position).toBe(604.9)
    expect(row().sync?.position).toEqual(local(T0))
  })

  it('a move of 5 s stamps', async () => {
    const { invoke, row } = registerRouter({ [KEY]: partRow() })
    await save(invoke, 595, false, 77, 'playback')
    expect(row().sync?.position).toEqual(local(T2))
  })

  it('a changed translationId stamps', async () => {
    const { invoke, row } = registerRouter({ [KEY]: partRow() })
    await save(invoke, 601, false, 78, 'playback')
    expect(row().sync?.position).toEqual(local(T2))
  })

  it("the row's first 'playback' save stamps even when the position barely moved", async () => {
    const { invoke, row } = registerRouter()
    await save(invoke, 0, false, 77, 'choice')
    expect(row().sync).toEqual({})

    await save(invoke, 2, false, 77, 'playback')

    expect(row().sync?.position).toEqual(local(T2))
  })

  it("a new row from 'playback' carries a position clock", async () => {
    const { invoke, row } = registerRouter()
    await save(invoke, 30, false, 77, 'playback')
    expect(row().sync).toEqual({ position: local(T2) })
  })
})

describe('watch-progress:save — the watched clock', () => {
  it("a 'mark' flip stamps sync.watched but never sync.position", async () => {
    const { invoke, row } = registerRouter({
      [KEY]: {
        position: 600,
        duration: 1420,
        updatedAt: T0,
        watched: false,
        sync: { position: local(T0) }
      }
    })

    await invoke(CHANNELS.WATCH_PROGRESS_SAVE, 5, '3', 0, 0, true, undefined, 'mark')

    expect(row()).toMatchObject({ position: 0, watched: true, watchedAt: T2 })
    expect(row().sync).toEqual({ position: local(T0), watched: local(T2) })
  })

  it("a completed re-watch ('playback', watched: true on a watched row) stamps sync.watched", async () => {
    const { invoke, row } = registerRouter({ [KEY]: watchedRow() })

    await save(invoke, 0, true, 77, 'playback')

    expect(row().watchedAt).toBe(T0)
    expect(row().sync?.watched).toEqual(local(T2))
  })

  it("a 'choice' save reporting watched on a watched row is not a re-watch", async () => {
    const { invoke, row } = registerRouter({ [KEY]: watchedRow() })
    await save(invoke, 0, true, 77, 'choice')
    expect(row().sync?.watched).toEqual(local(T0))
  })

  it("a 'playback' save that does not report watched leaves the clock", async () => {
    const { invoke, row } = registerRouter({ [KEY]: watchedRow() })
    await save(invoke, 300, false, 77, 'playback')
    expect(row().watched).toBe(true)
    expect(row().sync?.watched).toEqual(local(T0))
  })

  it('a missing source stamps nothing, but still materializes a legacy row', async () => {
    const { invoke, row } = registerRouter({
      [KEY]: { position: 600, duration: 1420, updatedAt: T0, watched: false }
    })

    await save(invoke, 0, true, 78, undefined)

    expect(row().watched).toBe(true)
    expect(row().sync).toEqual({ position: legacy(T0), watched: legacy(T0) })
  })
})

describe('watch-progress:set-watched — the explicit unwatch', () => {
  it('clears watched and watchedAt and stamps sync.watched (main has no such path)', async () => {
    const { invoke, row } = registerRouter({ [KEY]: watchedRow() })

    const result = await invoke(CHANNELS.WATCH_PROGRESS_SET_WATCHED, 5, '3', false)

    expect(row().watched).toBe(false)
    expect(row().watchedAt).toBeUndefined()
    expect(row().sync).toEqual({ position: local(T0), watched: local(T2) })
    expect(result).toEqual(row())
  })

  it('a later save cannot bring the flag back unless it reports watched', async () => {
    const { invoke, row } = registerRouter({ [KEY]: watchedRow() })
    await invoke(CHANNELS.WATCH_PROGRESS_SET_WATCHED, 5, '3', false)

    await save(invoke, 30, false, 77, 'playback')

    expect(row().watched).toBe(false)
  })

  it('materializes a legacy row before stamping', async () => {
    const { sync: _sync, ...legacyRow } = watchedRow()
    const { invoke, row } = registerRouter({ [KEY]: legacyRow })

    await invoke(CHANNELS.WATCH_PROGRESS_SET_WATCHED, 5, '3', false)

    expect(row().sync).toEqual({ position: legacy(T0), watched: local(T2) })
    expect(row().position).toBe(1300)
  })

  it('marks an episode with no row watched', async () => {
    const { invoke, row } = registerRouter()

    await invoke(CHANNELS.WATCH_PROGRESS_SET_WATCHED, 5, '3', true)

    expect(row()).toEqual({
      position: 0,
      duration: 0,
      updatedAt: T2,
      watched: true,
      watchedAt: T2,
      translationId: undefined,
      sync: { watched: local(T2) }
    })
  })

  it('writes nothing when the flag already has that value', async () => {
    const { invoke, store } = registerRouter({ [KEY]: watchedRow() })
    const set = vi.spyOn(store, 'set')

    expect(await invoke(CHANNELS.WATCH_PROGRESS_SET_WATCHED, 5, '3', true)).toEqual(watchedRow())
    expect(await invoke(CHANNELS.WATCH_PROGRESS_SET_WATCHED, 5, '4', false)).toBeNull()
    expect(set).not.toHaveBeenCalled()
  })
})
