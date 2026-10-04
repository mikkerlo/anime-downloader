// Real-stream probe for "plain next starts the new episode at the old timestamp".
// Every main-process handler is real (smotret embed resolution, watch-progress
// store); the only thing seeded is the API token, read from TOKEN_FILE into an
// isolated throwaway XDG profile that is deleted at the end. Never logs the token.
//
// Usage:
//   TOKEN_FILE=/path/to/file-containing-only-the-token \
//   xvfb-run -a node real-probe.cjs > real-probe.jsonl 2> real-probe.err
const { _electron: electron } = require('/home/greatkorn/anime-downloader/node_modules/@playwright/test')
const fs = require('fs')
const path = require('path')

const S = __dirname
const APP = path.join(S, 'src-copy/out/main/index.js')
const TOKEN_FILE = process.env.TOKEN_FILE
if (!TOKEN_FILE || !fs.existsSync(TOKEN_FILE)) {
  console.error('TOKEN_FILE missing')
  process.exit(2)
}

// Plain sequential TV numbering, numberOfEpisodes == active tv episodes.
// `scenarios` is the ordered list of transitions run in that series' session.
const PLAN = [
  { animeId: 30414, name: 'Frieren', type: 'subRu', startEp: '1',
    scenarios: ['open', 'early', 'mid', 'late', 'paused', 'seek', 'keyboard', 'chain', 'chain', 'chain'] },
  { animeId: 25742, name: 'Spy x Family', type: 'voiceRu', startEp: '1',
    scenarios: ['open', 'early', 'paused', 'mid', 'seek', 'keyboard', 'late', 'auto', 'auto'] },
  { animeId: 23974, name: 'Chainsaw Man', type: 'subRu', startEp: '2',
    scenarios: ['open', 'keyboard', 'early', 'seek', 'late', 'paused', 'mid', 'chain', 'chain', 'chain'] },
  { animeId: 33130, name: 'Kusuriya no Hitorigoto', type: 'voiceRu', startEp: '3',
    scenarios: ['open', 'seek', 'early', 'mid', 'paused', 'keyboard', 'late', 'auto'] },
  { animeId: 21590, name: 'Jujutsu Kaisen', type: 'subRu', startEp: '5',
    scenarios: ['open', 'early', 'keyboard', 'paused', 'seek', 'mid', 'late'] }
]

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runSeries(plan, token) {
  const xdg = fs.mkdtempSync(path.join(S, 'xdg-real-'))
  const ud = path.join(xdg, 'Electron')
  fs.mkdirSync(path.join(ud, 'ffmpeg'), { recursive: true })
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ token }), { mode: 0o600 })
  const mainErrors = []
  let app
  try {
    app = await electron.launch({
      args: ['--mute-audio', '--no-sandbox', APP],
      env: { ...process.env, XDG_CONFIG_HOME: xdg }
    })
    const proc = app.process()
    const onMain = (buf) => {
      for (const line of String(buf).split('\n')) {
        if (/stream url failed|API error|429/.test(line)) mainErrors.push({ at: Date.now(), line: line.replace(/access_token=[^&\s]+/g, 'access_token=<redacted>').slice(0, 300) })
      }
    }
    proc.stdout.on('data', onMain)
    proc.stderr.on('data', onMain)

    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await sleep(4000)
    await page.reload() // cold-profile IPC race (README-capture notes)
    await page.waitForLoadState('domcontentloaded')
    await sleep(2000)

    // Open exactly like use-open-episode.ts, through the real window.api.
    const opened = await page.evaluate(async ({ animeId, startEp, type }) => {
      const anime = (await window.api.getAnime(animeId)).data
      const eps = anime.episodes.filter((e) => e.isActive === 1 && e.episodeType === anime.type)
      const idx = eps.findIndex((e) => e.episodeInt === startEp)
      const pageStart = Math.floor(idx / 30) * 30
      const ids = eps.slice(pageStart, pageStart + 30).map((e) => e.id)
      const batch = await window.api.getEpisodesBatch(ids, animeId)
      const det = new Map(batch.data.map((d) => [d.id, d]))
      const toTr = (d) =>
        (d?.translations || []).filter((t) => t.isActive === 1).map((t) => ({
          id: t.id, label: t.authorsSummary || t.typeKind, type: t.type, height: t.height
        }))
      const allEpisodes = eps.map((e) => ({
        id: e.id, episodeInt: e.episodeInt, episodeFull: e.episodeFull,
        translations: toTr(det.get(e.id)), downloadedTrIds: []
      }))
      const target = allEpisodes[idx]
      const cands = target.translations.filter((t) => t.type === type).sort((a, b) => b.height - a.height)
      for (const tr of cands) {
        const r = await window.api.playerGetStreamUrl(tr.id, tr.height)
        if (!r) continue
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
        pinia._s.get('player').openPlayer({
          filePath: '', streamUrl: r.streamUrl, subtitleContent: r.subtitleContent || '',
          animeName: anime.title, episodeLabel: startEp, availableStreams: r.availableStreams,
          translationId: tr.id, translations: target.translations, downloadedTrIds: [],
          allEpisodes, episodeIndex: idx, animeId, malId: 0
        })
        return { ok: true, tr: { id: tr.id, label: tr.label, type: tr.type, height: tr.height }, n: allEpisodes.length }
      }
      return { ok: false, cands: cands.length }
    }, plan)
    out({ kind: 'open', series: plan.name, ...opened })
    if (!opened.ok) return

    await page.waitForSelector('video.player-video')
    await page.evaluate(() => {
      const v = document.querySelector('video.player-video')
      v.muted = true
      v.volume = 0
      window.__ev = []
      for (const t of ['emptied', 'loadstart', 'loadedmetadata', 'seeking', 'seeked', 'playing', 'pause', 'ended', 'error']) {
        v.addEventListener(t, () => window.__ev.push({ at: Date.now(), t, ct: v.currentTime, src: v.currentSrc }))
      }
    })
    const state = () =>
      page.evaluate(() => {
        const v = document.querySelector('video.player-video')
        return {
          ct: v.currentTime, dur: v.duration, paused: v.paused, rs: v.readyState,
          src: v.getAttribute('src') || '', label: document.querySelector('.pt-sub')?.textContent?.trim() || '',
          navToast: document.querySelector('.nav-toast')?.textContent?.trim() || '',
          toasts: [...document.querySelectorAll('[class*="toast"]')].map((e) => e.textContent.trim()).filter(Boolean)
        }
      })
    const waitPlaying = async (ms = 60000) => {
      await page.waitForFunction(() => {
        const v = document.querySelector('video.player-video')
        return v && v.readyState >= 3 && !v.paused && v.currentTime > 0.3
      }, null, { timeout: ms })
    }
    const seekTo = async (t) => {
      await page.evaluate((t) => { document.querySelector('video.player-video').currentTime = t }, t)
      await page.waitForFunction((t) => {
        const v = document.querySelector('video.player-video')
        return !v.seeking && v.readyState >= 3 && Math.abs(v.currentTime - t) < 30
      }, t, { timeout: 60000 })
    }
    const epIntOf = (label) => (label.match(/Episode (\S+) of/) || [])[1] || ''

    await waitPlaying().catch(() => {})
    const scs = process.env.LIMIT ? plan.scenarios.slice(0, Number(process.env.LIMIT)) : plan.scenarios
    for (const sc of scs) {
      let st = await state()
      const fromEp = epIntOf(st.label)
      // Position the element per scenario.
      try {
        await waitPlaying(60000)
        if (sc === 'open') await sleep(2000 + Math.random() * 3000)
        else if (sc === 'chain') await sleep(1500 + Math.random() * 1500)
        else if (sc === 'early') { await seekTo(30); await sleep(1000) }
        else if (sc === 'mid') { await seekTo(600 + Math.random() * 120); await sleep(2500) }
        else if (sc === 'late' || sc === 'keyboard') { await seekTo(1170 + Math.random() * 60); await sleep(2500) }
        else if (sc === 'paused') {
          await seekTo(300 + Math.random() * 300); await sleep(1500)
          await page.evaluate(() => document.querySelector('video.player-video').pause())
          await sleep(1500)
        } else if (sc === 'seek') {
          await page.evaluate((t) => { document.querySelector('video.player-video').currentTime = t }, 400 + Math.random() * 400)
          await sleep(200 + Math.random() * 700)
        } else if (sc === 'auto') {
          st = await state()
          await seekTo(st.dur - 12)
        }
      } catch (e) {
        out({ kind: 'setup-fail', series: plan.name, sc, err: String(e).slice(0, 200) })
      }
      st = await state()
      const toEp = String(Number(fromEp) + 1)
      const recBefore = await page.evaluate(([a, e]) => window.api.watchProgressGet(a, e), [plan.animeId, toEp])
      const evStart = await page.evaluate(() => window.__ev.length)
      const t0 = st.ct
      const pressAt = Date.now()
      if (sc === 'auto') {
        // natural end → onVideoEnded → 5 s countdown → goToEpisode('next')
      } else if (sc === 'keyboard') {
        await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur())
        await page.keyboard.press('Shift+ArrowRight')
      } else {
        await page.evaluate(() => document.querySelector('button[title^="Next episode"]').click())
      }
      // Wait for the source to change (or give up).
      let changed = false
      const deadline = Date.now() + (sc === 'auto' ? 45000 : 30000)
      let toastSeen = ''
      while (Date.now() < deadline) {
        const s = await state()
        if (s.navToast) toastSeen = s.navToast
        if (s.src && s.src !== st.src) { changed = true; break }
        await sleep(100)
      }
      let lm = null, ct2 = null, ct10 = null, after = null
      if (changed) {
        const lmEv = await page.waitForFunction((i) => window.__ev.slice(i).find((e) => e.t === 'loadedmetadata'), evStart, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null)
        lm = lmEv ? lmEv.ct : null
        await sleep(2000)
        ct2 = (await state()).ct
        const resumeToast = (await state()).toasts.filter((t) => /Resumed at/.test(t))
        await sleep(8000)
        after = await state()
        ct10 = after.ct
        if (resumeToast.length) toastSeen = toastSeen || resumeToast[0]
      } else {
        after = await state()
      }
      const recAfter = await page.evaluate(([a, e]) => window.api.watchProgressGet(a, e), [plan.animeId, toEp])
      const ev = (await page.evaluate((i) => window.__ev.slice(i), evStart)).map((e) => ({ ...e, at: e.at - pressAt, src: (e.src || '').slice(-60) }))
      const bad = changed && ((ct2 !== null && ct2 > 5 + 2.5) || (lm !== null && lm > 5))
      const rec = {
        kind: 'transition', series: plan.name, sc, fromEp, toEp: epIntOf(after.label), expectedToEp: toEp,
        tr: (after.label.split(' · ').slice(-1)[0] || ''), t0: +t0.toFixed(2), pausedAtPress: st.paused,
        srcChanged: changed, newSrc: (after.src || '').replace(/access_token=[^&]+/g, 'access_token=<redacted>').slice(0, 120),
        ctAtLoadedmetadata: lm, ct2, ct10, toast: toastSeen, recBefore, recAfter,
        mainErrors: mainErrors.filter((m) => m.at >= pressAt - 1000).map((m) => m.line), bad
      }
      if (bad || !changed) rec.trace = ev
      out(rec)
      await sleep(3000) // polite pacing between embed requests
      if (!changed) {
        out({ kind: 'backoff', series: plan.name, ms: 60000 })
        await sleep(60000)
      }
    }
  } catch (e) {
    out({ kind: 'series-error', series: plan.name, err: String(e).slice(0, 300) })
  } finally {
    if (app) await app.close().catch(() => {})
    fs.rmSync(xdg, { recursive: true, force: true })
    out({ kind: 'profile-deleted', series: plan.name, exists: fs.existsSync(xdg) })
  }
}

;(async () => {
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null
  for (const p of PLAN) {
    if (only && !only.includes(p.name)) continue
    await runSeries(p, token)
    await sleep(10000)
  }
})()
