// `ffprobe -show_format` for a file's duration (#592's integrity step), with
// a timeout and a caller's abort. Never rejects.

import { execFile } from 'child_process'

export const PROBE_TIMEOUT_MS = 15_000

export function probeDuration(
  ffprobePath: string,
  filePath: string,
  signal?: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<{ duration: number } | { error: string }> {
  return new Promise((resolve) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-show_format', '-of', 'json', filePath],
      { timeout: timeoutMs, signal, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '')
            .trim()
            .split('\n')[0]
          resolve({ error: detail || error.message })
          return
        }
        try {
          const json = JSON.parse(String(stdout)) as { format?: { duration?: string } }
          const duration = Number(json.format?.duration)
          resolve(Number.isFinite(duration) ? { duration } : { error: 'no duration' })
        } catch {
          resolve({ error: 'unreadable ffprobe output' })
        }
      }
    )
  })
}
