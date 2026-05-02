import { spawn, type ChildProcess } from 'child_process'

export interface Fingerprint {
  hashes: Uint32Array
  durationSec: number
  hashesPerSec: number
}

export class FingerprintError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'FingerprintError'
  }
}

function killChild(proc: ChildProcess | null): void {
  if (!proc || proc.killed) return
  try { proc.kill('SIGKILL') } catch { /* ignore */ }
}

// fpcalc 1.5.x ships with FFmpeg statically linked, so it decodes the file
// itself and reports an accurate DURATION. Piping raw PCM in via stdin yields
// `DURATION=0` because there's no container metadata, so we always pass the
// file path directly.
export async function fingerprintFile(
  fpcalcPath: string,
  sourcePath: string,
  opts?: { signal?: AbortSignal }
): Promise<Fingerprint> {
  if (!fpcalcPath) throw new FingerprintError('fpcalc path not set')

  let fpcalc: ChildProcess | null = null
  if (opts?.signal?.aborted) throw new FingerprintError('aborted before start')
  const onAbort = (): void => killChild(fpcalc)
  opts?.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    return await new Promise<Fingerprint>((resolve, reject) => {
      fpcalc = spawn(fpcalcPath, ['-raw', '-length', '0', sourcePath], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }

      fpcalc.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
      fpcalc.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
      fpcalc.on('error', (err) => settle(() => reject(new FingerprintError(`fpcalc spawn failed: ${err.message}`, err))))
      fpcalc.on('exit', (code, signal) => {
        if (signal === 'SIGKILL') {
          settle(() => reject(new FingerprintError('fingerprinting cancelled')))
          return
        }
        if (code !== 0) {
          settle(() => reject(new FingerprintError(`fpcalc exited ${code}: ${stderr.trim() || 'no stderr'}`)))
          return
        }
        settle(() => {
          try {
            resolve(parseFpcalcOutput(stdout))
          } catch (err) {
            reject(err instanceof FingerprintError ? err : new FingerprintError(String(err)))
          }
        })
      })
    })
  } finally {
    opts?.signal?.removeEventListener('abort', onAbort)
    killChild(fpcalc)
  }
}

function parseFpcalcOutput(text: string): Fingerprint {
  let durationSec = 0
  let fingerprintLine = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('DURATION=')) {
      durationSec = Number(line.slice('DURATION='.length))
    } else if (line.startsWith('FINGERPRINT=')) {
      fingerprintLine = line.slice('FINGERPRINT='.length)
    }
  }
  if (!fingerprintLine) throw new FingerprintError('fpcalc output missing FINGERPRINT')
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new FingerprintError(`fpcalc output missing or invalid DURATION (got ${durationSec})`)

  const parts = fingerprintLine.split(',')
  const hashes = new Uint32Array(parts.length)
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i])
    if (!Number.isFinite(n)) throw new FingerprintError(`fpcalc output: bad hash at index ${i}: ${parts[i]}`)
    hashes[i] = n >>> 0
  }
  const hashesPerSec = hashes.length / durationSec
  return { hashes, durationSec, hashesPerSec }
}

export function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555)
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333)
  n = (n + (n >>> 4)) & 0x0f0f0f0f
  return (n * 0x01010101) >>> 24
}
