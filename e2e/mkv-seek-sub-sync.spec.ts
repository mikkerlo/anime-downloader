import { test, expect, type Page } from '@playwright/test'
import { join } from 'path'
import { assertNoDownloads, assertUserData, launchApp, makeProfile } from './helpers/profile'
import {
  AUDIO_EARLIEST_FIXTURE,
  BAND_H,
  FFMPEG,
  FFPROBE,
  HEIGHT,
  TICK_FIXTURE,
  WIDTH,
  audioEnd,
  buildTickFixture,
  decodeTickBand,
  grabVideoBand,
  hasRealFfmpeg,
  seekKeyframe,
  tickAt,
  type TickFixtureOptions,
  type TickRead
} from './helpers/tick-fixture'

/**
 * Picture and subtitles agree after an uncached MKV seek (#557). The unit test
 * for #556 checks the `timestampOffset` main computes; this checks that
 * Chromium's MSE and the SubtitlesOctopus clock (`video.currentTime +
 * timeOffset`) honour it on screen. The fixture carries a tick code in the
 * picture's top band and in the embedded ASS track's bottom band
 * (`helpers/tick-fixture.ts`); the spec opens it in the real PlayerView on the
 * MSE path, seeks outside the buffer, and reads both codes off the pixels:
 * `drawImage(video)` and SubtitlesOctopus's `.libassjs-canvas`. Not a
 * screenshot: pausing pins the controls on, and their gradient covers both
 * bands. With #556's fix reverted the picture reads 160 and the subtitles 165.
 *
 * Tagged `@mkv-sync`: CI runs it in its own non-blocking step after apt ffmpeg
 * is installed, and the shared e2e step leaves it out with `--grep-invert`.
 */
interface SeekCase {
  fixture: TickFixtureOptions
  target: number
  /** A buffer starting at or past this proves the seek left the buffer. */
  bufferLeftFloor: number
  /** Also check `buffered` after endOfStream against the file's audio end. */
  checkAudioEnd: boolean
}

const TICK_CASE: SeekCase = {
  fixture: TICK_FIXTURE,
  target: 82.75, // frame 1986, 0.25 s from both tick boundaries
  bufferLeftFloor: 79.9, // the keyframe before the target is at 80.0
  checkAudioEnd: false
}

// #560: the audio lands ~0.38 s before every keyframe, so the zero is the audio
// landing; anchored on the video, the picture reads 164 and `buffered` ends
// ~0.3 s past the audio. The target is 0.1 s after a tick boundary.
const AUDIO_EARLIEST_CASE: SeekCase = {
  fixture: AUDIO_EARLIEST_FIXTURE,
  target: 82.6,
  bufferLeftFloor: 79.5,
  checkAudioEnd: true
}

const STABLE_READS = 3
// Before endOfStream `buffered` is the intersection of the tracks and ends with
// the picture at 100 s; only after it does the range reach the audio's end.
const AUDIO_EOS_FLOOR = 100.5

interface Bands {
  video: number[]
  sub: number[]
}

// Both bands as WIDTH x BAND_H RGBA, so one decoder reads them. The subtitle
// band is the bottom of the video's content rect inside the libass canvas,
// composited onto black.
function readBands(page: Page): Promise<Bands> {
  return page.evaluate(
    ({ w, bandH, h }) => {
      const v = document.querySelector('video') as HTMLVideoElement
      const sc = document.querySelector('.libassjs-canvas') as HTMLCanvasElement
      const grab = (
        src: CanvasImageSource,
        sx: number,
        sy: number,
        sw: number,
        sh: number
      ): number[] => {
        const c = document.createElement('canvas')
        c.width = w
        c.height = bandH
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, w, bandH)
        ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, bandH)
        return Array.from(ctx.getImageData(0, 0, w, bandH).data)
      }
      const scale = Math.min(sc.width / v.videoWidth, sc.height / v.videoHeight)
      const cw = v.videoWidth * scale
      const ch = v.videoHeight * scale
      const subBandH = (ch * bandH) / h
      return {
        video: grab(v, 0, 0, v.videoWidth, (v.videoHeight * bandH) / h),
        sub: grab(sc, (sc.width - cw) / 2, (sc.height + ch) / 2 - subBandH, cw, subBandH)
      }
    },
    { w: WIDTH, bandH: BAND_H, h: HEIGHT }
  )
}

interface VideoState {
  currentTime: number
  seeking: boolean
  readyState: number
  paused: boolean
  buffered: number[][]
}

function videoState(page: Page): Promise<VideoState> {
  return page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement
    const buffered: number[][] = []
    for (let i = 0; i < v.buffered.length; i++) {
      buffered.push([v.buffered.start(i), v.buffered.end(i)])
    }
    return {
      currentTime: v.currentTime,
      seeking: v.seeking,
      readyState: v.readyState,
      paused: v.paused,
      buffered
    }
  })
}

function runSeekCase(c: SeekCase): () => Promise<void> {
  const EXPECTED_TICK = tickAt(c.target)
  const UNBUFFERED_LOG = `[player] unbuffered seek → target ${c.target.toFixed(2)}`
  return async () => {
    test.skip(process.platform !== 'linux', `the tick fixture is built with apt's ${FFMPEG}`)
    const ffmpegReady = hasRealFfmpeg()
    // CI installs apt ffmpeg before this runs; a missing binary there must fail.
    test.skip(!ffmpegReady && !process.env.CI, `${FFMPEG} with libx264 not found`)
    expect(ffmpegReady, `CI must install ${FFMPEG} (with libx264) and ${FFPROBE}`).toBe(true)
    test.setTimeout(120_000)

    // A broken fixture fails here, before Electron launches.
    const fixture = buildTickFixture(c.fixture)
    test.info().annotations.push({ type: 'fixture build ms', description: String(fixture.buildMs) })
    seekKeyframe(fixture.mkv, c.target)
    expect(grabVideoBand(fixture.mkv, c.target)).toMatchObject({
      sentinel: true,
      code: EXPECTED_TICK
    })

    // The helper links ffmpeg and ffprobe into the profile's userData; without
    // both the app downloads its own and the player falls back to legacy remux
    // meanwhile.
    const profile = makeProfile({ prefix: 'anime-dl-mkvsync-' })
    const userData = profile.userData
    // The outer finally removes the profile even when the launch throws.
    try {
      const launched = await launchApp(profile)
      const { app } = launched
      try {
        await assertUserData(app, profile)
        const page = await app.firstWindow()
        const consoleLines: string[] = []
        page.on('console', (m) => consoleLines.push(m.text()))
        await page.waitForLoadState('domcontentloaded')

        await expect
          .poll(() =>
            page.evaluate(() =>
              (
                window as unknown as {
                  api: { ffmpegCheck: () => Promise<{ available: boolean; path: string }> }
                }
              ).api.ffmpegCheck()
            )
          )
          .toEqual(
            expect.objectContaining({ available: true, path: join(userData, 'ffmpeg', 'ffmpeg') })
          )

        await page.waitForFunction(() => typeof (window as any).__openTestPlayer === 'function')
        // subtitleContent '' makes the embedded track arrive over
        // player:stream-subtitles, the real extraction path.
        await page.evaluate((filePath) => {
          ;(window as any).__openTestPlayer({
            filePath,
            streamUrl: '',
            subtitleContent: '',
            animeName: 'Tick fixture',
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
        }, fixture.mkv)
        await page.waitForFunction(
          () => {
            const v = document.querySelector('video')
            if (v) {
              v.muted = true
              v.volume = 0
            }
            return !!v && v.readyState >= 2 && !!document.querySelector('.libassjs-canvas')
          },
          null,
          { timeout: 30_000 }
        )
        expect(
          await page.evaluate(() => document.querySelector('video')!.currentSrc),
          'MKV must play through MSE, not the legacy remux fallback'
        ).toMatch(/^blob:/)

        // A timeupdate from the pause can pump the append queue during the
        // 250 ms respawn debounce and land the seek inside the buffer, so let it
        // settle first. No control seek before this one: moving the playhead
        // lets the append throttle fill the buffer past the target.
        await page.evaluate(() => document.querySelector('video')!.pause())
        await page.waitForTimeout(500)
        const firstLine = consoleLines.length
        await page.evaluate((t) => {
          document.querySelector('video')!.currentTime = t
        }, c.target)

        const settled = await page
          .waitForFunction(
            () => {
              const v = document.querySelector('video')!
              return !v.seeking && v.readyState >= 2
            },
            null,
            { timeout: 15_000 }
          )
          .then(
            () => true,
            () => false
          )
        const afterSeek = await videoState(page)
        expect(settled, `seek never settled: ${JSON.stringify(afterSeek)}`).toBe(true)

        const { buffered } = afterSeek
        const respawnLogged = consoleLines.slice(firstLine).some((l) => l.includes(UNBUFFERED_LOG))
        const seek = { ...afterSeek, respawnLogged }
        expect(
          (buffered.length > 0 && buffered[0][0] >= c.bufferLeftFloor) || respawnLogged,
          `seek never left the buffer, so this run tests nothing: ${JSON.stringify(seek)}`
        ).toBe(true)

        // Both bands were stable ~0.85 s after the seek in review; poll rather
        // than sleep.
        const reads: { video: TickRead; sub: TickRead }[] = []
        const key = (r: { video: TickRead; sub: TickRead }): string =>
          [r.video.sentinel, r.video.code, r.sub.sentinel, r.sub.code].join()
        let stable = 0
        for (let i = 0; i < 40 && stable < STABLE_READS; i++) {
          await page.waitForTimeout(150)
          const bands = await readBands(page)
          const read = {
            video: decodeTickBand(bands.video, WIDTH, BAND_H),
            sub: decodeTickBand(bands.sub, WIDTH, BAND_H)
          }
          const prev = reads[reads.length - 1]
          stable = prev && key(prev) === key(read) ? stable + 1 : 1
          reads.push(read)
        }
        const final = reads[reads.length - 1]
        const summary = JSON.stringify({ final, reads: reads.length, seek })
        test.info().annotations.push({ type: 'readback', description: summary })
        expect(stable, `reads never repeated: ${summary}`).toBe(STABLE_READS)

        expect(final.video.sentinel, `video band sentinel not white: ${summary}`).toBe(true)
        expect(final.sub.sentinel, `subtitle band sentinel not white: ${summary}`).toBe(true)
        expect(final.sub.code, `subtitles show the wrong tick: ${summary}`).toBe(EXPECTED_TICK)
        expect(final.video.code, `picture and subtitles disagree: ${summary}`).toBe(final.sub.code)

        if (c.checkAudioEnd) {
          // Exact to the ms and needs no audio output: after endOfStream the
          // range ends at timestampOffset + the run's audio end, which is the
          // file's audio end only when the offset is the audio's zero.
          const expectedEnd = audioEnd(fixture.mkv)
          let end = 0
          for (let i = 0; i < 100 && end < AUDIO_EOS_FLOOR; i++) {
            await page.waitForTimeout(200)
            const { buffered: ranges } = await videoState(page)
            end = ranges.length > 0 ? ranges[ranges.length - 1][1] : 0
          }
          const eos = JSON.stringify({ end, expectedEnd, final: await videoState(page) })
          test.info().annotations.push({ type: 'buffered after EOS', description: eos })
          expect(end, `endOfStream never reached: ${eos}`).toBeGreaterThan(AUDIO_EOS_FLOOR)
          expect(Math.abs(end - expectedEnd), `buffered ends off the audio: ${eos}`).toBeLessThan(
            0.005
          )
        }
        assertNoDownloads(launched)
      } finally {
        await app.close()
      }
    } finally {
      profile.cleanup()
    }
  }
}

test(
  'MKV seek outside the buffer: picture and subtitles show the same tick',
  { tag: '@mkv-sync' },
  runSeekCase(TICK_CASE)
)

test(
  'MKV seek with the audio landing before the keyframe: picture, subtitles and audio agree (#560)',
  { tag: '@mkv-sync' },
  runSeekCase(AUDIO_EARLIEST_CASE)
)
