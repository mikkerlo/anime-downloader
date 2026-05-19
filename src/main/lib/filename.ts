// Parse episodeInt from a sanitized download filename. Format produced by
// download-manager.ts: `${name} - ${NN}[ [Author]].(mkv|mp4|ass|part)`.
const FILENAME_EP_RE = /\s-\s(\d{1,4}(?:\.\d+)?)(?:\s\[[^\]]+\])?\.(mkv|mp4|ass)$/i

export function parseEpisodeFromFilename(
  file: string
): { episodeInt: string; ext: 'mkv' | 'mp4' | 'ass' } | null {
  const m = FILENAME_EP_RE.exec(file)
  if (!m) return null
  const raw = m[1]
  const episodeInt = raw.includes('.') ? raw : String(parseInt(raw, 10))
  return { episodeInt, ext: m[2].toLowerCase() as 'mkv' | 'mp4' | 'ass' }
}
