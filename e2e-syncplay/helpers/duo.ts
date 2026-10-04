// Two built app instances in one room on a real Syncplay 1.7.6 server — the
// Tier 2 rig of #489, rebuilt from the investigation's `duo-probe.cjs` with
// every pitfall that probe paid for scripted here once.
//
// ── The fixture hook is a handler swap, not code in `src/` ─────────────────
//
// `player:get-stream-url` and `player:find-local-file` are replaced from the
// Playwright side after launch, through `app.evaluate()` on the main process:
// `ipcMain.removeHandler(channel)` then `ipcMain.handle(channel, fixture)`
// (`swapPlayerHandlers()`). Nothing in the shipped binary knows the rig exists,
// so the hook is inert in production by construction, and no spec stubs
// anything itself — every spec gets the swap through `launchInstance()`. The
// channel names come from `src/shared/ipc/channels.ts` by symbol. Specs open
// the player with a synthetic `allEpisodes` / `translations` payload
// (`fixtures.ts`), so `getAnime` / `getEpisodesBatch` never reach the network.
//
// ── What each launch does, and why ──────────────────────────────────────────
//
//  - One isolated XDG profile per instance. The userData dir for an `out/`
//    launch is `anime-dl-app` (package.json `name`), and the profile is
//    seeded *there* with `playerVolume: 0` / `playerMuted: true`; seeding the
//    wrong dir fails silently and the run comes up at full volume.
//  - Muted three ways: `--mute-audio`, the seeded profile, and an in-page
//    enforcer on every `play` / `playing` / `volumechange`.
//  - Background throttling and occlusion are disabled, and the whole run is
//    expected under `xvfb-run -a` (`npm run test:e2e:syncplay` does it), so
//    no window takes focus on a real display.
//  - `SYNCPLAY_DEBUG=1` (main-only) turns on the wire-trace stream, and
//    `NODE_EXTRA_CA_CERTS` makes the app trust the throwaway CA.
//  - Timing is anchored to `Date.now()` in both renderers; `performance`'s
//    time origin drifts by hundreds of ms between processes.
//  - The bundled ffmpeg auto-download is not relied on: if the developer's own
//    profile has ffmpeg binaries they are copied in (the MKV path needs them).
//  - Teardown is by explicit pid. `app.close()` first; anything still alive is
//    SIGKILLed by pid. Never `pkill -f`, which matches the shell running it.

import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { bootRealServer, type RealServer } from '../../conformance/helpers/real-server'
import {
  ANIME_ID,
  ANIME_NAME,
  EPISODE_INTS,
  HEIGHTS,
  TRANSLATION_SLOTS,
  allEpisodes,
  ensureFixtures,
  episodeOfTranslation,
  fixtureFile,
  streamPath,
  translationId,
  type Manifest
} from './fixtures'
import { startFixtureServer, type FixtureServer } from './fixture-server'
import { makeTlsDir, probeStartTls, type TlsDir } from './tls'
import { startRelay, type Relay } from './relay'
import { APP_MAIN, RUN_DIR } from './paths'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── The rig: server, TLS, fixtures ─────────────────────────────────────────

export interface Rig {
  readonly server: RealServer
  readonly tls: TlsDir
  readonly fixtures: FixtureServer
  readonly manifest: Manifest
  readonly runDir: string
  relay(delayMs: number): Promise<Relay>
  stop(): Promise<void>
}

/** Retries a setup step (never an assertion — the runner has `retries: 0`). */
export async function setupRetry<T>(what: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await sleep(1000)
    }
  }
  throw new Error(`setup step "${what}" failed ${attempts}×: ${String(last)}`)
}

export async function startRig(opts: { readiness?: boolean } = {}): Promise<Rig> {
  const manifest = ensureFixtures()
  fs.mkdirSync(RUN_DIR, { recursive: true })
  const runDir = fs.mkdtempSync(path.join(RUN_DIR, 'rig-'))
  const tls = makeTlsDir(runDir)
  // Readiness ON by default here: P8 / P9 are about the ready gate, and the
  // conformance default (`--disable-ready`) would make them vacuous.
  const server = await setupRetry('boot syncplay-server', () =>
    bootRealServer({ readiness: opts.readiness ?? true, tlsDir: tls.dir })
  )
  await setupRetry('StartTLS probe', () => probeStartTls(server.port, tls.caPath))
  const fixtures = await startFixtureServer()
  const relays: Relay[] = []
  return {
    server,
    tls,
    fixtures,
    manifest,
    runDir,
    relay: async (delayMs) => {
      const r = await startRelay(server.port, delayMs)
      relays.push(r)
      return r
    },
    stop: async () => {
      for (const r of relays) await r.close().catch(() => {})
      await fixtures.close().catch(() => {})
      await server.stop().catch(() => {})
      fs.rmSync(runDir, { recursive: true, force: true })
    }
  }
}

// ── One instance ────────────────────────────────────────────────────────────

export interface WireRec {
  at: number
  dir: string
  ps?: { position: number; paused: boolean; doSeek?: boolean; setBy?: string | null }
  file?: string | null
  ready?: unknown
}
export interface MediaEv {
  at: number
  t: string
  ct: number
  src: string
}
export interface Sample {
  at: number
  ct: number
  p: boolean
  rs: number
  src: string
}
export interface Toast {
  at: number
  cls: string
  txt: string
}

export interface PlayerState {
  ct: number
  dur: number
  paused: boolean
  rs: number
  src: string
  label: string
  navigating: boolean
}

export interface Instance {
  readonly name: string
  readonly app: ElectronApplication
  readonly page: Page
  readonly pid: number | undefined
  readonly mainLog: { at: number; line: string }[]
  connect(port: number, room: string): Promise<void>
  open(
    episodeInt: string,
    opts?: { slot?: number; height?: number; local?: boolean }
  ): Promise<void>
  state(): Promise<PlayerState>
  pressNext(how?: 'button' | 'key'): Promise<void>
  pressPrev(): Promise<void>
  togglePlayButton(): Promise<void>
  /** A user seek: a bare `currentTime` write, the way the seek bar does it. */
  seek(t: number): Promise<void>
  switchTranslation(): Promise<void>
  switchQuality(): Promise<void>
  /** Everything recorded since `from` (Date.now() ms), relative to `from`. */
  collect(from: number): Promise<{ ev: MediaEv[]; smp: Sample[]; wire: WireRec[]; toasts: Toast[] }>
  close(): Promise<void>
}

export interface LaunchOpts {
  /** Translation ids `player:find-local-file` resolves to a fixture file (M7). */
  local?: number[]
  /** Translation ids `player:get-stream-url` fails for (E9). */
  failing?: number[]
  /** How long the swapped `player:get-stream-url` takes to answer — the
   *  embed-API round trip a real stream resolve costs. #487's window is
   *  "link delay + this", so an instant answer would shrink it to nothing.
   *  Defaults to 300 ms. */
  resolveMs?: number
}

function seedProfile(runDir: string, name: string): string {
  const xdg = fs.mkdtempSync(path.join(runDir, `xdg-${name}-`))
  const ud = path.join(xdg, 'config', 'anime-dl-app')
  fs.mkdirSync(ud, { recursive: true })
  fs.writeFileSync(
    path.join(ud, 'config.json'),
    JSON.stringify({ playerVolume: 0, playerMuted: true }),
    { mode: 0o600 }
  )
  // The MKV path needs ffmpeg; the app's own auto-download is not something a
  // test should wait on. Copy the developer's (or CI's pre-seeded) binaries.
  const ff = path.join(os.homedir(), '.config', 'anime-dl-app', 'ffmpeg')
  if (fs.existsSync(path.join(ff, 'ffmpeg'))) {
    fs.mkdirSync(path.join(ud, 'ffmpeg'), { recursive: true })
    for (const b of ['ffmpeg', 'ffprobe']) {
      if (!fs.existsSync(path.join(ff, b))) continue
      fs.copyFileSync(path.join(ff, b), path.join(ud, 'ffmpeg', b))
      fs.chmodSync(path.join(ud, 'ffmpeg', b), 0o755)
    }
  }
  fs.mkdirSync(path.join(xdg, 'data'), { recursive: true })
  fs.mkdirSync(path.join(xdg, 'cache'), { recursive: true })
  return xdg
}

/**
 * Replace the two player handlers that would reach the network or the
 * download store with fixture-backed ones. Runs in the main process; every
 * value it needs is passed in, because the function is serialised.
 */
export async function swapPlayerHandlers(
  app: ElectronApplication,
  cfg: { base: string; local: number[]; failing: number[]; resolveMs: number }
): Promise<void> {
  const trMap: Record<number, string> = {}
  for (const ep of EPISODE_INTS)
    for (const t of TRANSLATION_SLOTS) trMap[translationId(ep, t.slot)] = ep
  const streams: Record<number, { height: number; url: string }[]> = {}
  for (const id of Object.keys(trMap).map(Number)) {
    streams[id] = HEIGHTS.map((h) => ({ height: h, url: cfg.base + streamPath(id, h) }))
  }
  const localFiles: Record<number, string> = {}
  for (const id of cfg.local) {
    const ep = episodeOfTranslation(id)
    if (ep) localFiles[id] = fixtureFile(ep, HEIGHTS[0])
  }
  await app.evaluate(
    ({ ipcMain }, a) => {
      ipcMain.removeHandler(a.streamChannel)
      ipcMain.handle(a.streamChannel, async (_e, trId: number, maxHeight: number) => {
        if (a.resolveMs > 0) await new Promise((r) => setTimeout(r, a.resolveMs))
        if (a.failing.includes(trId)) return null
        const list = a.streams[trId]
        if (!list) return null
        const best = list.find((s) => s.height <= maxHeight) ?? list[0]
        return { streamUrl: best.url, subtitleContent: null, availableStreams: list }
      })
      ipcMain.removeHandler(a.localChannel)
      ipcMain.handle(a.localChannel, async (_e, _name: string, _ep: string, trId: number) => {
        const f = a.localFiles[trId]
        return f ? { filePath: f, subtitleContent: null } : null
      })
    },
    {
      streamChannel: CHANNELS.PLAYER_GET_STREAM_URL,
      localChannel: CHANNELS.PLAYER_FIND_LOCAL_FILE,
      streams,
      localFiles,
      failing: cfg.failing,
      resolveMs: cfg.resolveMs
    }
  )
}

export async function launchInstance(
  rig: Rig,
  name: string,
  opts: LaunchOpts = {}
): Promise<Instance> {
  const xdg = seedProfile(rig.runDir, name)
  const mainLog: { at: number; line: string }[] = []
  const app = await setupRetry(`launch ${name}`, () =>
    electron.launch({
      args: [
        '--mute-audio',
        '--no-sandbox',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        APP_MAIN
      ],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(xdg, 'config'),
        XDG_DATA_HOME: path.join(xdg, 'data'),
        XDG_CACHE_HOME: path.join(xdg, 'cache'),
        NODE_EXTRA_CA_CERTS: rig.tls.caPath,
        SYNCPLAY_DEBUG: '1'
      }
    })
  )
  const pid = app.process().pid
  const onMain = (buf: Buffer): void => {
    const at = Date.now()
    for (const line of String(buf).split('\n')) {
      if (/^\[syncplay\]|^\[player\]/.test(line))
        mainLog.push({ at, line: line.trim().slice(0, 400) })
    }
  }
  app.process().stdout?.on('data', onMain)
  app.process().stderr?.on('data', onMain)

  await swapPlayerHandlers(app, {
    base: rig.fixtures.base,
    local: opts.local ?? [],
    failing: opts.failing ?? [],
    resolveMs: opts.resolveMs ?? 300
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // The cold-start IPC race (first window's listeners can miss the earliest
  // broadcasts): settle, then reload once, as every capture rig here does.
  await sleep(2500)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!(window as unknown as { api?: unknown }).api, null, {
    timeout: 30_000
  })
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    if (w.__rig) return
    const wire: unknown[] = []
    const toasts: unknown[] = []
    w.__rig = { wire, toasts, ev: [], smp: [] }
    window.api.onSyncplayTrace((e) => {
      const m = (e.msg ?? {}) as {
        State?: { playstate?: Record<string, unknown> }
        Set?: { file?: { name?: string } | null; ready?: unknown }
      }
      const rec: Record<string, unknown> = { at: Date.now(), dir: e.dir }
      if (m.State?.playstate) rec.ps = m.State.playstate
      if (m.Set && m.Set.file !== undefined) rec.file = m.Set.file ? m.Set.file.name : null
      if (m.Set?.ready) rec.ready = m.Set.ready
      if (m.State || m.Set) wire.push(rec)
    })
    const seen = new Map<string, string>()
    new MutationObserver(() => {
      for (const cls of ['syncplay-toast', 'resume-toast', 'nav-toast']) {
        const el = document.querySelector('.' + cls)
        const txt = el?.textContent?.trim() ?? ''
        if (seen.get(cls) !== txt) {
          seen.set(cls, txt)
          if (txt) toasts.push({ at: Date.now(), cls, txt })
        }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })

  const instrument = async (): Promise<void> => {
    await page.waitForSelector('video.player-video', { timeout: 60_000 })
    await page.evaluate(() => {
      const v = document.querySelector('video.player-video') as HTMLVideoElement
      const rig = (window as unknown as { __rig: Record<string, unknown[]> }).__rig
      if ((v as unknown as { __rigged?: boolean }).__rigged) return
      ;(v as unknown as { __rigged?: boolean }).__rigged = true
      const mute = (): void => {
        if (!v.muted) v.muted = true
        if (v.volume !== 0) v.volume = 0
      }
      mute()
      for (const t of [
        'emptied',
        'loadstart',
        'loadedmetadata',
        'seeking',
        'seeked',
        'playing',
        'pause',
        'play',
        'ended',
        'error',
        'volumechange'
      ]) {
        v.addEventListener(t, () => {
          if (t === 'volumechange' || t === 'play' || t === 'playing') mute()
          if (t !== 'volumechange') {
            rig.ev.push({
              at: Date.now(),
              t,
              ct: v.currentTime,
              src: (v.getAttribute('src') ?? '').slice(-40)
            })
          }
        })
      }
      setInterval(() => {
        rig.smp.push({
          at: Date.now(),
          ct: +v.currentTime.toFixed(2),
          p: v.paused,
          rs: v.readyState,
          src: (v.getAttribute('src') ?? '').slice(-40)
        })
      }, 200)
    })
  }

  const inst: Instance = {
    name,
    app,
    page,
    pid,
    mainLog,
    connect: async (port, room) => {
      await page.evaluate(
        ({ port, room, user }) =>
          window.api.syncplayConnect({
            host: '127.0.0.1',
            port,
            room,
            username: user,
            autoReconnect: false
          }),
        { port, room, user: name }
      )
      const until = Date.now() + 20_000
      while (Date.now() < until) {
        const s = await page.evaluate(() => window.api.syncplayGetStatus())
        if (s.state === 'ready') return
        await sleep(250)
      }
      throw new Error(`${name}: syncplay never reached ready`)
    },
    open: async (episodeInt, o = {}) => {
      const slot = o.slot ?? 1
      const height = o.height ?? HEIGHTS[0]
      const trId = translationId(episodeInt, slot)
      const eps = allEpisodes(o.local ? [trId] : [])
      const idx = EPISODE_INTS.indexOf(episodeInt as (typeof EPISODE_INTS)[number])
      await page.evaluate(
        async ({ trId, height, eps, idx, animeName, animeId, local }) => {
          let streamUrl = ''
          let availableStreams: { height: number; url: string }[] = []
          let filePath = ''
          if (local) {
            const r = await window.api.playerFindLocalFile(
              animeName,
              eps[idx].episodeInt,
              trId,
              eps[idx].episodeFull
            )
            if (!r) throw new Error('fixture local file not found')
            filePath = r.filePath
          } else {
            const r = await window.api.playerGetStreamUrl(trId, height)
            if (!r) throw new Error('fixture stream not found')
            streamUrl = r.streamUrl
            availableStreams = r.availableStreams
          }
          const app = document.querySelector('#app') as unknown as {
            __vue_app__: {
              config: {
                globalProperties: {
                  $pinia: { _s: Map<string, { openPlayer: (p: unknown) => void }> }
                }
              }
            }
          }
          app.__vue_app__.config.globalProperties.$pinia._s.get('player')!.openPlayer({
            filePath,
            streamUrl,
            subtitleContent: '',
            animeName,
            episodeLabel: eps[idx].episodeInt,
            availableStreams,
            translationId: trId,
            translations: eps[idx].translations,
            downloadedTrIds: eps[idx].downloadedTrIds,
            allEpisodes: eps,
            episodeIndex: idx,
            animeId,
            malId: 0
          })
        },
        { trId, height, eps, idx, animeName: ANIME_NAME, animeId: ANIME_ID, local: !!o.local }
      )
      await instrument()
    },
    state: () =>
      page.evaluate(() => {
        const v = document.querySelector('video.player-video') as HTMLVideoElement | null
        return {
          ct: v?.currentTime ?? NaN,
          dur: v?.duration ?? NaN,
          paused: v?.paused ?? true,
          rs: v?.readyState ?? 0,
          src: v?.getAttribute('src') ?? '',
          label: document.querySelector('.pt-sub')?.textContent?.trim() ?? '',
          navigating: !!(
            document.querySelector('button[title^="Next episode"]') as HTMLButtonElement | null
          )?.disabled
        }
      }),
    pressNext: async (how = 'button') => {
      if (how === 'key') {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
        await page.keyboard.press('Shift+ArrowRight')
      } else {
        await page.evaluate(() =>
          (
            document.querySelector('button[title^="Next episode"]') as HTMLButtonElement | null
          )?.click()
        )
      }
    },
    pressPrev: async () => {
      await page.evaluate(() =>
        (
          document.querySelector('button[title^="Previous episode"]') as HTMLButtonElement | null
        )?.click()
      )
    },
    togglePlayButton: async () => {
      await page.evaluate(() =>
        (document.querySelector('button.ctrl-btn.big') as HTMLButtonElement | null)?.click()
      )
    },
    seek: async (t) => {
      await page.evaluate((t) => {
        ;(document.querySelector('video.player-video') as HTMLVideoElement).currentTime = t
      }, t)
    },
    // The menu waits are `attached`, not visible: the control bar auto-hides
    // while the element plays, and the clicks here are DOM clicks.
    switchTranslation: async () => {
      await page.evaluate(() =>
        (document.querySelector('button[title="Translation"]') as HTMLButtonElement).click()
      )
      await page.waitForSelector(
        '.translation-menu .preset-option:not(.selected):not(.back-option)',
        {
          state: 'attached'
        }
      )
      await page.evaluate(() =>
        (
          document.querySelector(
            '.translation-menu .preset-option:not(.selected):not(.back-option)'
          ) as HTMLButtonElement
        ).click()
      )
    },
    switchQuality: async () => {
      await page.evaluate(() =>
        (document.querySelector('button[title="Video quality"]') as HTMLButtonElement).click()
      )
      await page.waitForSelector('.preset-menu .preset-option:not(.selected)', {
        state: 'attached'
      })
      await page.evaluate(() =>
        (
          document.querySelector('.preset-menu .preset-option:not(.selected)') as HTMLButtonElement
        ).click()
      )
    },
    collect: async (from) => {
      const d = await page.evaluate((from) => {
        const rig = (window as unknown as { __rig: Record<string, { at: number }[]> }).__rig
        const since = (xs: { at: number }[]): unknown[] => xs.filter((x) => x.at >= from)
        return {
          ev: since(rig.ev),
          smp: since(rig.smp),
          wire: since(rig.wire),
          toasts: since(rig.toasts)
        }
      }, from)
      const rel = <T extends { at: number }>(xs: T[]): T[] =>
        xs.map((x) => ({ ...x, at: x.at - from }))
      return {
        ev: rel(d.ev as MediaEv[]),
        smp: rel(d.smp as Sample[]),
        wire: rel(d.wire as WireRec[]),
        toasts: rel(d.toasts as Toast[])
      }
    },
    close: async () => {
      await Promise.race([app.close().catch(() => {}), sleep(10_000)])
      if (pid) {
        try {
          process.kill(pid, 0)
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(xdg, { recursive: true, force: true })
    }
  }
  return inst
}

// ── Room-level helpers ─────────────────────────────────────────────────────

export const epIntOf = (label: string): string => (label.match(/Episode (\S+) of/) ?? [])[1] ?? ''

export async function waitFor(
  what: string,
  pred: () => Promise<boolean>,
  ms = 30_000,
  stepMs = 200
): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await pred()) return true
    await sleep(stepMs)
  }
  void what
  return false
}

export async function bothPlaying(A: Instance, B: Instance, ms = 60_000): Promise<boolean> {
  return waitFor(
    'both playing',
    async () => {
      const [a, b] = await Promise.all([A.state(), B.state()])
      return a.rs >= 3 && b.rs >= 3 && !a.paused && !b.paused && a.ct > 0.3 && b.ct > 0.3
    },
    ms,
    250
  )
}

/**
 * The positioning helper the issue's Risks section asks for: a setup seek can
 * itself be undone by #488, so it is retried — alternating instances, as a
 * user would — until both elements sit within 20 s of the target and within
 * 3 s of each other. Setup, so retrying is allowed; it reports failure rather
 * than throwing, and a spec counts a failed setup as not-scoreable.
 */
export async function positionBoth(A: Instance, B: Instance, t: number): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const who = attempt % 2 === 0 ? A : B
    await who.seek(t)
    const ok = await waitFor(
      'positioned',
      async () => {
        const [a, b] = await Promise.all([A.state(), B.state()])
        return a.rs >= 2 && b.rs >= 2 && Math.abs(a.ct - t) < 20 && Math.abs(b.ct - a.ct) < 3
      },
      10_000,
      250
    )
    if (ok) return true
  }
  return false
}

/** Launch two instances, join one fresh room, open episode `startEp` on both. */
export async function seatDuo(
  rig: Rig,
  opts: {
    startEp?: string
    relayMs?: number
    room?: string
    a?: LaunchOpts & { local?: number[] }
    b?: LaunchOpts & { local?: number[] }
    openLocalA?: boolean
    openLocalB?: boolean
    /** Skip the opening Play press; the room stays as Syncplay created it. */
    leavePaused?: boolean
  } = {}
): Promise<{ A: Instance; B: Instance; relay: Relay | null; room: string }> {
  const room = opts.room ?? `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const startEp = opts.startEp ?? '1'
  const relay = opts.relayMs ? await rig.relay(opts.relayMs) : null
  const A = await launchInstance(rig, 'rigA', opts.a)
  const B = await launchInstance(rig, 'rigB', opts.b)
  await setupRetry('A connect', () => A.connect(rig.server.port, room))
  await setupRetry('B connect', () => B.connect(relay ? relay.port : rig.server.port, room))
  await A.open(startEp, { local: opts.openLocalA })
  await sleep(3000)
  await B.open(startEp, { local: opts.openLocalB })
  if (!opts.leavePaused) {
    // A fresh Syncplay room starts paused, and both players open into it
    // paused. Start the session the way a user would: press Play on A.
    await waitFor(
      'both loaded',
      async () => {
        const [a, b] = await Promise.all([A.state(), B.state()])
        return a.rs >= 1 && b.rs >= 1
      },
      30_000
    )
    await sleep(1500)
    if ((await A.state()).paused) await A.togglePlayButton()
    await bothPlaying(A, B, 30_000)
  }
  return { A, B, relay, room }
}

export async function closeDuo(...insts: (Instance | undefined)[]): Promise<void> {
  for (const i of insts) if (i) await i.close()
}
