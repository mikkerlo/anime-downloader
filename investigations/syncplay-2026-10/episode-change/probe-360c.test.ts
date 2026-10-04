// @vitest-environment happy-dom
// PROBE ONLY (research for #360 re-investigation) — not for commit.
import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'

const OUT = process.env.PROBE_OUT ?? '/tmp/probe-360c.txt'
const log = (s: string): void => appendFileSync(OUT, s + '\n')
let room: TwoPeerRoom | undefined
const T0 = new Date('2025-01-01T00:00:00Z').getTime()

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

async function trace(label: string, paused: boolean, skew: number, phase: number, follow: boolean, bLag = 0): Promise<void> {
  room = await createTwoPeerRoom({ position: 300, paused })
  const a = await room.seat({ username: 'hostuser', position: 300, paused, delayMs: 50, bindGapMs: 500 })
  if (skew) await room.advance(skew / 1000)
  const b = await room.seat({ username: 'joinuser', position: 300 - bLag, paused, delayMs: 50, bindGapMs: 500 })
  await room.advance(4 + phase / 1000)
  log(`=== ${label} paused=${paused} skew=${skew} phase=${phase} follow=${follow} switch@${Date.now() - T0}`)
  const peers = [a, b]
  const seen = peers.map((p) => ({ f: p.frames.length, s: p.el.seekWrites.length, ad: p.adopted(), rs: p.el.readyState, w: room!.server.wireOf(p.username).length }))
  const snap = (i: number): void => {
    peers.forEach((p, k) => {
      const t = Date.now() - T0
      const st = seen[k]
      for (const f of p.frames.slice(st.f))
        log(`${t} ${p.username} IN pos=${f.state.position.toFixed(2)} setBy=${f.state.setBy} doSeek=${f.state.doSeek} paused=${f.state.paused} el=${f.element.toFixed(2)} rs=${p.el.readyState}`)
      for (const s of p.el.seekWrites.slice(st.s)) log(`${t} ${p.username} SEEKWRITE ${s.toFixed(2)}`)
      for (const w of room!.server.wireOf(p.username).slice(st.w))
        log(`${t} ${p.username} OUT pos=${(w.position as number).toFixed(2)} ${w.paused === undefined ? 'MIRROR' : 'ASSERT paused=' + w.paused}`)
      if (p.adopted() !== st.ad) log(`${t} ${p.username} adopted=${p.adopted()}`)
      if (p.el.readyState !== st.rs) log(`${t} ${p.username} readyState=${p.el.readyState}`)
      st.f = p.frames.length
      st.s = p.el.seekWrites.length
      st.ad = p.adopted()
      st.rs = p.el.readyState
      st.w = room!.server.wireOf(p.username).length
    })
    void i
  }
  await a.goToEpisode('8')
  snap(0)
  post(a)
  let bSwitched = !follow
  for (let i = 0; i < 160; i++) {
    await room.advance(0.05)
    snap(i)
    if (!bSwitched && b.remoteEpisodes.length > 0) {
      bSwitched = true
      await room.advance(0.1)
      snap(i)
      log(`${Date.now() - T0} joinuser NAV`)
      await b.goToEpisode('8')
      snap(i)
      post(b)
    }
  }
  const rs = room.server.roomState()
  log(`END A.ct=${a.el.currentTime.toFixed(2)} B.ct=${b.el.currentTime.toFixed(2)} room=${rs.position.toFixed(2)}/${rs.setBy}`)
  room.dispose()
  room = undefined
}

describe('probe #360 c', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
  })
  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })
  it('traces', async () => {
    writeFileSync(OUT, '')
    for (let ph = 0; ph < 1000; ph += 50) await trace('S3lag', false, 0, ph, true, 1.5)
  }, 120000)
})
