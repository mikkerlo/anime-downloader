import { test, expect, type Page } from '@playwright/test'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { assertNoDownloads, assertUserData, launchApp, makeProfile } from './helpers/profile'
import { FFMPEG, FFPROBE, hasRealFfmpeg, videoKeyframes } from './helpers/tick-fixture'

/**
 * Playback across a long keyframe gap on the MSE copy path (#653). The fixture
 * is 200 s with keyframes every 10 s except a 120 s GOP from 30 to 150. The
 * old back-eviction ended its `remove()` at `t − 30`, which lands inside that
 * GOP; Chromium extends a removal to the next random-access point, which isn't
 * buffered yet, so the removal took the GOP the playhead was on and the buffer
 * only came back from 150. The playhead then sat at 100 for good. With the
 * eviction ending on recorded keyframes, both cases play through.
 *
 * Tagged `@mkv-sync` so CI runs it in the step that has the pinned static
 * ffmpeg on PATH.
 */

const DURATION_S = 200
const KEYFRAMES = [0, 10, 20, 30, 150, 160, 170, 180, 190]
const NO_NETWORK = {
  ANIME_DL_SMOTRET_API_BASE: 'http://127.0.0.1:9/api',
  ANIME_DL_SHIKIMORI_ORIGIN: 'http://127.0.0.1:9'
}

function fixtureArgs(out: string): string[] {
  return [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=24:duration=${DURATION_S}`],
    ...['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION_S}`],
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
    ...['-g', '100000', '-keyint_min', '100000', '-sc_threshold', '0'],
    ...['-force_key_frames', KEYFRAMES.join(',')],
    ...['-c:a', 'aac', '-b:a', '64k', '-f', 'matroska', out]
  ]
}

/** Built once into os.tmpdir(), keyed by its arguments. */
function buildFixture(): string {
  const key = createHash('sha1').update(fixtureArgs('out').join('\0')).digest('hex').slice(0, 12)
  const dir = join(os.tmpdir(), `anime-dl-e2e-long-gop-${key}`)
  const mkv = join(dir, 'long-gop.mkv')
  if (fs.existsSync(mkv)) return mkv
  fs.mkdirSync(dir, { recursive: true })
  const partial = `${mkv}.${process.pid}.partial`
  const run = spawnSync(FFMPEG, fixtureArgs(partial), { encoding: 'utf-8' })
  if (run.status !== 0) {
    fs.rmSync(partial, { force: true })
    throw new Error(`long-GOP fixture build failed (exit ${run.status}): ${run.stderr}`)
  }
  fs.renameSync(partial, mkv)
  return mkv
}

interface PlayerState {
  currentTime: number
  seeking: boolean
  paused: boolean
  readyState: number
  buffered: number[][]
}

function playerState(page: Page): Promise<PlayerState> {
  return page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement
    const buffered: number[][] = []
    for (let i = 0; i < v.buffered.length; i++) {
      buffered.push([v.buffered.start(i), v.buffered.end(i)])
    }
    return {
      currentTime: v.currentTime,
      seeking: v.seeking,
      paused: v.paused,
      readyState: v.readyState,
      buffered
    }
  })
}

// Records each SourceBuffer.remove() with `buffered` before it, so a red run
// shows which removal took the playhead's GOP. Installed before the open.
function instrumentRemove(page: Page): Promise<void> {
  return page.evaluate(() => {
    const removes: { start: number; end: number; t: number; before: number[][] }[] = []
    ;(window as unknown as { __removes: typeof removes }).__removes = removes
    const remove = SourceBuffer.prototype.remove
    SourceBuffer.prototype.remove = function (start: number, end: number) {
      const before: number[][] = []
      for (let i = 0; i < this.buffered.length; i++) {
        before.push([this.buffered.start(i), this.buffered.end(i)])
      }
      const v = document.querySelector('video')
      removes.push({ start, end, t: v?.currentTime ?? -1, before })
      return remove.call(this, start, end)
    }
  })
}

function removes(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { __removes: unknown }).__removes)
}

async function withPlayer(run: (page: Page, consoleLines: string[]) => Promise<void>) {
  test.skip(process.platform !== 'linux', `the fixture is built with ${FFMPEG} on PATH`)
  const ffmpegReady = hasRealFfmpeg()
  test.skip(!ffmpegReady && !process.env.CI, `${FFMPEG} with libx264 not found on PATH`)
  expect(ffmpegReady, `CI must put ${FFMPEG} (with libx264) and ${FFPROBE} on PATH`).toBe(true)
  test.setTimeout(120_000)

  const mkv = buildFixture()
  expect(videoKeyframes(mkv).map((k) => Math.round(k.pts))).toEqual(KEYFRAMES)

  const profile = makeProfile({
    prefix: 'anime-dl-long-gop-',
    config: { prefetchNextEpisode: 'off' }
  })
  try {
    const launched = await launchApp(profile, { env: NO_NETWORK })
    const { app } = launched
    try {
      await assertUserData(app, profile)
      const page = await app.firstWindow()
      const consoleLines: string[] = []
      page.on('console', (m) => consoleLines.push(m.text()))
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => typeof (window as any).__openTestPlayer === 'function')
      await instrumentRemove(page)
      await page.evaluate((filePath) => {
        ;(window as any).__openTestPlayer({
          filePath,
          streamUrl: '',
          subtitleContent: '',
          animeName: 'Long GOP fixture',
          episodeLabel: '1',
          availableStreams: [],
          translationId: 0,
          translations: [],
          downloadedTrIds: [],
          allEpisodes: [],
          episodeIndex: 0,
          animeId: 0,
          malId: 0
        })
      }, mkv)
      await page.waitForFunction(
        () => {
          const v = document.querySelector('video')
          if (v) {
            v.muted = true
            v.volume = 0
          }
          return !!v && v.readyState >= 2
        },
        null,
        { timeout: 30_000 }
      )
      expect(
        await page.evaluate(() => document.querySelector('video')!.currentSrc),
        'MKV must play through MSE, not the legacy remux fallback'
      ).toMatch(/^blob:/)
      await run(page, consoleLines)
      assertNoDownloads(launched)
    } finally {
      await app.close()
    }
  } finally {
    profile.cleanup()
  }
}

/** Polls until `currentTime` reaches `target`, or `timeoutMs` passes; returns the last state. */
async function playUntil(page: Page, target: number, timeoutMs: number): Promise<PlayerState> {
  const deadline = Date.now() + timeoutMs
  let state = await playerState(page)
  while (Date.now() < deadline && state.currentTime < target) {
    await page.waitForTimeout(250)
    state = await playerState(page)
  }
  return state
}

// Either way the seek resolves, the old eviction took the target's GOP: a
// respawn lands on the keyframe at 30 and `remove(30, 70)` reaches no
// keyframe before 150; an old run that already covered 100 inside the respawn
// debounce gets `remove(0, t − 30)`, which extends to 150. The element plays
// out what it has already decoded (to ~108) and then sits.
for (const paused of [true, false]) {
  test(
    `a seek into a long keyframe gap keeps playing, from ${paused ? 'paused' : 'playing'} (#653)`,
    { tag: '@mkv-sync' },
    async () => {
      await withPlayer(async (page, consoleLines) => {
        if (paused) {
          // Settled first, as in mkv-seek-sub-sync.spec.ts, so the seek tends
          // to leave the buffer and respawn.
          await page.evaluate(() => document.querySelector('video')!.pause())
          await page.waitForTimeout(500)
        }
        await page.evaluate(() => {
          const v = document.querySelector('video')!
          v.currentTime = 100
          void v.play()
        })
        const state = await playUntil(page, 120, 25_000)
        const diag = JSON.stringify({
          state,
          removes: await removes(page),
          respawned: consoleLines.some((l) =>
            l.includes('[player] unbuffered seek → target 100.00')
          )
        })
        test.info().annotations.push({ type: 'after seek', description: diag })
        expect(state.currentTime, `playback stalled after the seek: ${diag}`).toBeGreaterThan(120)
      })
    }
  )
}

test('plays from 0 across a long keyframe gap at 4x (#653)', { tag: '@mkv-sync' }, async () => {
  await withPlayer(async (page) => {
    await page.evaluate(() => {
      const v = document.querySelector('video')!
      v.playbackRate = 4
      void v.play()
    })
    // The first eviction is due at t ≈ 60, inside the GOP from 30 to 150.
    const state = await playUntil(page, 160, 60_000)
    const diag = JSON.stringify({ state, removes: await removes(page) })
    test.info().annotations.push({ type: 'after play', description: diag })
    expect(state.currentTime, `playback stalled in the gap: ${diag}`).toBeGreaterThan(160)
  })
})
