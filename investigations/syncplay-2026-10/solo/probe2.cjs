// Real-Chromium probe: open the built PlayerView alone (no room), play ep1,
// move to T, press "next", record where ep2 lands and every watch-progress save.
const { _electron: electron } = require('/home/greatkorn/anime-downloader/node_modules/@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const WT = '/home/greatkorn/anime-downloader/.claude/worktrees/agent-a8cf4f7d0e32d0e13'
const S = __dirname
const MODE = process.env.MODE || 'stream' // stream | mp4 | mkv
const TRIALS = Number(process.env.TRIALS || 3)
const T_SEEK = Number(process.env.T_SEEK || 60)
const PRE_NEXT_MS = process.env.PRE_NEXT_MS // optional fixed delay before pressing next

function media(i, ext) {
  return path.join(S, 'media', `ep${i}.${ext}`)
}
function url(p) {
  return 'anime-video://' + encodeURIComponent(p)
}

async function trial(n) {
  const xdg = fs.mkdtempSync(path.join(S, 'xdg-'))
  fs.mkdirSync(path.join(xdg, 'Electron', 'ffmpeg'), { recursive: true })
  for (const b of ['ffmpeg', 'ffprobe']) {
    fs.copyFileSync(`/home/greatkorn/.config/Electron/ffmpeg/${b}`, path.join(xdg, 'Electron', 'ffmpeg', b))
    fs.chmodSync(path.join(xdg, 'Electron', 'ffmpeg', b), 0o755)
  }
  const app = await electron.launch({
    args: ['--mute-audio', '--no-sandbox', path.join(WT, 'out/main/index.js')],
    env: { ...process.env, XDG_CONFIG_HOME: xdg }
  })
  const page = await app.firstWindow()
  page.on('console', (m) => {
    const t = m.text()
    if (/\[player\]|\[probe\]/.test(t)) logs.push(`${Date.now() - t0} console: ${t}`)
  })
  const logs = []
  const t0 = Date.now()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  const ext = MODE === 'mkv' ? 'mkv' : 'mp4'
  await app.evaluate(
    ({ ipcMain }, { mode, files, fail }) => {
      globalThis.__saves = []
      const t0 = Date.now()
      globalThis.__t0 = t0
      // Wrap the real save handler so the store still gets written.
      // (electron has no public getter for handlers; re-implement via a store
      // read-modify-write is unnecessary — we only need the log + persisted
      // record, so keep a shadow map that mirrors main's merge rule.)
      const shadow = {}
      globalThis.__shadow = shadow
      ipcMain.removeHandler('watch-progress:save')
      ipcMain.handle('watch-progress:save', (_e, animeId, epInt, position, duration, watched, trId) => {
        const key = `${animeId}:${epInt}`
        const prev = shadow[key]
        shadow[key] = {
          position,
          duration,
          watched: !!(watched || (prev && prev.watched)),
          translationId: trId !== undefined ? trId : prev && prev.translationId
        }
        globalThis.__saves.push({ at: Date.now(), key, position, duration, watched })
      })
      ipcMain.removeHandler('watch-progress:get')
      ipcMain.handle('watch-progress:get', (_e, animeId, epInt) => shadow[`${animeId}:${epInt}`] || null)
      ipcMain.removeHandler('player:get-stream-url')
      globalThis.__failOnce = new Set(fail)
      ipcMain.handle('player:get-stream-url', async (_e, trId) => {
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 400))
        // Simulates a transient smotret getEmbed failure (429/5xx/network), which
        // the real handler maps to `null`.
        if (globalThis.__failOnce.has(trId)) {
          globalThis.__failOnce.delete(trId)
          return null
        }
        const f = files[trId]
        return { streamUrl: 'anime-video://' + encodeURIComponent(f), subtitleContent: null, availableStreams: [] }
      })
      ipcMain.removeHandler('player:find-local-file')
      ipcMain.handle('player:find-local-file', async (_e, _name, _epInt, trId) => {
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 60))
        return { filePath: files[trId], subtitleContent: null }
      })
    },
    {
      mode: MODE,
      files: { 101: media(1, ext), 102: media(2, ext), 103: media(3, ext), 202: media(2, ext) },
      fail: (process.env.STREAM_FAIL || '').split(',').filter(Boolean).map(Number)
    }
  )

  const local = MODE !== 'stream'
  const eps = [1, 2, 3].map((i) => ({
    id: 900 + i,
    episodeInt: process.env.DUPKEY && i === 2 ? '1' : String(i),
    episodeFull: String(i),
    translations:
      i === 2
        ? [
            { id: 102, label: 'Probe', type: 'subRu', height: 240 },
            { id: 202, label: 'Other', type: 'subRu', height: 240 }
          ]
        : [{ id: 100 + i, label: 'Probe', type: 'subRu', height: 240 }],
    downloadedTrIds: local ? [100 + i] : []
  }))
  await page.evaluate(
    ({ eps, local, first, quality }) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      pinia._s.get('player').openPlayer({
        filePath: local ? first : '',
        streamUrl: local ? '' : 'anime-video://' + encodeURIComponent(first),
        subtitleContent: '',
        animeName: 'Probe Anime',
        episodeLabel: '1',
        availableStreams: quality
          ? [
              { height: 240, url: 'anime-video://' + encodeURIComponent(first) },
              { height: 480, url: 'anime-video://' + encodeURIComponent(first.replace('ep1.mp4', 'ep1-480.mp4')) }
            ]
          : [],
        translationId: 101,
        translations: eps[0].translations,
        downloadedTrIds: eps[0].downloadedTrIds,
        allEpisodes: eps,
        episodeIndex: 0,
        animeId: 999001,
        malId: 0
      })
    },
    { eps, local, first: media(1, ext), quality: !!process.env.QUALITY }
  )
  await page.waitForSelector('video.player-video')
  const SC = process.env.SCENARIO || 'basic'
  if (SC === 'early') {
    await page.waitForTimeout(Number(process.env.EARLY_MS || 100))
    await page.evaluate(() => document.querySelector('button[title^="Next episode"]').click())
  }
  await page.evaluate(() => {
    const v = document.querySelector('video.player-video')
    v.muted = true
    window.__ev = []
    const t0 = performance.now()
    for (const type of ['loadstart', 'emptied', 'loadedmetadata', 'seeking', 'seeked', 'pause', 'play', 'durationchange']) {
      v.addEventListener(type, () =>
        window.__ev.push(`${(performance.now() - t0).toFixed(0)} ${type} ct=${v.currentTime.toFixed(2)} rs=${v.readyState} src=${(v.getAttribute('src') || '').slice(-12)}`)
      )
    }
  })
  let before = -1
  if (SC !== 'early') {
    // wait until playing
    await page.waitForFunction(() => {
      const v = document.querySelector('video.player-video')
      return v && v.readyState >= 3 && v.currentTime > 0.5
    }, null, { timeout: 30000 })
    // user seeks to T (like a scrub) and plays a while so saves happen
    await page.evaluate((t) => {
      document.querySelector('video.player-video').currentTime = t
    }, SC === 'end' ? 112 : T_SEEK)
    if (SC === 'seeknext') {
      await page.waitForTimeout(Math.floor(Math.random() * 40))
    } else if (SC === 'end') {
      await page.waitForTimeout(20000)
    } else {
      const wait = PRE_NEXT_MS ? Number(PRE_NEXT_MS) : 3000 + Math.floor(Math.random() * 4000)
      await page.waitForTimeout(wait)
    }
    if (SC === 'paused') {
      await page.evaluate(() => document.querySelector('video.player-video').pause())
      await page.waitForTimeout(500)
    }
    before = await page.evaluate(() => document.querySelector('video.player-video').currentTime)
    if (SC !== 'end') {
      await page.evaluate(() => {
        window.__ev.push('--- NEXT pressed')
        document.querySelector('button[title^="Next episode"]').click()
      })
    }
    if (SC === 'double') {
      await page.waitForTimeout(300 + Math.floor(Math.random() * 900))
      await page.evaluate(() => {
        window.__ev.push('--- NEXT pressed (2)')
        const b = document.querySelector('button[title^="Next episode"]')
        window.__ev.push('disabled=' + b.disabled)
        b.click()
      })
    }
  }
  await page.waitForTimeout(MODE === 'mkv' ? 8000 : 5000)
  if (process.env.QUALITY) {
    // ep2 is now playing (stream). User scrubs to 40 s and picks 480p.
    await page.evaluate(() => { document.querySelector('video.player-video').currentTime = 40 })
    await page.waitForTimeout(1000)
    await page.evaluate(() => {
      window.__ev.push('--- pick quality 480')
      document.querySelector('button[title="Video quality"]').click()
    })
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      const o = [...document.querySelectorAll('.preset-menu .preset-option')].find((x) => x.textContent.includes('480'))
      o.click()
    })
    await page.waitForTimeout(12000)
  }
  if (process.env.THEN_TR) {
    // After the failed step, the user picks the other translation of the
    // episode the UI now shows, hoping to get it to play.
    const mid = await page.evaluate(() => ({
      ct: document.querySelector('video.player-video').currentTime,
      src: document.querySelector('video.player-video').getAttribute('src'),
      toast: document.querySelector('.nav-toast')?.textContent || ''
    }))
    console.log('  after failed next: ct=', mid.ct.toFixed(2), 'src=', (mid.src || '').slice(-10), 'toast=', mid.toast.slice(0, 30))
    await page.evaluate(() => {
      window.__ev.push('--- pick translation "Other"')
      document.querySelector('.translation-btn').click()
    })
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      const opts = [...document.querySelectorAll('.translation-menu .preset-option')]
      const o = opts.find((x) => x.textContent.includes('Other'))
      o.click()
    })
    await page.waitForTimeout(25000)
  }
  const after = await page.evaluate(() => ({
    ct: document.querySelector('video.player-video').currentTime,
    src: document.querySelector('video.player-video').getAttribute('src'),
    ev: window.__ev,
    label: document.querySelector('.pt-sub')?.textContent || ''
  }))
  const saves = await app.evaluate(() => ({ saves: globalThis.__saves, shadow: globalThis.__shadow, t0: globalThis.__t0 }))
  await app.close()
  fs.rmSync(xdg, { recursive: true, force: true })
  const label = after.label
  const bad = after.ct > 20
  console.log('  label:', label.trim().slice(0, 40), 'src:', (after.src || '').slice(-10))
  console.log(`trial ${n} mode=${MODE} pressedAt=${before.toFixed(2)} ep2At(+${MODE === 'mkv' ? 8 : 5}s)=${after.ct.toFixed(2)} ${bad ? 'BUG' : 'ok'}`)
  console.log('  ep2 record:', JSON.stringify(saves.shadow['999001:2'] || null))
  if (process.env.VERBOSE || bad) {
    for (const s of saves.saves) console.log('  save', s.at - saves.t0, s.key, s.position.toFixed(2), s.duration, s.watched)
    for (const e of after.ev) console.log('  ev', e)
    for (const l of logs) console.log('  ', l)
  }
  return bad
}

;(async () => {
  let bugs = 0
  for (let i = 0; i < TRIALS; i++) if (await trial(i)) bugs++
  console.log(`SUMMARY mode=${MODE} bugs=${bugs}/${TRIALS}`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
