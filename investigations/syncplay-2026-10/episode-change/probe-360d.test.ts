// @vitest-environment happy-dom
// PROBE ONLY (research for #360 re-investigation) — not for commit.
// Prototype of the reference client's own answer: on a local episode change,
// put a room SEEK (doSeek: true) to 0 on the wire in the same breath as the
// Set{file}, and keep the outgoing element's snapshots off the wire until the
// new element has bound. Monkey-patched onto the real SyncplayClient instance;
// no src/ change.
import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'

const OUT = process.env.PROBE_OUT ?? '/tmp/probe-360d.txt'
const log = (s: string): void => appendFileSync(OUT, s + '\n')
let room: TwoPeerRoom | undefined

type Priv = Record<string, unknown> & {
  setFile: (f: { canonicalName: string }) => void
  updateSnapshot: (s: unknown) => void
  sendLocalState: (p: { paused: boolean; position: number; cause: 'seek' }) => void
}

function patch(p: Peer, mode: 'off' | 'seek0' | 'seek0-noq'): void {
  if (mode === 'off') return
  const c = p.client as unknown as Priv
  const origSetFile = c.setFile.bind(c)
  const origUpd = c.updateSnapshot.bind(c)
  let quarantineUntilLoad = -1
  c.setFile = (f) => {
    const changed = (c.currentFile as { canonicalName?: string } | null)?.canonicalName !== f.canonicalName
    const hadFile = c.currentFile != null
    origSetFile(f)
    if (changed && hadFile) {
      const paused = (c.snapshot as { paused: boolean }).paused
      c.playbackAdopted = true
      c.sendLocalState({ paused, position: 0, cause: 'seek' })
      if (mode === 'seek0') quarantineUntilLoad = p.el.loads.length // ignore pushes from the outgoing element
    }
  }
  c.updateSnapshot = (s) => {
    if (quarantineUntilLoad >= 0) {
      if (p.el.loads.length <= quarantineUntilLoad || p.el.readyState === 0) return
      quarantineUntilLoad = -1
    }
    origUpd(s)
  }
}

function post(p: Peer): void {
  const sop = p.ui.beginProgrammaticSeek(0)
  try {
    p.el.currentTime = 0
  } catch {
    sop.retract()
  }
  const op = p.ui.beginProgrammaticPlayback('play', 'episode-start')
  void Promise.resolve(p.el.play()).catch(() => op.retract())
}

async function seat(paused: boolean, skew: number, bLag: number, phase: number, mode: 'off' | 'seek0' | 'seek0-noq'): Promise<[Peer, Peer]> {
  room = await createTwoPeerRoom({ position: 300, paused })
  const a = await room.seat({ username: 'hostuser', position: 300, paused, delayMs: 50, bindGapMs: 500 })
  if (skew) await room.advance(skew / 1000)
  const b = await room.seat({ username: 'joinuser', position: 300 - bLag, paused, delayMs: 50, bindGapMs: 500 })
  patch(a, mode)
  patch(b, mode)
  await room.advance(4 + phase / 1000)
  return [a, b]
}

describe('probe #360 d', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
  })
  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  it('seek-to-0-with-setFile prototype vs shipped', async () => {
    writeFileSync(OUT, '')
    const res: Record<string, Record<string, number>> = {}
    const bump = (k: string, f: string, by = 1): void => {
      res[k] ??= {}
      res[k][f] = (res[k][f] ?? 0) + by
    }
    const bad = (xs: number[]): boolean => xs.some((x) => x > 5)
    for (const mode of (process.env.MODES ?? 'off,seek0').split(',') as ('off' | 'seek0' | 'seek0-noq')[]) {
      for (const paused of [false, true]) {
        for (const [skew, bLag] of [
          [0, 0],
          [350, 0],
          [0, 1.5],
          [350, 1.5]
        ]) {
          for (const g1 of [0, 200, 1000]) {
            for (let phase = 0; phase < 1000; phase += 50) {
              const tag = `${mode} paused=${paused} skew=${skew} bLag=${bLag} g1=${g1}`
              // S3 follow
              {
                const [a, b] = await seat(paused, skew, bLag, phase, mode)
                await a.goToEpisode('8', undefined, g1)
                post(a)
                let guard = 0
                while (b.remoteEpisodes.length === 0 && guard++ < 100) await room!.advance(0.05)
                await room!.advance(0.1)
                const bBefore = b.el.seekWrites.length
                await b.goToEpisode('8', undefined, g1)
                post(b)
                await room!.advance(15)
                bump(`S3 ${tag}`, 'n')
                if (bad(a.el.seekWrites)) bump(`S3 ${tag}`, 'badA')
                if (bad(b.el.seekWrites.slice(bBefore))) bump(`S3 ${tag}`, 'badB')
                if (Math.abs(a.el.currentTime - b.el.currentTime) > 3) bump(`S3 ${tag}`, 'desyncEnd')
                if (a.el.currentTime > 30 || b.el.currentTime > 30) bump(`S3 ${tag}`, 'endPastStart')
                room!.dispose()
                room = undefined
              }
              // S2 both press 300 ms apart
              {
                const [a, b] = await seat(paused, skew, bLag, phase, mode)
                await a.goToEpisode('8', undefined, g1)
                post(a)
                await room!.advance(0.3)
                await b.goToEpisode('8', undefined, g1)
                post(b)
                await room!.advance(15)
                bump(`S2 ${tag}`, 'n')
                if (bad(a.el.seekWrites)) bump(`S2 ${tag}`, 'badA')
                if (bad(b.el.seekWrites)) bump(`S2 ${tag}`, 'badB')
                if (Math.abs(a.el.currentTime - b.el.currentTime) > 3) bump(`S2 ${tag}`, 'desyncEnd')
                room!.dispose()
                room = undefined
              }
              // S1 never-switch
              {
                const [a, b] = await seat(paused, skew, bLag, phase, mode)
                await a.goToEpisode('8', undefined, g1)
                post(a)
                await room!.advance(15)
                bump(`S1 ${tag}`, 'n')
                if (bad(a.el.seekWrites)) bump(`S1 ${tag}`, 'badA')
                if (b.el.seekWrites.length) bump(`S1 ${tag}`, 'dragB')
                bump(`S1 ${tag}`, 'Awrites', a.el.seekWrites.length)
                room!.dispose()
                room = undefined
              }
            }
          }
        }
      }
    }
    for (const [k, v] of Object.entries(res)) log(`${k.padEnd(52)} ${JSON.stringify(v)}`)
  }, 900000)
})
