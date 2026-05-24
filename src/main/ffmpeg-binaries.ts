import { app, BrowserWindow } from 'electron'
import { EVENT_CHANNELS } from '@shared/ipc/channels'
import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

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

function runTar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar exited with ${code}: ${stderr.trim()}`))
    })
  })
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
  const tmpArchive = path.join(os.tmpdir(), `${randomToken()}-${component}-${FFMPEG_VERSION}.zip`)
  try {
    await downloadToFile(archiveUrl(component, slug), tmpArchive, onProgress)
    // tar on Windows 10+, Linux, and macOS all extract .zip via -xf
    await runTar(['-xf', tmpArchive], destDir)
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
      fs.unlinkSync(tmpArchive)
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

  const platInfo = detectFfmpegPlatform()
  if (!platInfo) {
    throw new Error(`ffmpeg: unsupported platform ${process.platform}/${process.arch}`)
  }

  fs.mkdirSync(dest, { recursive: true })

  const sendProgress = (status: string, progress?: number): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(EVENT_CHANNELS.FFMPEG_DOWNLOAD_PROGRESS, { status, progress })
    }
  }

  console.log(`[ffmpeg] Downloading ffmpeg + ffprobe ${FFMPEG_VERSION} for ${platInfo.slug} ...`)
  sendProgress('downloading', 0)

  try {
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
    sendProgress('failed')
    console.error('[ffmpeg] Failed to install:', err)
    throw err
  }
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10)
}
