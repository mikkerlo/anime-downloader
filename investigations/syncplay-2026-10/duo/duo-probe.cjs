// Two-instance real-stream probe: Syncplay episode changes.
// Two real Electron instances (scratch build of main @ ff432c1), one local real
// Syncplay 1.7.6 server (TLS), real smotret streams. All main handlers real.
// The token is read from TOKEN_FILE into two throwaway XDG profiles that are
// deleted at the end of each series. The token is never logged.
//
//   TOKEN_FILE=... ONLY=Frieren RELAY_MS=0 \
//   xvfb-run -a -s "-screen 0 2700x1000x24" node duo-probe.cjs >> results.jsonl 2>> probe.err
const { _electron: electron } = require('/home/greatkorn/anime-downloader/node_modules/@playwright/test')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const D = __dirname
const SOLO = path.join(D, '../solo')
const APP = path.join(SOLO, 'src-copy/out/main/index.js')
const CA = path.join(D, 'tls/ca.pem')
const SERVER_PORT = 18999
const RELAY_PORT = 18998
const FFMPEG_DIR = path.join(process.env.HOME, '.config/anime-dl-app/ffmpeg')
const TOKEN_FILE = process.env.TOKEN_FILE
const TRACES = path.join(D, 'traces.jsonl')

const PLAN = [
  { animeId: 30414, name: 'Frieren', type: 'subRu', startEp: '1', relayMs: 0,
    scenarios: ['follow:open', 'follow:early', 'follow:mid:key', 'follow:late', 'paused', 'both', 'both', 'auto', 'chain', 'chain', 'chain', 'follow:mid', 'both'] },
  { animeId: 25742, name: 'Spy x Family', type: 'voiceRu', startEp: '1', relayMs: 0,
    scenarios: ['follow:open', 'both', 'paused', 'follow:early:key', 'follow:mid', 'follow:late:key', 'auto', 'chain', 'chain', 'chain', 'both', 'paused'] },
  { animeId: 33130, name: 'Kusuriya no Hitorigoto', type: 'voiceRu', startEp: '3', relayMs: 100,
    scenarios: ['follow:open', 'both', 'paused', 'follow:mid', 'follow:late:key', 'auto', 'chain', 'chain', 'chain', 'both', 'follow:early'] },
  { animeId: 21590, name: 'Jujutsu Kaisen', type: 'subRu', startEp: '5', relayMs: 150,
    scenarios: ['follow:open', 'both', 'both', 'paused', 'follow:early', 'follow:mid:key', 'follow:late', 'auto', 'chain', 'chain', 'chain'] },
  { animeId: 23974, name: 'Chainsaw Man', type: 'subRu', startEp: '2', relayMs: 50,
    scenarios: ['follow:open', 'both', 'paused', 'follow:mid', 'auto', 'chain', 'chain', 'chain', 'both'] }
]

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const trace = (o) => fs.appendFileSync(TRACES, JSON.stringify(o) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const redact = (s) => String(s).replace(/access_token=[^&\s"']+/g, 'access_token=<redacted>').replace(/"token"\s*:\s*"[^"]+"/g, '"token":"<redacted>"')

function seedProfile(token) {
  const xdg = fs.mkdtempSync(path.join(D, 'xdg-duo-'))
  for (const dir of ['Electron', 'anime-dl-app']) {
    const ud = path.join(xdg, 'config', dir)
    fs.mkdirSync(path.join(ud, 'ffmpeg'), { recursive: true })
    for (const b of ['ffmpeg', 'ffprobe']) {
      fs.copyFileSync(path.join(FFMPEG_DIR, b), path.join(ud, 'ffmpeg', b))
      fs.chmodSync(path.join(ud, 'ffmpeg', b), 0o755)
    }
    fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ token, playerVolume: 0, playerMuted: true }), { mode: 0o600 })
  }
  fs.mkdirSync(path.join(xdg, 'data'), { recursive: true })
  fs.mkdirSync(path.join(xdg, 'cache'), { recursive: true })
  return xdg
}

async function launch(name, xdg, x) {
  const mainLog = []
  const app = await electron.launch({
    args: ['--mute-audio', '--no-sandbox', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--disable-background-timer-throttling', APP],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(xdg, 'config'),
      XDG_DATA_HOME: path.join(xdg, 'data'),
      XDG_CACHE_HOME: path.join(xdg, 'cache'),
      NODE_EXTRA_CA_CERTS: CA,
      SYNCPLAY_DEBUG: '1'
    }
  })
  const onMain = (buf) => {
    const at = Date.now()
    // A logged object spans several lines; split the chunk into entries at each tag line.
    let cur = null
    for (const line of String(buf).split('\n')) {
      if (/^\[syncplay\]|stream url failed|API error|429|\[player\]/.test(line)) {
        if (cur) mainLog.push(cur)
        cur = { at, line: redact(line.trim()) }
      } else if (cur && line.trim()) {
        cur.line += ' ' + redact(line.trim())
      }
    }
    if (cur) mainLog.push(cur)
    for (const m of mainLog.slice(-20)) if (m.line.length > 500) m.line = m.line.slice(0, 500)
  }
  app.process().stdout.on('data', onMain)
  app.process().stderr.on('data', onMain)
  let page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }, x) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setBounds({ x, y: 0, width: 1280, height: 760 })
  }, x).catch(() => {})
  await sleep(4000)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await sleep(2000)
  await page.evaluate(() => {
    window.__wire = []
    window.__toasts = []
    window.api.onSyncplayTrace((e) => {
      const m = e.msg || {}
      const st = m.State || null
      const set = m.Set || null
      const rec = { at: Date.now(), dir: e.dir, keys: e.keys }
      if (st) {
        if (st.playstate) rec.ps = st.playstate
        if (st.ignoringOnTheFly) rec.iotf = st.ignoringOnTheFly
      }
      if (set) {
        if (set.file !== undefined) rec.file = set.file ? set.file.name : null
        if (set.user) rec.user = Object.fromEntries(Object.entries(set.user).map(([u, v]) => [u, v && v.file ? v.file.name : (v && v.event ? 'event' : '?')]))
        if (set.ready) rec.ready = set.ready
      }
      if (st || set) window.__wire.push(rec)
    })
    const seen = new Map()
    new MutationObserver(() => {
      for (const cls of ['syncplay-toast', 'resume-toast', 'nav-toast']) {
        const el = document.querySelector('.' + cls)
        const txt = el ? el.textContent.trim() : ''
        if (seen.get(cls) !== txt) {
          seen.set(cls, txt)
          if (txt) window.__toasts.push({ at: Date.now(), cls, txt })
        }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  return { name, app, page, mainLog, xdg }
}

async function connect(inst, port, room) {
  await inst.page.evaluate(({ port, room, user }) =>
    window.api.syncplayConnect({ host: '127.0.0.1', port, room, username: user, autoReconnect: false }), { port, room, user: inst.name })
  const t = Date.now()
  while (Date.now() - t < 20000) {
    const s = await inst.page.evaluate(() => window.api.syncplayGetStatus())
    if (s.state === 'ready') return s
    await sleep(250)
  }
  throw new Error(`${inst.name}: syncplay not ready`)
}

async function resolveSeries(page, plan) {
  return page.evaluate(async ({ animeId, startEp, type }) => {
    const anime = (await window.api.getAnime(animeId)).data
    const eps = anime.episodes.filter((e) => e.isActive === 1 && e.episodeType === anime.type)
    const idx = eps.findIndex((e) => e.episodeInt === startEp)
    const pageStart = Math.floor(idx / 30) * 30
    const ids = eps.slice(pageStart, pageStart + 30).map((e) => e.id)
    const batch = await window.api.getEpisodesBatch(ids, animeId)
    const det = new Map(batch.data.map((d) => [d.id, d]))
    const toTr = (d) => (d?.translations || []).filter((t) => t.isActive === 1).map((t) => ({
      id: t.id, label: t.authorsSummary || t.typeKind, type: t.type, height: t.height
    }))
    const allEpisodes = eps.map((e) => ({
      id: e.id, episodeInt: e.episodeInt, episodeFull: e.episodeFull, translations: toTr(det.get(e.id)), downloadedTrIds: []
    }))
    const cands = allEpisodes[idx].translations.filter((t) => t.type === type).sort((a, b) => b.height - a.height)
    return { title: anime.title, allEpisodes, idx, cands }
  }, plan)
}

async function openOn(inst, ser, plan, tr) {
  return inst.page.evaluate(async ({ ser, plan, tr }) => {
    const r = await window.api.playerGetStreamUrl(tr.id, tr.height)
    if (!r) return { ok: false }
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    pinia._s.get('player').openPlayer({
      filePath: '', streamUrl: r.streamUrl, subtitleContent: r.subtitleContent || '',
      animeName: ser.title, episodeLabel: plan.startEp, availableStreams: r.availableStreams,
      translationId: tr.id, translations: ser.allEpisodes[ser.idx].translations, downloadedTrIds: [],
      allEpisodes: ser.allEpisodes, episodeIndex: ser.idx, animeId: plan.animeId, malId: 0
    })
    return { ok: true }
  }, { ser, plan, tr })
}

async function instrumentVideo(inst) {
  await inst.page.waitForSelector('video.player-video', { timeout: 60000 })
  await inst.page.evaluate(() => {
    const v = document.querySelector('video.player-video')
    const mute = () => { if (!v.muted) v.muted = true; if (v.volume !== 0) v.volume = 0 }
    mute()
    window.__ev = []
    window.__smp = []
    for (const t of ['emptied', 'loadstart', 'loadedmetadata', 'seeking', 'seeked', 'playing', 'pause', 'ended', 'error', 'volumechange', 'play']) {
      v.addEventListener(t, () => {
        if (t === 'volumechange' || t === 'play' || t === 'playing') mute()
        if (t !== 'volumechange') window.__ev.push({ at: Date.now(), t, ct: v.currentTime, src: (v.getAttribute('src') || '').slice(-40) })
      })
    }
    setInterval(() => {
      window.__smp.push({ at: Date.now(), ct: +v.currentTime.toFixed(2), p: v.paused, rs: v.readyState, src: (v.getAttribute('src') || '').slice(-40) })
    }, 200)
  })
}

const stateOf = (inst) => inst.page.evaluate(() => {
  const v = document.querySelector('video.player-video')
  return {
    ct: v.currentTime, dur: v.duration, paused: v.paused, rs: v.readyState, src: v.getAttribute('src') || '',
    label: document.querySelector('.pt-sub')?.textContent?.trim() || '',
    navigating: !!document.querySelector('button[title^="Next episode"]')?.disabled
  }
})
const epIntOf = (label) => (label.match(/Episode (\S+) of/) || [])[1] || ''

async function waitPlayingBoth(A, B, ms = 60000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const [a, b] = await Promise.all([stateOf(A), stateOf(B)])
    if (a.rs >= 3 && b.rs >= 3 && !a.paused && !b.paused && a.ct > 0.3 && b.ct > 0.3) return true
    await sleep(250)
  }
  return false
}

// A user seek on a slow CDN can be reverted by the next 1 Hz room frame while
// it is still in flight (the interrupted seek fires no `seeked`, so it never
// reaches the room). Like a user, retry — alternating instances.
let seekAttempts = 0
async function userSeek(A, B, t) {
  for (let attempt = 0; attempt < 6; attempt++) {
    seekAttempts++
    const who = attempt % 2 === 0 ? A : B
    await who.page.evaluate((t) => { document.querySelector('video.player-video').currentTime = t }, t)
    const t0 = Date.now()
    while (Date.now() - t0 < 10000) {
      const [a, b] = await Promise.all([stateOf(A), stateOf(B)])
      if (a.rs >= 3 && b.rs >= 3 && Math.abs(a.ct - t) < 20 && Math.abs(b.ct - a.ct) < 3) return true
      await sleep(250)
    }
  }
  return false
}

const pressNext = async (inst, how) => {
  if (how === 'key') {
    await inst.page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur())
    await inst.page.keyboard.press('Shift+ArrowRight')
  } else {
    await inst.page.evaluate(() => document.querySelector('button[title^="Next episode"]')?.click())
  }
}

async function collectInstance(inst, pressAt, oldSrc, until) {
  const d = await inst.page.evaluate(({ from, to }) => ({
    ev: window.__ev.filter((e) => e.at >= from && e.at <= to),
    smp: window.__smp.filter((e) => e.at >= from - 1000 && e.at <= to),
    wire: window.__wire.filter((e) => e.at >= from - 3000 && e.at <= to),
    toasts: window.__toasts.filter((e) => e.at >= from - 500 && e.at <= to)
  }), { from: pressAt, to: until })
  const oldTail = oldSrc.slice(-40)
  const lmEv = d.ev.find((e) => e.t === 'loadedmetadata' && e.src !== oldTail)
  const at = (t) => { let best = null; for (const s of d.smp) if (s.at <= t) best = s; return best }
  const res = { srcChanged: !!lmEv }
  if (lmEv) {
    res.lmAt = lmEv.at - pressAt
    res.ctLm = +lmEv.ct.toFixed(2)
    const s2 = at(lmEv.at + 2000), s10 = at(lmEv.at + 10000)
    res.ct2 = s2 && s2.src !== oldTail ? s2.ct : null
    res.ct10 = s10 && s10.src !== oldTail ? s10.ct : null
    // max ct reached on the new src within the first 4 s after metadata (catches a late stale seek)
    res.maxCtFirst4s = Math.max(0, ...d.smp.filter((s) => s.src !== oldTail && s.at >= lmEv.at && s.at <= lmEv.at + 4000).map((s) => s.ct))
  }
  res.toasts = d.toasts.map((t) => ({ t: t.at - pressAt, cls: t.cls, txt: t.txt }))
  const ml = inst.mainLog.filter((m) => m.at >= pressAt - 3000 && m.at <= until)
  return { res, raw: { ev: d.ev.map((e) => ({ ...e, at: e.at - pressAt })), wire: d.wire.map((w) => ({ ...w, at: w.at - pressAt })), smp: d.smp.map((s) => ({ ...s, at: s.at - pressAt })), main: ml.map((m) => ({ t: m.at - pressAt, line: m.line })) } }
}

async function runSeries(plan, token) {
  const room = `duo-${plan.animeId}-${Date.now()}`
  const xa = seedProfile(token), xb = seedProfile(token)
  let relay = null
  let A, B
  try {
    if (plan.relayMs > 0) {
      relay = spawn(process.execPath, [path.join(D, 'relay.cjs'), String(RELAY_PORT), String(SERVER_PORT), String(plan.relayMs)], { stdio: 'ignore' })
      await sleep(500)
    }
    A = await launch('rigA', xa, 0)
    B = await launch('rigB', xb, 1350)
    await connect(A, SERVER_PORT, room)
    await connect(B, plan.relayMs > 0 ? RELAY_PORT : SERVER_PORT, room)
    // which userData dir did electron-store actually write to?
    const wrote = ['Electron', 'anime-dl-app'].map((d) => ({ d, size: fs.statSync(path.join(xa, 'config', d, 'config.json')).size }))
    out({ kind: 'profile-check', series: plan.name, wrote })

    const ser = await resolveSeries(A.page, plan)
    let tr = null
    for (const c of ser.cands) {
      const okA = await openOn(A, ser, plan, c)
      if (okA.ok) { tr = c; break }
    }
    if (!tr) { out({ kind: 'open-fail', series: plan.name }); return }
    await instrumentVideo(A)
    await sleep(6000)
    const okB = await openOn(B, ser, plan, tr)
    if (!okB.ok) { out({ kind: 'open-fail-B', series: plan.name }); return }
    await instrumentVideo(B)
    const playing = await waitPlayingBoth(A, B, 90000)
    out({ kind: 'open', series: plan.name, tr, n: ser.allEpisodes.length, relayMs: plan.relayMs, playing })

    for (let i = 0; i < plan.scenarios.length; i++) {
      const sc = plan.scenarios[i]
      const [kind, pos, how0] = sc.split(':')
      const how = how0 === 'key' ? 'key' : 'button'
      let setupOk = true
      const setupStart = Date.now()
      seekAttempts = 0
      try {
        if (!(await waitPlayingBoth(A, B, 60000))) {
          // a paused room from a previous paused scenario: resume via A's element (user play)
          await A.page.evaluate(() => document.querySelector('video.player-video').play())
          setupOk = await waitPlayingBoth(A, B, 30000)
        }
        if (kind === 'follow' || kind === 'both') {
          if (pos === 'early') setupOk = await userSeek(A, B, 30)
          else if (pos === 'mid') setupOk = await userSeek(A, B, 600 + Math.random() * 60)
          else if (pos === 'late') setupOk = await userSeek(A, B, 1170 + Math.random() * 60)
          else if (kind === 'both') setupOk = await userSeek(A, B, 300 + Math.random() * 300)
          await sleep(2500 + Math.random() * 1500)
        } else if (kind === 'paused') {
          setupOk = await userSeek(A, B, 300 + Math.random() * 300)
          await sleep(2000)
          await A.page.evaluate(() => document.querySelector('video.player-video').pause())
          await sleep(2500)
        } else if (kind === 'auto') {
          const st = await stateOf(A)
          setupOk = await userSeek(A, B, st.dur - 14)
        } else if (kind === 'chain') {
          await sleep(2500 + Math.random() * 1500)
        }
      } catch (e) {
        setupOk = false
        out({ kind: 'setup-error', series: plan.name, sc, err: String(e).slice(0, 200) })
      }
      if (!setupOk) {
        const [da, db] = await Promise.all([collectInstance(A, setupStart, '', Date.now()), collectInstance(B, setupStart, '', Date.now())])
        trace({ kind: 'setup-fail', series: plan.name, idx: i, sc, setupStart, A: da.raw, B: db.raw })
      }
      const [sa, sb] = await Promise.all([stateOf(A), stateOf(B)])
      const fromEp = epIntOf(sa.label)
      const pressAt = Date.now()
      let bPressDelay = null
      if (kind === 'auto') {
        // natural end on both → onVideoEnded → 5 s countdown → goToEpisode('next')
      } else if (kind === 'both') {
        bPressDelay = Math.round(Math.random() * 1000)
        await pressNext(A, how)
        await sleep(bPressDelay)
        const bNav = (await stateOf(B)).navigating
        await pressNext(B, how)
        bPressDelay = { ms: bPressDelay, bAlreadyNavigating: bNav }
      } else {
        await pressNext(A, how)
      }
      // wait until both sources changed
      const deadline = Date.now() + (kind === 'auto' ? 50000 : 35000)
      let ca = false, cb = false
      while (Date.now() < deadline && !(ca && cb)) {
        const [a, b] = await Promise.all([stateOf(A), stateOf(B)])
        ca = ca || (a.src && a.src !== sa.src)
        cb = cb || (b.src && b.src !== sb.src)
        await sleep(100)
      }
      const measureMs = kind === 'chain' ? 3500 : 12500
      await sleep(measureMs)
      const until = Date.now()
      const [ra, rb] = await Promise.all([collectInstance(A, pressAt, sa.src, until), collectInstance(B, pressAt, sb.src, until)])
      const [ea, eb] = await Promise.all([stateOf(A), stateOf(B)])
      const lastIn = [...ra.raw.wire].reverse().find((w) => w.dir === 'in' && w.ps && w.at <= (ra.res.lmAt ?? 0) + 10000)
      const badOf = (r) => r.srcChanged && ((r.ctLm !== undefined && r.ctLm > 5) || (r.ct2 !== null && r.ct2 > 7) || r.maxCtFirst4s > 9)
      const fateOf = (r) => !badOf(r) ? 'ok' : (r.ct10 !== null && r.ct10 < 20 ? 'self-corrected' : (kind === 'chain' ? 'unknown(chain)' : 'stuck'))
      const rec = {
        kind: 'transition', series: plan.name, idx: i, sc, how, relayMs: plan.relayMs, setupOk, seekAttempts,
        fromEp, toEpA: epIntOf(ea.label), toEpB: epIntOf(eb.label), t0A: +sa.ct.toFixed(2), t0B: +sb.ct.toFixed(2),
        pausedAtPress: { A: sa.paused, B: sb.paused }, bPress: bPressDelay,
        A: { ...ra.res, bad: badOf(ra.res), fate: fateOf(ra.res) },
        B: { ...rb.res, bad: badOf(rb.res), fate: fateOf(rb.res) },
        roomPosAtLmPlus10_fromA: lastIn ? { at: lastIn.at, pos: lastIn.ps.position, setBy: lastIn.ps.setBy, paused: lastIn.ps.paused } : null,
        endPaused: { A: ea.paused, B: eb.paused }
      }
      rec.bad = rec.A.bad || rec.B.bad
      out(rec)
      trace({ series: plan.name, idx: i, sc, pressAt, A: ra.raw, B: rb.raw })
      if (rec.toEpA !== rec.toEpB) {
        out({ kind: 'divergent', series: plan.name, idx: i, A: rec.toEpA, B: rec.toEpB })
        break
      }
      const navFail = [...ra.res.toasts, ...rb.res.toasts].some((t) => /Could not open|not available|failed/i.test(t.txt))
      if (!ca || !cb || navFail) {
        out({ kind: 'backoff', series: plan.name, ms: 60000 })
        await sleep(60000)
        if (!ca && !cb) break
      }
      await sleep(kind === 'chain' ? 0 : 3000)
    }
  } catch (e) {
    out({ kind: 'series-error', series: plan.name, err: redact(String(e)).slice(0, 300) })
  } finally {
    for (const inst of [A, B]) if (inst) await inst.app.close().catch(() => {})
    if (relay) relay.kill()
    for (const x of [xa, xb]) fs.rmSync(x, { recursive: true, force: true })
    out({ kind: 'profiles-deleted', series: plan.name, exist: [fs.existsSync(xa), fs.existsSync(xb)] })
  }
}

;(async () => {
  if (!TOKEN_FILE || !fs.existsSync(TOKEN_FILE)) { console.error('TOKEN_FILE missing'); process.exit(2) }
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null
  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : null
  for (const p of PLAN) {
    if (only && !only.includes(p.name)) continue
    const plan = { ...p, scenarios: limit ? p.scenarios.slice(0, limit) : p.scenarios }
    if (process.env.RELAY_MS !== undefined) plan.relayMs = Number(process.env.RELAY_MS)
    await runSeries(plan, token)
    await sleep(10000)
  }
})()
