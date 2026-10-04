#!/usr/bin/env node
// Generates the Tier 2 Syncplay e2e fixtures (#489): still-image episodes that
// are long enough for a stale timestamp to be told apart from 0, with frequent
// keyframes so seeks land predictably, and nothing anyone has to download.
//
//   node scripts/gen-syncplay-fixtures.mjs [outDir]
//
// `outDir` defaults to `e2e-syncplay/.fixtures` under the repo root (derived
// from this file's location, never an absolute home path). Re-running is
// cheap: a file whose recorded parameters match is left alone, so local runs
// and CI produce the same set from the same script. Needs `ffmpeg` on PATH
// (CI: `apt-get install ffmpeg`), or `FFMPEG=/path/to/ffmpeg`.
//
// What is generated, and why each property is there (see #489's fixture table):
//  - ep1..ep4 at 720p and 360p (two quality variants for P7), H.264 + AAC MP4,
//    faststart, 1 fps still image + near-silent audio, a keyframe every 2 s.
//  - Durations 23:40 / 24:00 / 24:20 / 24:40, so the duration-based
//    out-of-file check and the auto-advance edges see different files.
//  - ep1.mkv, the same still image in Matroska, for the MSE / ffmpeg path.
//  - manifest.json, which the fixture server and the specs read.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, 'e2e-syncplay', '.fixtures'))
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'

export const EPISODES = [
  { episodeInt: '1', durationS: 23 * 60 + 40, color: '0x3050a0' },
  { episodeInt: '2', durationS: 24 * 60, color: '0x30a050' },
  { episodeInt: '3', durationS: 24 * 60 + 20, color: '0xa05030' },
  { episodeInt: '4', durationS: 24 * 60 + 40, color: '0xa0a030' }
]
export const HEIGHTS = [720, 360]
const KEYFRAME_EVERY_S = 2
const VERSION = 1

function run(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'inherit', 'inherit']
  })
  if (r.error) throw new Error(`could not run ${FFMPEG}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${FFMPEG} exited ${r.status} for ${args.at(-1)}`)
}

function encode(ep, height, file, container) {
  const width = Math.round((height * 16) / 9 / 2) * 2
  const args = [
    '-f',
    'lavfi',
    '-i',
    `color=c=${ep.color}:s=${width}x${height}:r=1:d=${ep.durationS}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=22050:duration=${ep.durationS}`,
    '-filter:a',
    'volume=0.001',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'stillimage',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(KEYFRAME_EVERY_S),
    '-keyint_min',
    String(KEYFRAME_EVERY_S),
    '-c:a',
    'aac',
    '-b:a',
    '24k',
    '-t',
    String(ep.durationS)
  ]
  if (container === 'mp4') args.push('-movflags', '+faststart')
  args.push(file)
  run(args)
}

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const manifestPath = path.join(OUT, 'manifest.json')
  const want = {
    version: VERSION,
    keyframeEveryS: KEYFRAME_EVERY_S,
    episodes: EPISODES,
    heights: HEIGHTS
  }
  let have = null
  try {
    have = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    have = null
  }
  const files = []
  for (const ep of EPISODES) {
    for (const height of HEIGHTS) {
      files.push({ ep, height, name: `ep${ep.episodeInt}-${height}.mp4`, container: 'mp4' })
    }
  }
  files.push({ ep: EPISODES[0], height: 720, name: 'ep1.mkv', container: 'mkv' })
  const fresh =
    have &&
    JSON.stringify(have.params) === JSON.stringify(want) &&
    files.every((f) => fs.existsSync(path.join(OUT, f.name)))
  if (!fresh) {
    for (const f of files) {
      process.stdout.write(`generating ${f.name} (${f.ep.durationS} s, ${f.height}p)\n`)
      encode(f.ep, f.height, path.join(OUT, f.name), f.container)
    }
  }
  const manifest = {
    params: want,
    files: files.map((f) => ({
      name: f.name,
      episodeInt: f.ep.episodeInt,
      height: f.height,
      durationS: f.ep.durationS,
      container: f.container,
      bytes: fs.statSync(path.join(OUT, f.name)).size
    }))
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  process.stdout.write(`${fresh ? 'up to date' : 'generated'}: ${files.length} files in ${OUT}\n`)
}

main()
