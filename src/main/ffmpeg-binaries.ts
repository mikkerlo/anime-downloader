import { app, BrowserWindow } from 'electron'
import { EVENT_CHANNELS } from '@shared/ipc/channels'
import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { extractZip } from './lib/unzip'

const FFMPEG_VERSION = '6.1'
const RELEASE_BASE = `https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v${FFMPEG_VERSION}`

let ffmpegPath = ''
let ffprobePath = ''

export function getFfmpegPath(): string {
  return ffmpegPath
}

export function getFfprobePath(): string {
  return ffprobePath
}

export function clearFfmpegPaths(): void {
  ffmpegPath = ''
  ffprobePath = ''
}

export function getFfmpegDir(): string {
  return path.join(app.getPath('userData'), 'ffmpeg')
}

export interface FfmpegPlatformInfo {
  slug: string
  binaryName: string
}

export function detectFfmpegPlatform(
  plat: NodeJS.Platform = process.platform,
  arch: string = process.arch
): FfmpegPlatformInfo | null {
  if (plat === 'win32') {
    return { slug: 'win-64', binaryName: 'ffmpeg.exe' }
  }
  if (plat === 'darwin') {
    return { slug: 'macos-64', binaryName: 'ffmpeg' }
  }
  if (plat === 'linux') {
    if (arch === 'x64') return { slug: 'linux-64', binaryName: 'ffmpeg' }
    if (arch === 'ia32') return { slug: 'linux-32', binaryName: 'ffmpeg' }
    if (arch === 'arm64') return { slug: 'linux-arm-64', binaryName: 'ffmpeg' }
    if (arch === 'arm') return { slug: 'linux-armhf-32', binaryName: 'ffmpeg' }
  }
  return null
}

export function archiveUrl(component: 'ffmpeg' | 'ffprobe', slug: string): string {
  return `${RELEASE_BASE}/${component}-${FFMPEG_VERSION}-${slug}.zip`
}

async function downloadToFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body)
    throw new Error(`ffmpeg download failed: ${res.status} ${res.statusText} (${url})`)
  const totalHeader = res.headers.get('content-length')
  const total = totalHeader ? Number(totalHeader) : 0
  let received = 0
  const reader = (Readable.fromWeb(res.body as never) as Readable).on('data', (chunk: Buffer) => {
    received += chunk.length
    if (onProgress) onProgress(received, total)
  })
  await pipeline(reader, fs.createWriteStream(dest))
}

const ISSUES_URL = 'https://github.com/mikkerlo/anime-downloader/issues'

const DISK_ADVICE =
  'Check free disk space and permissions on the app data folder; the install retries on next launch.'

/**
 * Tell a local filesystem failure apart from a transport one (#472).
 *
 * Node puts `syscall` on the error it raises for a failed syscall — `ENOSPC`
 * from the write stream in `downloadToFile` (~29 MB per archive, ~79 MB once
 * inflated), `EACCES`/`EPERM` from `fs.mkdirSync(dest)` or `fs.mkdtempSync`, a
 * failed `rename`. An offline `fetch` rejects with a `TypeError` that keeps its
 * errno detail on `cause` instead, so the property on the error itself is
 * enough to split the two: without this check a full disk is reported as
 * "Check your connection", which sends the user in the wrong direction.
 */
function isFilesystemError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'syscall' in err
}

/**
 * Wrap `extractZip`'s structural message (#469) with the `ffmpeg:` prefix and
 * the recovery step the user can actually take. The extractor is shared with
 * fpcalc, so it deliberately knows nothing about either product; the split is
 * asserted on both sides in the tests.
 */
function describeExtractFailure(err: unknown): string {
  const inner = err instanceof Error ? err.message : String(err)
  // An unsupported method is a zip-feature gap on our side — nothing the user
  // can do but tell us. Everything else (no EOCD, truncated directory, a short
  // entry) means the bytes on disk are bad, and deleting them is the fix.
  if (/unsupported zip compression method/.test(inner)) {
    return `ffmpeg: ${inner}. Please report this at ${ISSUES_URL}.`
  }
  // `extractEntry` rethrows the raw fs error, so an `ENOSPC` while inflating
  // the ~79 MB of binaries arrives here too — and "probably truncated" is just
  // as wrong an answer as blaming the network (#472).
  if (isFilesystemError(err)) {
    return `ffmpeg: install failed while extracting (${inner}). ${DISK_ADVICE}`
  }
  return (
    `ffmpeg: ${inner} — the download was probably truncated. ` +
    'Delete the ffmpeg binaries in Settings → Debug and relaunch to retry.'
  )
}

/**
 * Last stop before the text reaches the user (#469). Everything this module
 * raises itself already names ffmpeg and carries its own next step — the
 * extractor wrap above, the `!res.ok` text in `downloadToFile`, the
 * binary-not-found throw, the unsupported-platform throw. Anything else came
 * from under us, and an offline `fetch` rejects with the bare two words
 * `fetch failed`, which is the single most likely thing the new error modal
 * will ever display. Give those a prefix and a next step — but only after
 * `isFilesystemError` has taken the local failures out, because a full disk or
 * an unwritable app data folder has nothing to do with the connection.
 *
 * Only the broadcast text is rewritten; `ensureFfmpeg` still rethrows the
 * original error so `cause` chains and existing callers are untouched.
 */
function describeInstallFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/^ffmpeg[: ]/.test(message)) return message
  if (isFilesystemError(err)) {
    return `ffmpeg: install failed (${message}). ${DISK_ADVICE}`
  }
  return (
    `ffmpeg: download failed (${message}). ` +
    'Check your connection; the install retries on next launch.'
  )
}

async function findBinaryRecursively(dir: string, name: string): Promise<string | null> {
  let entries: fs.Dirent[]
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) {
      const found = await findBinaryRecursively(full, name)
      if (found) return found
    }
  }
  return null
}

async function fetchComponent(
  component: 'ffmpeg' | 'ffprobe',
  slug: string,
  binaryName: string,
  destDir: string,
  finalPath: string,
  onProgress: (received: number, total: number) => void
): Promise<void> {
  // The randomness lives in the directory, not the filename, so the archive on
  // disk keeps its real asset name — `extractZip` labels its errors with the
  // basename and the user-facing message has to name the asset, not a token.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-dl-ffmpeg-'))
  const tmpArchive = path.join(tmpDir, `${component}-${FFMPEG_VERSION}-${slug}.zip`)
  try {
    await downloadToFile(archiveUrl(component, slug), tmpArchive, onProgress)
    try {
      await extractZip(tmpArchive, destDir)
    } catch (err) {
      throw new Error(describeExtractFailure(err), { cause: err })
    }
    const extracted = await findBinaryRecursively(destDir, binaryName)
    if (!extracted)
      throw new Error(
        `ffmpeg: ${binaryName} not found after extracting ${component}-${FFMPEG_VERSION}-${slug}.zip`
      )
    if (extracted !== finalPath) {
      await fsPromises.rename(extracted, finalPath)
    }
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(finalPath, 0o755)
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

export async function ensureFfmpeg(win?: BrowserWindow): Promise<string> {
  const dest = getFfmpegDir()
  const ext = process.platform === 'win32' ? '.exe' : ''
  const ffmpegBin = path.join(dest, `ffmpeg${ext}`)
  const ffprobeBin = path.join(dest, `ffprobe${ext}`)

  if (fs.existsSync(ffmpegBin) && fs.existsSync(ffprobeBin)) {
    ffmpegPath = ffmpegBin
    ffprobePath = ffprobeBin
    return ffmpegBin
  }

  const sendProgress = (status: string, progress?: number, message?: string): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(EVENT_CHANNELS.FFMPEG_DOWNLOAD_PROGRESS, { status, progress, message })
    }
  }

  try {
    // Inside the `try`, and below `sendProgress`, on purpose (#469). This throw
    // used to sit above both, so an unsupported platform was the one install
    // failure that never emitted `'failed'` at all — not a renderer-subscription
    // race, just a report that was never sent. It now reports like every other
    // failure.
    const platInfo = detectFfmpegPlatform()
    if (!platInfo) {
      throw new Error(`ffmpeg: unsupported platform ${process.platform}/${process.arch}`)
    }

    fs.mkdirSync(dest, { recursive: true })

    console.log(`[ffmpeg] Downloading ffmpeg + ffprobe ${FFMPEG_VERSION} for ${platInfo.slug} ...`)
    sendProgress('downloading', 0)

    const components: Array<{ name: 'ffmpeg' | 'ffprobe'; binary: string; finalPath: string }> = [
      { name: 'ffmpeg', binary: platInfo.binaryName, finalPath: ffmpegBin },
      {
        name: 'ffprobe',
        binary: platInfo.binaryName.replace(/^ffmpeg/, 'ffprobe'),
        finalPath: ffprobeBin
      }
    ]

    for (let i = 0; i < components.length; i++) {
      const { name, binary, finalPath } = components[i]
      await fetchComponent(name, platInfo.slug, binary, dest, finalPath, (received, total) => {
        if (total > 0) {
          const componentProgress = received / total
          const overall = (i + componentProgress) / components.length
          sendProgress('downloading', Math.round(overall * 100))
        }
      })
    }

    ffmpegPath = ffmpegBin
    ffprobePath = ffprobeBin
    sendProgress('done', 100)
    console.log(`[ffmpeg] Installed ffmpeg + ffprobe at ${dest}`)
    return ffmpegBin
  } catch (err) {
    // The renderer renders this verbatim (#469) — it is the only place a user
    // ever learns why merging is unavailable.
    sendProgress('failed', undefined, describeInstallFailure(err))
    console.error('[ffmpeg] Failed to install:', err)
    throw err
  }
}
