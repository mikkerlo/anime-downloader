// Player-view presence (#516): the per-sender refcount behind the merge hold.
// A missed release strands every merge until restart, so the cases below pin
// the sender-scoped release on the three renderer lifecycle events as much as
// the explicit `close`.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { ipcMain } from 'electron'
import {
  createPlayerPresenceService,
  type PlayerPresenceService,
  type PresenceSender
} from '../../src/main/services/player-presence'
import { register } from '../../src/main/ipc/player.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import type { AppDeps } from '../../src/main/ipc'

type FakeSender = EventEmitter & { id: number }

function fakeSender(id: number): FakeSender {
  return Object.assign(new EventEmitter(), { id })
}

const asSender = (s: FakeSender): PresenceSender => s as unknown as PresenceSender

describe('player presence (#516)', () => {
  let presence: PlayerPresenceService
  let releases: number

  beforeEach(() => {
    presence = createPlayerPresenceService()
    releases = 0
    presence.onRelease(() => releases++)
  })

  it('counts per sender and fires onRelease only on the 1 → 0 edge', () => {
    const a = fakeSender(1)
    expect(presence.isOpen()).toBe(false)
    presence.open(asSender(a))
    presence.open(asSender(a))
    expect(presence.isOpen()).toBe(true)

    presence.close(1)
    expect(presence.isOpen()).toBe(true)
    expect(releases).toBe(0)

    presence.close(1)
    expect(presence.isOpen()).toBe(false)
    expect(releases).toBe(1)
  })

  it('treats a close below zero as a no-op', () => {
    presence.close(1)
    const a = fakeSender(1)
    presence.open(asSender(a))
    presence.close(1)
    presence.close(1)
    expect(releases).toBe(1)
    presence.open(asSender(a))
    expect(presence.isOpen()).toBe(true)
  })

  it('holds until the last sender releases', () => {
    presence.open(asSender(fakeSender(1)))
    presence.open(asSender(fakeSender(2)))
    presence.close(1)
    expect(presence.isOpen()).toBe(true)
    expect(releases).toBe(0)
    presence.close(2)
    expect(releases).toBe(1)
  })

  it('releases only the crashed sender on render-process-gone', () => {
    const a = fakeSender(1)
    const b = fakeSender(2)
    presence.open(asSender(a))
    presence.open(asSender(a))
    presence.open(asSender(b))

    a.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(presence.isOpen()).toBe(true)
    expect(releases).toBe(0)

    b.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(presence.isOpen()).toBe(false)
    expect(releases).toBe(1)
  })

  it('releases on main-frame navigation (reload)', () => {
    const a = fakeSender(1)
    presence.open(asSender(a))
    a.emit('did-navigate')
    expect(presence.isOpen()).toBe(false)
    expect(releases).toBe(1)
    // A navigation with nothing open is not another release edge.
    a.emit('did-navigate')
    expect(releases).toBe(1)
  })

  it('releases on destroyed, and re-wires a sender id that comes back', () => {
    const a = fakeSender(1)
    presence.open(asSender(a))
    a.emit('destroyed')
    expect(presence.isOpen()).toBe(false)
    expect(releases).toBe(1)

    const again = fakeSender(1)
    presence.open(asSender(again))
    expect(again.listenerCount('destroyed')).toBe(1)
    again.emit('render-process-gone')
    expect(presence.isOpen()).toBe(false)
  })

  it('attaches the lifecycle listeners once per sender, not once per open', () => {
    const a = fakeSender(1)
    for (let i = 0; i < 15; i++) {
      presence.open(asSender(a))
      presence.close(1)
    }
    expect(a.listenerCount('did-navigate')).toBe(1)
    expect(a.listenerCount('render-process-gone')).toBe(1)
    expect(a.listenerCount('destroyed')).toBe(1)
    expect(releases).toBe(15)
  })

  describe('the player:view-opened / player:view-closed handlers', () => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown
    let handlers: Map<string, Handler>

    beforeEach(() => {
      ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
      register({ playerPresenceService: presence } as unknown as AppDeps)
      handlers = new Map(
        (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
      )
    })

    it('counts the invoking sender and releases it by its id', () => {
      const a = fakeSender(3)
      handlers.get(CHANNELS.PLAYER_VIEW_OPENED)!({ sender: a })
      expect(presence.isOpen()).toBe(true)
      handlers.get(CHANNELS.PLAYER_VIEW_CLOSED)!({ sender: a })
      expect(presence.isOpen()).toBe(false)
      expect(releases).toBe(1)
    })

    it('wires the invoking sender’s crash to the release', () => {
      const a = fakeSender(3)
      handlers.get(CHANNELS.PLAYER_VIEW_OPENED)!({ sender: a })
      a.emit('render-process-gone')
      expect(presence.isOpen()).toBe(false)
    })
  })
})
