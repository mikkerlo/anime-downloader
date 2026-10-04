// @vitest-environment happy-dom
// PROBE (not for commit): a user seek still in flight when the next room frame lands.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const SEEK_TO = 600
const DELAY_MS = 50

interface Outcome {
  role: string
  landMs: number
  phaseMs: number
  preSetBy: string
  end: number
  reverted: boolean
  doSeekOut: number
  writesAfter: number[]
  firstRevertAt: number | null
  revertFrame: string | null
}

async function runOne(role: 'host' | 'joiner', landMs: number, phaseMs: number): Promise<Outcome> {
  const room: TwoPeerRoom = await createTwoPeerRoom({ position: ROOM_START, paused: false })
  try {
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: role === 'host' ? landMs : 0
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: role === 'joiner' ? landMs : 0
    })
    await room.advance(4 + phaseMs / 1000)
    const me = role === 'host' ? host : joiner
    const preSetBy = me.frames.at(-1)?.state.setBy ?? 'none'
    const writesBefore = me.el.seekWrites.length
    const framesBefore = me.frames.length
    const wireBefore = room.server.wireOf(me.username).length
    const t = room.elapsed()
    const tw = Date.now()
    me.userSeek(SEEK_TO)
    await room.advance(10, Number(process.env.PROBE_STEP ?? 10))
    if (process.env.PROBE_OTHER) {
      const other = role === 'host' ? joiner : host
      for (const w of room.server.wireOf(other.username).filter((x) => x.at >= tw - 1000 && x.at <= tw + 3000))
        console.log(`OTHER-OUT +${w.at - tw} pos=${w.position.toFixed(2)} doSeek=${w.doSeek} room=${w.room.toFixed(2)}`)
      for (const f of other.frames.filter((x) => x.at >= t - 1000 && x.at <= t + 3000))
        console.log(`OTHER-IN +${f.at - t} pos=${f.state.position.toFixed(2)} setBy=${f.state.setBy} doSeek=${f.state.doSeek} el=${f.element.toFixed(2)}`)
      for (const w of room.server.wireOf(me.username).filter((x) => x.at >= tw - 1000 && x.at <= tw + 3000))
        console.log(`ME-OUT +${w.at - tw} pos=${w.position.toFixed(2)} doSeek=${w.doSeek} room=${w.room.toFixed(2)}`)
      for (const f of me.frames.filter((x) => x.at >= t - 1000 && x.at <= t + 3000))
        console.log(`ME-IN +${f.at - t} pos=${f.state.position.toFixed(2)} setBy=${f.state.setBy} doSeek=${f.state.doSeek} el=${f.element.toFixed(2)}`)
      console.log('OTHER writes', JSON.stringify(other.el.seekWrites.map(Math.round)))
    }
    if (process.env.PROBE_TRACE)
      for (const f of me.frames.slice(framesBefore, framesBefore + 6))
        console.log(
          `TRACE ${role} land=${landMs} phase=${phaseMs} +${f.at - t}ms in pos=${f.state.position.toFixed(2)} setBy=${f.state.setBy} doSeek=${f.state.doSeek} el=${f.element.toFixed(2)} | wire-out ${JSON.stringify(
            room.server
              .wireOf(me.username)
              .slice(wireBefore, wireBefore + 4)
              .map((w) => `+${w.at - tw}:${w.position.toFixed(1)}:${w.doSeek ? 'SEEK' : '-'}:room=${w.room.toFixed(1)}`)
          )}`
        )
    const writesAfter = me.el.seekWrites.slice(writesBefore)
    const revertIdx = writesAfter.findIndex((w, i) => i > 0 && Math.abs(w - SEEK_TO) > 20)
    const newFrames = me.frames.slice(framesBefore)
    const rf = newFrames.find((f) => Math.abs(f.state.position - SEEK_TO) > 20 && f.state.setBy)
    return {
      role,
      landMs,
      phaseMs,
      preSetBy,
      end: Math.round(me.el.currentTime),
      reverted: Math.abs(me.el.currentTime - SEEK_TO) > 20,
      doSeekOut: room.server
        .wireOf(me.username)
        .slice(wireBefore)
        .filter((f) => f.doSeek === true).length,
      writesAfter: writesAfter.map((w) => Math.round(w)),
      firstRevertAt: revertIdx >= 0 ? null : null,
      revertFrame: rf
        ? `+${rf.at - t}ms pos=${rf.state.position.toFixed(1)} setBy=${rf.state.setBy} doSeek=${rf.state.doSeek} el=${rf.element.toFixed(1)}`
        : null
    }
  } finally {
    room.dispose()
  }
}

describe('PROBE user seek in flight vs 1 Hz room frame', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('sweeps seek landing time x tick phase x role', async () => {
    const rows: Outcome[] = []
    const lands = (process.env.PROBE_LANDS ?? '0,150,300,500,750,1000,1500,2500').split(',').map(Number)
    const phases = (process.env.PROBE_PHASES ?? '0,200,400,600,800').split(',').map(Number)
    for (const role of ['host', 'joiner'] as const)
      for (const landMs of lands)
        for (const phaseMs of phases) {
          vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
          rows.push(await runOne(role, landMs, phaseMs))
        }
    for (const r of rows) console.log('ROW ' + JSON.stringify(r))
    const summary: Record<string, string> = {}
    for (const role of ['host', 'joiner'])
      for (const landMs of lands) {
        const rs = rows.filter((r) => r.role === role && r.landMs === landMs)
        summary[`${role}@${landMs}`] =
          `${rs.filter((r) => r.reverted).length}/${rs.length} reverted; never-announced(doSeek=0)+reverted ${rs.filter((r) => r.reverted && r.doSeekOut === 0).length}; announced-then-reverted ${rs.filter((r) => r.reverted && r.doSeekOut > 0).length}`
      }
    console.log('SUMMARY ' + JSON.stringify(summary, null, 1))
    expect(rows.length).toBeGreaterThan(0)
  }, 600_000)
})
