// Step 4 (#592): every `downloadedEpisodes` entry has its video in the hot or
// cold root (the player's name rule, under each of the title's names: the
// player's record's (#660), then its record chain's), larger than 0 bytes, with
// a duration ffprobe can read; and `.part` files no download owns are
// reported. Only a file under the first name, the one the player looks in,
// counts as ok. An entry of a title with no `downloadedAnime` record whose file
// isn't found is stale (#657): skipped and not counted. A file that goes away
// between the lookup and its `stat` counts as not found, and one `stat` can't
// read is a line (#662), never a step failure. Reports only: it never deletes,
// moves or rewrites anything.

import * as fs from 'fs'
import * as path from 'path'
import { titleNames } from '../../../lib/anime-record'
import { episodeVideoCandidates } from '../../../lib/episode-video-path'
import { errorText, type PrepareStep, type PrepareStepResult, worstStatus } from '../index'

type EpisodeMeta = { author?: string; translationId?: number }

export interface LocalIntegrityStepDeps {
  downloadedEpisodes(): Record<string, EpisodeMeta>
  /** Only whether a title has a record; names come from `playerRecord`, then `animeRecord`. */
  downloadedAnime(): Record<string, AnimeSearchResult>
  /** The record chain (`lib/anime-record.ts`): its names after the player's, e.g. a pre-rename folder. */
  animeRecord(animeId: number): AnimeSearchResult | null
  /** The record the player takes its name from (`playerRecordFrom`): the first name, and the label. */
  playerRecord(animeId: number): AnimeSearchResult | null
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
      let skipped = 0
      let done = 0
      let noProbe = false
      ctx.progress({ done, total: episodes.length })

      async function one([key, meta]: [string, EpisodeMeta]): Promise<void> {
        const [animeIdStr, episodeInt] = key.split(':')
        const animeId = Number(animeIdStr)
        const hasRecord = !!anime[animeIdStr]
        const player = deps.playerRecord(animeId)
        const entry = deps.animeRecord(animeId)
        const names = titleNames(player)
        for (const n of titleNames(entry)) if (!names.includes(n)) names.push(n)
        const named = player ?? entry
        const name = named ? deps.displayName(named) : `#${animeIdStr}`
        const label = `${name} episode ${episodeInt}`
        const report = (text: string): void => {
          details.push({ text: `${label}: ${text}`, status: 'warning', animeId })
        }
        try {
          if (!episodeInt) return report('the entry has no episode number')
          let file: string | undefined
          let foundUnder: string | undefined
          for (const animeName of names) {
            file = episodeVideoCandidates({
              dirs: roots,
              animeName,
              episodeInt,
              author: meta.author ?? '',
              sanitizeFilename: deps.sanitizeFilename
            }).find((p) => fs.existsSync(p))
            if (file) {
              foundUnder = animeName
              break
            }
          }
          if (!file && !hasRecord) {
            skipped++
            return
          }
          if (!file) return report('the video file is missing')
          let size: number
          try {
            size = (await fs.promises.stat(file)).size
          } catch (err) {
            const code = (err as NodeJS.ErrnoException | null)?.code
            if (code !== 'ENOENT') return report(`can't read it (${code ?? errorText(err)})`)
            if (!hasRecord) {
              skipped++
              return
            }
            return report('the video file is missing')
          }
          if (size <= 0) return report('the video file is empty (0 bytes)')
          const probe = await deps.probeDuration(file, ctx.signal)
          if (probe === null) noProbe = true
          else if ('error' in probe) return report(`ffprobe can't read it (${probe.error})`)
          else if (!(probe.duration > 0)) return report('ffprobe reads no duration')
          if (foundUnder !== names[0]) {
            return report(
              `the file is in the "${foundUnder}" folder, but the player looks in "${names[0]}"`
            )
          }
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
      const checked = episodes.length - skipped
      details.unshift({
        text: `${ok} of ${checked} ${checked === 1 ? 'episode' : 'episodes'} ok`,
        status: ok === checked ? 'ok' : 'warning'
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
