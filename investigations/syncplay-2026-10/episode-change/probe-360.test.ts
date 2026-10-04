// @vitest-environment happy-dom
// PROBE ONLY (research for #360 re-investigation) — not for commit.
import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, appendFileSync } from 'node:fs'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'

const OUT = process.env.PROBE_OUT ?? '/tmp/probe-360.txt'
const DELAY_MS = 50
let room: TwoPeerRoom | undefined

const log = (s: string): void => appendFileSync(OUT, s + '\n')

async function seat(bindGapA: number, bindGapB: number, phaseMs: number): Promise<[Peer, Peer]> {
  room = await createTwoPeerRoom({ position: 300, paused: false })
  const a = await room.seat({
    username: 'hostuser',
    position: 300,
    paused: false,
    delayMs: DELAY_MS,
    bindGapMs: bindGapA
  })
  const b = await room.seat({
    username: 'joinuser',
    position: 300,
    paused: false,
    delayMs: DELAY_MS,
    bindGapMs: bindGapB
  })
  await room.advance(4 + phaseMs / 1000)
  return [a, b]
}

const fmt = (xs: number[]): string => '[' + xs.map((x) => x.toFixed(2)).join(',') + ']'

describe('probe #360', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
  })
  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  it('trace: one switcher, non-switching peer, gap 500, phase 0 and 300', async () => {
    writeFileSync(OUT, '')
    for (const phase of [0, 300]) {
      const [a, b] = await seat(500, 500, phase)
      log(`=== TRACE phase=${phase} switch at t=${Date.now() - new Date('2025-01-01T00:00:00Z').getTime()}`)
      let fa = a.frames.length
      let fb = b.frames.length
      let wa = room!.server.wireOf('hostuser').length
      await a.goToEpisode('8')
      for (let i = 0; i < 80; i++) {
        const nfA = a.frames.slice(fa).map((f) => `${f.state.position.toFixed(2)}/${f.state.setBy}`)
        const nfB = b.frames.slice(fb).map((f) => `${f.state.position.toFixed(2)}/${f.state.setBy}`)
        const nw = room!.server
          .wireOf('hostuser')
          .slice(wa)
          .map((w) => `${(w.position as number).toFixed(2)}${w.paused === undefined ? 'M' : 'A'}`)
        fa = a.frames.length
        fb = b.frames.length
        wa = room!.server.wireOf('hostuser').length
        const rs = room!.server.roomState()
        log(
          `i=${String(i).padStart(2)} A.ct=${a.el.currentTime.toFixed(2)} rs=${a.el.readyState} adoptA=${a.adopted()} ` +
            `room=${rs.position.toFixed(2)}/${rs.setBy} B.ct=${b.el.currentTime.toFixed(2)} ` +
            `inA=${nfA.join(' ')} inB=${nfB.join(' ')} outA=${nw.join(' ')}`
        )
        await room!.advance(0.05)
      }
      log(`A.seekWrites=${fmt(a.el.seekWrites)} B.seekWrites=${fmt(b.el.seekWrites)}`)
      room!.dispose()
      room = undefined
    }
  })

  it('sweep shapes', async () => {
    const phases = Array.from({ length: 20 }, (_, i) => i * 50)
    const res: Record<string, { badA: number; badB: number; dragB: number; n: number }> = {}
    const bump = (k: string, badA: boolean, badB: boolean, dragB: boolean): void => {
      res[k] ??= { badA: 0, badB: 0, dragB: 0, n: 0 }
      res[k].n++
      if (badA) res[k].badA++
      if (badB) res[k].badB++
      if (dragB) res[k].dragB++
    }
    const isBad = (xs: number[]): boolean => xs.some((x) => x > 5)
    for (const gap of [100, 500, 1500]) {
      for (const g1 of [0, 200, 1000]) {
        for (const phase of phases) {
          // S1: A switches, B never does
          {
            const [a, b] = await seat(gap, gap, phase)
            await a.goToEpisode('8', undefined, g1)
            await room!.advance(12)
            bump(`S1-never gap=${gap} g1=${g1}`, isBad(a.el.seekWrites), false, b.el.seekWrites.length > 0)
            room!.dispose()
            room = undefined
          }
          // S2: both press, B 0..? later (use 300 ms)
          for (const d of [0, 300]) {
            const [a, b] = await seat(gap, gap, phase)
            await a.goToEpisode('8', undefined, g1)
            if (d) await room!.advance(d / 1000)
            const bBefore = b.el.seekWrites.length
            await b.goToEpisode('8', undefined, g1)
            await room!.advance(12)
            bump(
              `S2-both d=${d} gap=${gap} g1=${g1}`,
              isBad(a.el.seekWrites),
              isBad(b.el.seekWrites.slice(bBefore)),
              bBefore > 0
            )
            room!.dispose()
            room = undefined
          }
          // S3: A presses, B follows on remote-episode-change after 100 ms
          {
            const [a, b] = await seat(gap, gap, phase)
            await a.goToEpisode('8', undefined, g1)
            let guard = 0
            while (b.remoteEpisodes.length === 0 && guard++ < 100) await room!.advance(0.05)
            await room!.advance(0.1)
            const bBefore = b.el.seekWrites.length
            await b.goToEpisode('8', undefined, g1)
            await room!.advance(12)
            bump(
              `S3-follow gap=${gap} g1=${g1}`,
              isBad(a.el.seekWrites),
              isBad(b.el.seekWrites.slice(bBefore)),
              bBefore > 0
            )
            room!.dispose()
            room = undefined
          }
        }
      }
    }
    log('=== SWEEP (counts over 20 phases at 50 ms; bad = a seek write > 5 s on the switched element)')
    for (const [k, v] of Object.entries(res)) {
      log(`${k.padEnd(32)} badA=${v.badA}/${v.n} badB=${v.badB}/${v.n} B-dragged-before-own-switch=${v.dragB}/${v.n}`)
    }
  }, 600000)
})
