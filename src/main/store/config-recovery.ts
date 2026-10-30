import fs from 'node:fs'
import path from 'node:path'

export const CONFIG_FILE = 'config.json'
export const BACKUP_FILE = 'config.backup.json'

/** Thrown when an unreadable `config.json` can't be moved aside, so nothing was written. */
export class ConfigUnrecoverableError extends Error {
  readonly configPath: string
  readonly cause: unknown

  constructor(configPath: string, cause: unknown) {
    super(`${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ConfigUnrecoverableError'
    this.configPath = configPath
    this.cause = cause
  }
}

/**
 * conf's `deserialize`: strips one leading UTF-8 BOM (Notepad's "UTF-8 with
 * BOM", PowerShell 5's `-Encoding UTF8`) and rejects a root that isn't an
 * object, so `[1,2]` takes the corruption path instead of merging keys "0", "1".
 */
export function parseConfig(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyntaxError('The settings file does not hold a JSON object')
  }
  return value as Record<string, unknown>
}

/** The fatal box's text for any throw out of `createStorageService`. */
export function unreadableConfigMessage(err: unknown, dir: string): string {
  const configPath =
    err instanceof ConfigUnrecoverableError ? err.configPath : path.join(dir, CONFIG_FILE)
  const cause = err instanceof ConfigUnrecoverableError ? err.cause : err
  const reason = cause instanceof Error ? cause.message : String(cause)
  return (
    `Anime DL can't read its settings file (${configPath}): ${reason}. ` +
    'Move or fix the file, then start Anime DL again.'
  )
}

export function isSyntaxError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'SyntaxError'
}

/** Copies `src` over `dest` through a temp file and a rename, so `dest` is never half-written. */
function copyAtomic(src: string, dest: string): void {
  const tmp = `${dest}.tmp`
  try {
    fs.copyFileSync(src, tmp)
    fs.renameSync(tmp, dest)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Copies the `config.json` that just parsed to `config.backup.json`. A failure
 * (an AV lock on the backup) is logged, never thrown: a healthy config must
 * still start.
 */
export function saveLastGood(dir: string): void {
  try {
    copyAtomic(path.join(dir, CONFIG_FILE), path.join(dir, BACKUP_FILE))
  } catch (err) {
    console.error('[store] saving the last-known-good config copy failed:', err)
  }
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/**
 * Renames `file` to `<name>.corrupt-<YYYYMMDD-HHMMSS>.json` beside it and
 * returns the new path. An existing target is never overwritten: a `-1`, `-2`
 * … suffix is added instead.
 */
export function moveAside(file: string, now: Date = new Date()): string {
  const ext = path.extname(file)
  const base = path.join(path.dirname(file), `${path.basename(file, ext)}.corrupt-${stamp(now)}`)
  let target = `${base}${ext}`
  for (let n = 1; fs.existsSync(target); n++) target = `${base}-${n}${ext}`
  fs.renameSync(file, target)
  return target
}

/**
 * Called after `config.json` failed to parse. Moves it aside (or throws
 * `ConfigUnrecoverableError` having written nothing), then restores
 * `config.backup.json` when that parses. `keepBackup` is true when a backup
 * that couldn't be used is still in place, so the caller must not overwrite it.
 */
export function recoverConfig(dir: string): { notice: StartupNotice; keepBackup: boolean } {
  const configPath = path.join(dir, CONFIG_FILE)
  const backupPath = path.join(dir, BACKUP_FILE)
  let corruptPath: string
  try {
    corruptPath = moveAside(configPath)
  } catch (err) {
    throw new ConfigUnrecoverableError(configPath, err)
  }

  let backupSavedAt: number
  try {
    backupSavedAt = fs.statSync(backupPath).mtimeMs
    parseConfig(fs.readFileSync(backupPath, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { notice: { kind: 'config-reset', corruptPath }, keepBackup: false }
    }
    if (isSyntaxError(err)) {
      try {
        moveAside(backupPath)
        return { notice: { kind: 'config-reset', corruptPath }, keepBackup: false }
      } catch (moveErr) {
        console.error('[store] moving the unreadable config backup aside failed:', moveErr)
      }
    } else {
      console.error('[store] reading the config backup failed:', err)
    }
    return { notice: { kind: 'config-reset', corruptPath }, keepBackup: true }
  }

  try {
    copyAtomic(backupPath, configPath)
  } catch (err) {
    throw new ConfigUnrecoverableError(configPath, err)
  }
  return { notice: { kind: 'config-restored', corruptPath, backupSavedAt }, keepBackup: false }
}
