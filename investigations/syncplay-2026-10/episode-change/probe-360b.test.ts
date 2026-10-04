// @vitest-environment happy-dom
// PROBE ONLY (research for #360 re-investigation) — not for commit.
import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'

const OUT = process.env.PROBE_OUT ?? '/tmp/probe-360b.txt'
const log = (s: string): void => appendFileSync(OUT, s + '\n')
let room: TwoPeerRoom | undefined

interface Opts {
  gap: number
  phase: number
  seatSkewMs: number // B seated this much later (de-phases B's heartbeat from A's/server's)
  bLagS: number // B's element starts this many seconds behind A (B becomes the min watcher)
  paused: boolean
}

async function seat(o: Opts): Promise<[Peer, Peer]> {
  room = await createTwoPeerRoom({ position: 300, paused: o.paused })
  const a = await room.seat({ username: 'hostuser', position: 300, paused: o.paused, delayMs: 50, bindGapMs: o.gap })
  if (o.seatSkewMs) await room.advance(o.seatSkewMs / 1000)
  const b = await room.seat({
    username: 'joinuser',
    position: 300 - o.bLagS,
    paused: o.paused,
    delayMs: 50,
    bindGapMs: o.gap
  })
  await room.advance(4 + o.phase / 1000)
  return [a, b]
}

// PlayerView.goToEpisode's nextTick block (PlayerView.vue:2467-2475 / 2519-2527):
// seekProgrammatically(v, 0) + playProgrammatically(v, 'episode-start').
function playerViewPostBind(p: Peer): void {
  const sop = p.ui.beginProgrammaticSeek(0)
  try {
    p.el.currentTime = 0
  } catch {
    sop.retract()
  }
  const op = p.ui.beginProgrammaticPlayback('play', 'episode-start')
  void Promise.resolve(p.el.play()).catch(() => op.retract())
}

async function nav(p: Peer, g1: number): Promise<{ roomPosAtPrep: number | null }> {
  // Model the MKV prep read: PlayerView.vue:1189-1199 asks main for the room
  // position scoped to the NEW canonical name after the index write + awaits.
  await p.goToEpisode('8', undefined, g1)
  const roomPosAtPrep = await p.api.syncplayGetRoomPosition('Some Anime - 8')
  playerViewPostBind(p)
  return { roomPosAtPrep }
}

describe('probe #360 b', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
  })
  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  it('sweep with PlayerView-faithful post-bind writes', async () => {
    writeFileSync(OUT, '')
    const res: Record<string, Record<string, number>> = {}
    const bump = (k: string, f: string): void => {
      res[k] ??= {}
      res[k][f] = (res[k][f] ?? 0) + 1
    }
    const bad = (xs: number[]): boolean => xs.some((x) => x > 5)
    for (const paused of [false, true]) {
      for (const bLagS of [0, 1.5]) {
        for (const seatSkewMs of [0, 350]) {
          for (const g1 of [0, 200]) {
            for (let phase = 0; phase < 1000; phase += 50) {
              const o: Opts = { gap: 500, phase, seatSkewMs, bLagS, paused }
              const tag = `paused=${paused} bLag=${bLagS} skew=${seatSkewMs} g1=${g1}`
              // S1 never-switch
              {
                const [a, b] = await seat(o)
                const r = await nav(a, g1)
                await room!.advance(12)
                bump(`S1 ${tag}`, 'n')
                if (bad(a.el.seekWrites)) bump(`S1 ${tag}`, 'badA')
                if (r.roomPosAtPrep !== null && r.roomPosAtPrep > 5) bump(`S1 ${tag}`, 'mkvSeedStale')
                if (b.el.seekWrites.length) bump(`S1 ${tag}`, 'dragB')
                room!.dispose()
                room = undefined
              }
              // S3 follow
              {
                const [a, b] = await seat(o)
                const ra = await nav(a, g1)
                let guard = 0
                while (b.remoteEpisodes.length === 0 && guard++ < 100) await room!.advance(0.05)
                await room!.advance(0.1)
                const bBefore = b.el.seekWrites.length
                const rb = await nav(b, g1)
                await room!.advance(12)
                bump(`S3 ${tag}`, 'n')
                if (bad(a.el.seekWrites)) bump(`S3 ${tag}`, 'badA')
                if (bad(b.el.seekWrites.slice(bBefore))) bump(`S3 ${tag}`, 'badB')
                if (ra.roomPosAtPrep !== null && ra.roomPosAtPrep > 5) bump(`S3 ${tag}`, 'mkvSeedStaleA')
                if (rb.roomPosAtPrep !== null && rb.roomPosAtPrep > 5) bump(`S3 ${tag}`, 'mkvSeedStaleB')
                room!.dispose()
                room = undefined
              }
            }
          }
        }
      }
    }
    for (const [k, v] of Object.entries(res)) log(`${k.padEnd(48)} ${JSON.stringify(v)}`)
  }, 900000)
})
