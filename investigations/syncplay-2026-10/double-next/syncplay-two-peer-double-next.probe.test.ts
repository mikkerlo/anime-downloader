// @vitest-environment happy-dom
//
// PROBE (research, not for merge): both peers press "next episode" d ms apart.
// Real main SyncplayClient + real use-syncplay-client composable + real
// `walkEpisodeSteps`, wired through the two-peer harness. The navigator on top
// is a model of PlayerView's `goToEpisode` / `handleRemoteEpisodeChange`
// (there is no PlayerView mount harness); the source-scan block below pins the
// three properties of the real code the model relies on.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'
import { walkEpisodeSteps } from '../../src/renderer/src/utils'
import type { EpisodeStepOutcome } from '../../src/renderer/src/utils'

const EPISODES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
const DELAY_MS = Number(process.env.PROBE_DELAY_MS ?? 50)
const RESOLVE_MS = Number(process.env.PROBE_RESOLVE_MS ?? 400)

interface Nav {
  idx(): number
  navigating(): boolean
  pressNext(): 'dispatched' | 'button-disabled'
  log: string[]
}

function attachNavigator(peer: Peer, startIdx: number, t0: number): Nav {
  let idx = startIdx
  let navigating = false
  let epoch = 0
  const log: string[] = []
  const at = (): number => Date.now() - t0

  async function goToEpisode(dir: 'prev' | 'next', why: string): Promise<EpisodeStepOutcome> {
    // PlayerView.vue:2262-2263 — target read from activeEpisodeIndex at entry
    const target = dir === 'prev' ? idx - 1 : idx + 1
    if (target < 0 || target >= EPISODES.length) return 'unreachable'
    // PlayerView.vue:2274
    if (navigating) {
      log.push(`${at()} ${peer.username} goToEpisode(${why}) superseded`)
      return 'superseded'
    }
    await Promise.resolve() // saveProgress(true), :2277
    navigating = true // :2285
    const my = ++epoch
    await Promise.resolve() // resolveEpisodeTranslation (cached) + cleanup, :2304/:2365
    if (epoch !== my) return 'superseded'
    idx = target // commit, :2374 -> pre-flush watcher -> Set file
    log.push(`${at()} ${peer.username} commit ep${EPISODES[target]} (${why})`)
    await peer.goToEpisode(EPISODES[target])
    await new Promise((r) => setTimeout(r, RESOLVE_MS)) // playerGetStreamUrl, :2484
    if (epoch !== my) return 'moved'
    await Promise.resolve() // nextTick, :2522-2532
    navigating = false
    log.push(`${at()} ${peer.username} release navigating`)
    return 'moved'
  }

  // PlayerView.vue handleRemoteEpisodeChange (~:507): absolute index lookup,
  // then a relative walk gated on !navigating.
  const handleRemote = (episodeInt: string, from: string): void => {
    const i = EPISODES.indexOf(episodeInt)
    log.push(`${at()} ${peer.username} remote ep${episodeInt} from ${from} (local idx ep${EPISODES[idx]}, nav=${navigating})`)
    if (i < 0 || i === idx) return
    const dir = i > idx ? 'next' : 'prev'
    void walkEpisodeSteps(
      () => idx !== i && !navigating,
      () => goToEpisode(dir, 'follow')
    )
  }
  const arr = peer.remoteEpisodes as unknown as { push: (...x: unknown[]) => number }
  const origPush = Array.prototype.push
  arr.push = function (...eps: unknown[]) {
    const n = origPush.apply(this, eps)
    for (const e of eps as { episodeInt: string; fromUser: string }[]) handleRemote(e.episodeInt, e.fromUser)
    return n
  }

  return {
    idx: () => idx,
    navigating: () => navigating,
    // EpisodeNavButton :disabled="!canNext || navigating" (PlayerView.vue:3164)
    pressNext: () => {
      if (navigating) {
        log.push(`${at()} ${peer.username} press next: button disabled`)
        return 'button-disabled'
      }
      log.push(`${at()} ${peer.username} press next from ep${EPISODES[idx]}`)
      void goToEpisode('next', 'press')
      return 'dispatched'
    },
    log
  }
}

describe('PROBE — both peers press next d ms apart', () => {
  let room: TwoPeerRoom | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
  })
  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  async function run(dMs: number): Promise<{ a: string; b: string; bPress: string; log: string[] }> {
    room = await createTwoPeerRoom({ position: 100, paused: false })
    const A = await room.seat({ username: 'rigA', position: 100, paused: false, delayMs: DELAY_MS, episodeInt: '6' })
    const B = await room.seat({ username: 'rigB', position: 100, paused: false, delayMs: DELAY_MS, episodeInt: '6' })
    await room.advance(4)
    const t0 = Date.now()
    const na = attachNavigator(A, 5, t0)
    const nb = attachNavigator(B, 5, t0)
    na.pressNext()
    if (dMs > 0) await room.advance(dMs / 1000)
    const bPress = nb.pressNext()
    await room.advance(6)
    const log = [...na.log, ...nb.log].sort((x, y) => parseInt(x) - parseInt(y))
    return { a: EPISODES[na.idx()], b: EPISODES[nb.idx()], bPress, log }
  }

  it('sweeps d over 0..1000 ms', async () => {
    const rows: string[] = []
    for (let d = 0; d <= 1000; d += 50) {
      const r = await run(d)
      rows.push(`d=${String(d).padStart(4)}  A=ep${r.a} B=ep${r.b}  bPress=${r.bPress}`)
      room?.dispose()
      room = undefined
    }
    console.log(`DELAY_MS=${DELAY_MS} RESOLVE_MS=${RESOLVE_MS}\n` + rows.join('\n'))
    expect(rows.length).toBe(21)
  }, 120_000)

  it('double-advances when B presses after its follow released navigating', async () => {
    const d = 2 * DELAY_MS + RESOLVE_MS + 100
    const r = await run(d)
    console.log(`d=${d}\n` + r.log.join('\n'))
    expect([r.a, r.b]).toEqual(['8', '8'])
  })

  it('single-advances when B presses while its follow is in flight', async () => {
    const r = await run(2 * DELAY_MS + 100)
    console.log(r.log.join('\n'))
    expect([r.a, r.b, r.bPress]).toEqual(['7', '7', 'button-disabled'])
  })
})

// The three properties of the real code the navigator model relies on.
describe('PROBE — PlayerView source anchors for the model', () => {
  const SRC = readFileSync(resolve(__dirname, '../../src/renderer/src/components/views/PlayerView.vue'), 'utf8')
  const body = SRC.slice(SRC.indexOf('async function goToEpisode('), SRC.indexOf('function cancelAutoAdvance('))
  it('reads the target relative to activeEpisodeIndex at entry, before the navigating guard', () => {
    const tgt = body.indexOf("direction === 'prev' ? activeEpisodeIndex.value - 1 : activeEpisodeIndex.value + 1")
    expect(tgt).toBeGreaterThan(-1)
    expect(tgt).toBeLessThan(body.indexOf("if (navigating.value) return 'superseded';"))
  })
  it('releases navigating in the nextTick after the stream URL resolves, not on loadedmetadata', () => {
    const url = body.indexOf('await window.api.playerGetStreamUrl(resolvedTr.id, resolvedTr.height)')
    const rel = body.indexOf('navigating.value = false;\n    });\n    return \'moved\';', url)
    expect(url).toBeGreaterThan(-1)
    expect(rel).toBeGreaterThan(url)
  })
  it('follows a remote change as a relative walk gated on !navigating', () => {
    expect(SRC.replace(/\s+/g, ' ')).toContain(
      "() => activeEpisodeIndex.value !== idx && !navigating.value && translationEpoch === walkTranslation, () => goToEpisode(dir)"
    )
  })
})
