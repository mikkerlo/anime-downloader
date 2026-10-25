import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

// Synthetic MKV for e2e/mkv-seek-sub-sync.spec.ts (#557). Both the picture and
// the embedded ASS track carry a machine-readable tick code, so the spec can
// read what each one shows after a seek straight off the pixels.
//
// Layout, identical in both bands: BLOCKS equal blocks across the width. The
// leftmost is a sentinel that is always white; the other nine are
// floor(t / TICK_S) in binary, MSB first, white for 1 and black for 0. The
// video band is the top BAND_H rows of the picture; the subtitle band is the
// bottom BAND_H rows, drawn by one `{\p1}` event per tick that includes the
// sentinel, so a white sentinel means *this* tick's event rendered.

export const FFMPEG = '/usr/bin/ffmpeg'
export const FFPROBE = '/usr/bin/ffprobe'

export const TICK_S = 0.5
export const CODE_BITS = 9
export const BLOCKS = CODE_BITS + 1
export const WIDTH = 640
export const HEIGHT = 360
export const BAND_H = 40
export const FPS = 24
export const DURATION_S = 150

// The GOP is pinned (-g 96 -keyint_min 96 -sc_threshold 0 at 24 fps), so
// keyframes land every 4 s. The #556 bug labels the buffer from the keyframe
// K at or before the target T, so the picture lags the subtitles by
// tick(T) - tick(K) = 165 - 160 here.
const GOP_FRAMES = 96

export const tickAt = (t: number): number => Math.floor(t / TICK_S)

export function hasRealFfmpeg(): boolean {
  if (!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE)) return false
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf-8' })
  return (enc.stdout ?? '').includes('libx264') && spawnSync(FFPROBE, ['-version']).status === 0
}

export interface TickRead {
  sentinel: boolean
  code: number
  /** Smallest distance of any block's mean luminance from the 128 threshold. */
  margin: number
}

/**
 * Decodes one BAND_H-high band given as RGBA rows (`width` x `height`). Each
 * block is sampled over its central 50% x 50% and thresholded at 128. Shared by
 * the ffmpeg frame-grab self-check and the in-app read of both bands.
 */
export function decodeTickBand(rgba: ArrayLike<number>, width: number, height: number): TickRead {
  let bits = 0
  let margin = 255
  const y0 = Math.floor(height * 0.25)
  const y1 = Math.max(y0 + 1, Math.floor(height * 0.75))
  for (let i = 0; i < BLOCKS; i++) {
    const x0 = Math.floor((width * (i + 0.25)) / BLOCKS)
    const x1 = Math.max(x0 + 1, Math.floor((width * (i + 0.75)) / BLOCKS))
    let sum = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 4
        sum += 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]
      }
    }
    const mean = sum / ((y1 - y0) * (x1 - x0))
    margin = Math.min(margin, Math.abs(mean - 128))
    bits = (bits << 1) | (mean >= 128 ? 1 : 0)
  }
  return {
    sentinel: bits >> CODE_BITS === 1,
    code: bits & ((1 << CODE_BITS) - 1),
    margin: Math.round(margin)
  }
}

function assTimestamp(t: number): string {
  const cs = Math.round(t * 100)
  const h = Math.floor(cs / 360000)
  const m = Math.floor(cs / 6000) % 60
  const s = Math.floor(cs / 100) % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`
}

export function tickAss(): string {
  const blockW = WIDTH / BLOCKS
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Code,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  for (let tick = 0; tick < Math.ceil(DURATION_S / TICK_S); tick++) {
    const bits = (1 << CODE_BITS) | tick
    const shapes: string[] = []
    for (let i = 0; i < BLOCKS; i++) {
      if (!((bits >> (BLOCKS - 1 - i)) & 1)) continue
      const x0 = Math.round(i * blockW)
      const x1 = Math.round((i + 1) * blockW)
      shapes.push(`m ${x0} 0 l ${x1} 0 ${x1} ${BAND_H} ${x0} ${BAND_H}`)
    }
    const start = assTimestamp(tick * TICK_S)
    const end = assTimestamp((tick + 1) * TICK_S)
    const tags = `{\\an7\\pos(0,${HEIGHT - BAND_H})\\bord0\\shad0\\p1}`
    lines.push(`Dialogue: 0,${start},${end},Code,,0,0,0,,${tags}${shapes.join(' ')}{\\p0}`)
  }
  return lines.join('\n') + '\n'
}

function ffmpegArgs(assPath: string, outPath: string): string[] {
  // geq runs on a tiny BLOCKS*2 x 2 image and is upscaled with neighbour
  // sampling: about 5 s on 4 cores, against ~13 s for geq over the full band.
  const block = `floor(X*${BLOCKS}/W)`
  const bit = `if(lt(${block},1),1,mod(floor(floor(T/${TICK_S})/pow(2,${CODE_BITS}-${block})),2))`
  const graph =
    `color=c=black:s=${BLOCKS * 2}x2:r=${FPS}:d=${DURATION_S},format=yuv444p,` +
    `geq=lum='16+239*${bit}':cb=128:cr=128,` +
    `scale=${WIDTH}:${BAND_H}:flags=neighbor,format=yuv420p[top];` +
    `[0:v]drawbox=x=0:y=${HEIGHT - BAND_H}:w=${WIDTH}:h=${BAND_H}:color=black:t=fill[bg];` +
    `[bg][top]overlay=0:0:shortest=1[v]`
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION_S}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${DURATION_S}`,
    '-i',
    assPath,
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    '-map',
    '1:a',
    '-map',
    '2:s',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-bf',
    '2',
    '-g',
    String(GOP_FRAMES),
    '-keyint_min',
    String(GOP_FRAMES),
    '-sc_threshold',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-c:s',
    'ass',
    '-f',
    'matroska',
    outPath
  ]
}

export interface TickFixture {
  mkv: string
  /** 0 when an earlier run's build was reused from os.tmpdir(). */
  buildMs: number
}

/** Builds the fixture once into os.tmpdir(), keyed by its inputs. */
export function buildTickFixture(): TickFixture {
  const ass = tickAss()
  const key = createHash('sha1')
    .update(ass)
    .update(ffmpegArgs('ass', 'out').join('\0'))
    .digest('hex')
    .slice(0, 12)
  const dir = join(os.tmpdir(), `anime-dl-e2e-tick-${key}`)
  const mkv = join(dir, 'tick.mkv')
  if (fs.existsSync(mkv)) return { mkv, buildMs: 0 }

  fs.mkdirSync(dir, { recursive: true })
  const assPath = join(dir, 'tick.ass')
  fs.writeFileSync(assPath, ass)
  const partial = `${mkv}.${process.pid}.partial`
  const t0 = Date.now()
  const run = spawnSync(FFMPEG, ffmpegArgs(assPath, partial), { encoding: 'utf-8' })
  if (run.status !== 0) {
    fs.rmSync(partial, { force: true })
    throw new Error(`tick fixture build failed (exit ${run.status}): ${run.stderr}`)
  }
  fs.renameSync(partial, mkv)
  return { mkv, buildMs: Date.now() - t0 }
}

export interface Keyframe {
  pts: number
  dts: number
}

export function videoKeyframes(mkv: string): Keyframe[] {
  const probe = spawnSync(
    FFPROBE,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,dts_time,flags',
      '-of',
      'json',
      mkv
    ],
    { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }
  )
  if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`)
  const packets = (
    JSON.parse(probe.stdout) as {
      packets: { pts_time: string; dts_time: string; flags: string }[]
    }
  ).packets
  return packets
    .filter((p) => p.flags.startsWith('K'))
    .map((p) => ({ pts: Number(p.pts_time), dts: Number(p.dts_time) }))
    .sort((a, b) => a.pts - b.pts)
}

/**
 * The keyframe the #556 bug labels the buffer from, checked so a fixture or
 * target change can't hide the bug. T - K >= 1 s keeps the lag at two ticks or
 * more; the bug only empties the probe once K's DTS is past 60 s.
 */
export function seekKeyframe(mkv: string, target: number): Keyframe {
  const before = videoKeyframes(mkv).filter((k) => k.pts <= target)
  if (before.length === 0) throw new Error(`no keyframe at or before ${target}`)
  const k = before[before.length - 1]
  if (target - k.pts < 1) {
    throw new Error(
      `seek target ${target} is ${target - k.pts}s after keyframe ${k.pts}; need >= 1s`
    )
  }
  if (k.dts < 60) throw new Error(`keyframe ${k.pts} has DTS ${k.dts} < 60s; #556 would not fire`)
  return k
}

/** ffmpeg's own frame at `t` (the first at or after it), top band decoded. */
export function grabVideoBand(mkv: string, t: number): TickRead {
  const grab = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(t),
      '-i',
      mkv,
      '-frames:v',
      '1',
      '-vf',
      `crop=${WIDTH}:${BAND_H}:0:0`,
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { maxBuffer: WIDTH * BAND_H * 4 * 2 }
  )
  if (grab.status !== 0 || grab.stdout.length !== WIDTH * BAND_H * 4) {
    throw new Error(`frame grab at ${t} failed: ${String(grab.stderr)}`)
  }
  return decodeTickBand(grab.stdout, WIDTH, BAND_H)
}
