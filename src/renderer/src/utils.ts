export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

export function formatSpeed(bps: number): string {
  return formatBytes(bps) + '/s'
}

export function formatEta(item: DownloadProgressItem): string {
  if (item.speed <= 0 || item.totalBytes <= 0) return '--'
  const remaining = item.totalBytes - item.bytesReceived
  const seconds = Math.ceil(remaining / item.speed)
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function getAnimeName(anime: {
  title: string
  titles?: { ru?: string; romaji?: string }
}): string {
  return anime.titles?.romaji || anime.titles?.ru || anime.title
}

export function qualityLabel(height: number): string {
  return height + 'p'
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

// Slider seek helpers. Split into "preview" (drag in progress) and "commit"
// (mouseup) so the video element's `currentTime` is written only once per user
// gesture instead of once per drag tick. Each `video.currentTime = …` fires a
// `seeking` event that churns the MSE pipeline, which on Linux/WSL has been
// observed to cause repeated `readyState=1` stalls and audio dropout (#127).
export function previewSeek(rawValue: string, currentTime: { value: number }): number {
  const time = parseFloat(rawValue)
  if (!isFinite(time)) return currentTime.value
  currentTime.value = time
  return time
}

export function commitSeek(time: number, video: { currentTime: number } | null | undefined): void {
  if (!video) return
  if (!isFinite(time)) return
  video.currentTime = time
}
