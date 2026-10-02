import { app, BrowserWindow } from 'electron'
import { EVENT_CHANNELS } from '@shared/ipc/channels'
import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { extractZip } from './lib/unzip'

const FPCALC_VERSION = '1.5.1'
const RELEASE_BASE = `https://github.com/acoustid/chromaprint/releases/download/v${FPCALC_VERSION}`

let fpcalcPath = ''

export function getFpcalcPath(): string {
  return fpcalcPath
}

export function getFpcalcDir(): string {
  return path.join(app.getPath('userData'), 'fpcalc')
}

export interface FpcalcPlatformInfo {
  archiveName: string
  archiveFormat: 'tar.gz' | 'zip'
  binaryName: string
}

export function detectFpcalcPlatform(
  plat: NodeJS.Platform = process.platform,
  arch: string = process.arch
): FpcalcPlatformInfo | null {
  if (plat === 'linux' && arch === 'x64') {
    return {
      archiveName: `chromaprint-fpcalc-${FPCALC_VERSION}-linux-x86_64.tar.gz`,
      archiveFormat: 'tar.gz',
      binaryName: 'fpcalc'
    }
  }
  if (plat === 'darwin') {
    // Single x86_64 release; runs on Apple Silicon via Rosetta
    return {
      archiveName: `chromaprint-fpcalc-${FPCALC_VERSION}-macos-x86_64.tar.gz`,
      archiveFormat: 'tar.gz',
      binaryName: 'fpcalc'
    }
  }
  if (plat === 'win32') {
    // v1.5.1 ships exactly one Windows asset, x86_64. The `windows-i686` archive
    // this branch used to request for `ia32` 404s — v1.5.0 was the last release to
    // publish one — so 32-bit Windows falls through to `null` and takes the honest
    // unsupported-platform path instead of a doomed download. Do not "fix" it by
    // handing ia32 the x64 asset: a 64-bit PE cannot run under WOW64, and once it
    // is on disk the existence short-circuit below never re-attempts anything.
    // arm64 does take the x64 asset, relying on Windows 11's x64 emulation in the
    // same spirit as the Rosetta note above; a native arm64 asset needs a version
    // bump, which changes every existing user's fingerprints.
    if (arch === 'x64' || arch === 'arm64') {
      return {
        archiveName: `chromaprint-fpcalc-${FPCALC_VERSION}-windows-x86_64.zip`,
        archiveFormat: 'zip',
        binaryName: 'fpcalc.exe'
      }
    }
  }
  return null
}

async function downloadToFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body)
    throw new Error(`fpcalc download failed: ${res.status} ${res.statusText}`)
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

export async function ensureFpcalc(win?: BrowserWindow): Promise<string> {
  const dest = getFpcalcDir()
  const ext = process.platform === 'win32' ? '.exe' : ''
  const binary = path.join(dest, `fpcalc${ext}`)

  if (fs.existsSync(binary)) {
    fpcalcPath = binary
    return binary
  }

  const platInfo = detectFpcalcPlatform()
  if (!platInfo) {
    throw new Error(`fpcalc: unsupported platform ${process.platform}/${process.arch}`)
  }

  fs.mkdirSync(dest, { recursive: true })

  const sendProgress = (status: string, progress?: number): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(EVENT_CHANNELS.FPCALC_DOWNLOAD_PROGRESS, { status, progress })
    }
  }

  console.log(`[fpcalc] Downloading ${platInfo.archiveName} ...`)
  sendProgress('downloading', 0)

  const tmpArchive = path.join(os.tmpdir(), `${randomToken()}-${platInfo.archiveName}`)
  try {
    await downloadToFile(
      `${RELEASE_BASE}/${platInfo.archiveName}`,
      tmpArchive,
      (received, total) => {
        if (total > 0) sendProgress('downloading', Math.round((received / total) * 100))
      }
    )

    if (platInfo.archiveFormat === 'tar.gz') {
      await runTar(['-xzf', tmpArchive], dest)
    } else {
      // Zip goes through the in-process reader (#469), not the system `tar`.
      // The Windows archive worked only because `tar.exe` is bsdtar; this path
      // no longer depends on which tar flavour happens to be installed. The
      // archive nests its binary one level deep, which `extractZip` recreates
      // and `findBinaryRecursively` below then walks.
      await extractZip(tmpArchive, dest)
    }

    const extracted = await findBinaryRecursively(dest, platInfo.binaryName)
    if (!extracted)
      throw new Error(
        `fpcalc: binary ${platInfo.binaryName} not found after extracting ${platInfo.archiveName}`
      )
    if (extracted !== binary) {
      await fsPromises.rename(extracted, binary)
    }
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(binary, 0o755)
      } catch {
        /* ignore */
      }
    }
    fpcalcPath = binary
    sendProgress('done', 100)
    console.log(`[fpcalc] Installed at ${binary}`)
    return binary
  } catch (err) {
    sendProgress('failed')
    console.error('[fpcalc] Failed to install:', err)
    throw err
  } finally {
    try {
      fs.unlinkSync(tmpArchive)
    } catch {
      /* ignore */
    }
  }
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10)
}
