// Step 4 (#592): every `downloadedEpisodes` entry has its video in the hot or
// cold root (the player's name rule), larger than 0 bytes, with a duration
// ffprobe can read; and `.part` files no download owns are reported. Reports
// only: it never deletes, moves or rewrites anything.

import * as fs from 'fs'
import * as path from 'path'
import { episodeVideoCandidates } from '../../../lib/episode-video-path'
import { type PrepareStep, type PrepareStepResult, worstStatus } from '../index'

type EpisodeMeta = { author?: string; translationId?: number }

export interface LocalIntegrityStepDeps {
  downloadedEpisodes(): Record<string, EpisodeMeta>
  downloadedAnime(): Record<string, AnimeSearchResult>
  displayName(anime: AnimeSearchResult): string
  sanitizeFilename(name: string): string
  /** Hot first, then cold. */
  roots(): string[]
  /** The duration ffprobe reads, or an error; null when ffprobe isn't installed. */
  probeDuration(
    filePath: string,
    signal: AbortSignal
  ): Promise<{ duration: number } | { error: string } | null>
  /** A `.part` some queue item still owns (`downloadManager.getActiveDownloadByPath`). */
  isActivePart(partPath: string): boolean
  concurrency?: number
}

export const LOCAL_INTEGRITY_CONCURRENCY = 2

export function createLocalIntegrityStep(deps: LocalIntegrityStepDeps): PrepareStep {
  return {
    id: 'local-integrity',
    label: 'Downloaded episodes',
    requiresNetwork: false,
    isAvailable: () => ({ available: true }),
    async run(ctx): Promise<PrepareStepResult> {
      const episodes = Object.entries(deps.downloadedEpisodes())
      const anime = deps.downloadedAnime()
      const roots = deps.roots().filter(Boolean)
      const details: PrepareStepResult['details'] = []
      let ok = 0
      let done = 0
      let noProbe = false
      ctx.progress({ done, total: episodes.length })

      async function one([key, meta]: [string, EpisodeMeta]): Promise<void> {
        const [animeIdStr, episodeInt] = key.split(':')
        const animeId = Number(animeIdStr)
        const entry = anime[animeIdStr]
        const name = entry ? deps.displayName(entry) : `#${animeIdStr}`
        const label = `${name} episode ${episodeInt}`
        const report = (text: string): void => {
          details.push({ text: `${label}: ${text}`, status: 'warning', animeId })
        }
        try {
          if (!entry || !episodeInt) return report('no title record on this PC')
          const file = episodeVideoCandidates({
            dirs: roots,
            animeName: name,
            episodeInt,
            author: meta.author ?? '',
            sanitizeFilename: deps.sanitizeFilename
          }).find((p) => fs.existsSync(p))
          if (!file) return report('the video file is missing')
          const size = (await fs.promises.stat(file)).size
          if (size <= 0) return report('the video file is empty (0 bytes)')
          const probe = await deps.probeDuration(file, ctx.signal)
          if (probe === null) {
            noProbe = true
            ok++
            return
          }
          if ('error' in probe) return report(`ffprobe can't read it (${probe.error})`)
          if (!(probe.duration > 0)) return report('ffprobe reads no duration')
          ok++
        } finally {
          done++
          ctx.progress({ done, total: episodes.length, message: label })
        }
      }

      const queue = [...episodes]
      await Promise.all(
        Array.from(
          { length: Math.min(deps.concurrency ?? LOCAL_INTEGRITY_CONCURRENCY, queue.length) },
          async () => {
            while (queue.length > 0 && !ctx.signal.aborted) await one(queue.shift()!)
          }
        )
      )

      for (const part of findPartFiles(roots)) {
        if (deps.isActivePart(part)) continue
        details.push({
          text: `${path.basename(part)}: a partial download with no download running`,
          status: 'warning'
        })
      }
      if (noProbe) {
        details.push({
          text: "ffprobe isn't installed, so durations weren't checked",
          status: 'warning'
        })
      }
      details.unshift({
        text: `${ok} of ${episodes.length} ${episodes.length === 1 ? 'episode' : 'episodes'} ok`,
        status: ok === episodes.length ? 'ok' : 'warning'
      })
      return { status: worstStatus(details.map((d) => d.status)), details }
    }
  }
}

/** `<root>/<title>/*.part`, the only place a download writes one. */
function findPartFiles(roots: string[]): string[] {
  const out: string[] = []
  for (const root of roots) {
    let dirs: fs.Dirent[]
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      let files: string[]
      try {
        files = fs.readdirSync(path.join(root, d.name))
      } catch {
        continue
      }
      for (const f of files) if (f.endsWith('.part')) out.push(path.join(root, d.name, f))
    }
  }
  return out
}
