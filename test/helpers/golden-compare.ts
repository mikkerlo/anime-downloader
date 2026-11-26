/**
 * Comparing a golden session (`golden-session.ts`) against the frozen 6.0.21
 * capture in `test/fixtures/golden-6.0.21/` (#689).
 *
 * Timestamps and `appVersion` are masked, and only them, by explicit field
 * name and path, never by a pattern over values: a broad mask hides real
 * changes. A mask that matches nothing in the golden fails its self-check, so
 * none goes stale. userData JSON compares as parsed values; the drive's v1 pair
 * compares as bytes after masking, since #713 (T13a) needs v1 byte identity.
 *
 * New top-level `config.json` keys are allowed only through
 * `GOLDEN_NEW_KEYS` (`golden-allow-list.ts`), at their listed defaults.
 */
import * as fs from 'fs'
import * as path from 'path'
import { GOLDEN_NEW_KEYS } from './golden-allow-list'
import type { GoldenCapture } from './golden-session'

export const GOLDEN_DIR = path.resolve(__dirname, '../fixtures/golden-6.0.21')
export const MASKED = '<masked>'

/** A dotted path; `*` stands for any one key or array index. */
export type MaskPath = string

/** The masked paths of every parsed artifact, keyed as `GoldenCapture` and its userData files. */
export const JSON_MASKS: Record<string, MaskPath[]> = {
  'config.json': [
    'animeCache.*.cachedAt',
    'attachedLibraries.*.lastSeenAt',
    'attachedLibraries.*.lastSyncAt',
    'autoDownloadSubscriptions.*.subscribedAt',
    'autoDownloadSubscriptions.*.lastCheckedAt',
    'prepareOfflineLastRun.finishedAt',
    'shikimoriCredentials.created_at',
    'shikimoriParkedQueues.*.parkedAt',
    'shikimoriParkedQueues.*.entries.*.queuedAt',
    'syncMeta.rates.*.*.at',
    'watchProgress.*.updatedAt',
    'watchProgress.*.watchedAt',
    'watchProgress.*.sync.*.at'
  ],
  'sync-pending/4242.json': ['rates.*.*.clock.at', 'rates.*.*.prePatch.serverUpdatedAt'],
  'sync-state/conflicts.json': ['records.*.at.*.at'],
  'sync-log/2026-11.jsonl': ['*.at'],
  'prepare.json': ['startedAt', 'finishedAt'],
  'tick.json': ['result.ranAt', 'broadcasts.*.args.*.ranAt']
}

/** The drive pair's masks: one named field inside one named block, matched in the bytes. */
export const DRIVE_MASKS: Record<string, { block: string; field: string }[]> = {
  'manifest.json': [
    { block: 'lastWriter', field: 'appVersion' },
    { block: 'lastWriter', field: 'at' }
  ],
  'state.json': []
}

/** `value` with every path in `masks` replaced by `MASKED`, and how often each mask hit. */
export function maskJson(
  value: unknown,
  masks: readonly MaskPath[]
): { masked: unknown; hits: Record<MaskPath, number> } {
  const masked = structuredClone(value)
  const hits: Record<MaskPath, number> = {}
  for (const mask of masks) {
    hits[mask] = 0
    const segs = mask.split('.')
    const walk = (node: unknown, i: number): void => {
      if (node === null || typeof node !== 'object') return
      const obj = node as Record<string, unknown>
      const keys = segs[i] === '*' ? Object.keys(obj) : segs[i] in obj ? [segs[i]] : []
      for (const k of keys) {
        if (i === segs.length - 1) {
          obj[k] = MASKED
          hits[mask]++
        } else {
          walk(obj[k], i + 1)
        }
      }
    }
    walk(masked, 0)
  }
  return { masked, hits }
}

/** The drive file's bytes with each `block.field` value replaced by `MASKED`. */
export function maskDrive(name: string, text: string): { masked: string; hits: number[] } {
  let masked = text
  const hits: number[] = []
  for (const { block, field } of DRIVE_MASKS[name] ?? []) {
    const re = new RegExp(`("${block}": \\{[^{}]*?"${field}": )("[^"]*"|-?\\d+(?:\\.\\d+)?)`, 'g')
    let n = 0
    masked = masked.replace(re, (_m, head: string) => {
      n++
      return `${head}"${MASKED}"`
    })
    hits.push(n)
  }
  return { masked, hits }
}

/**
 * `config.json` against the golden: every golden key with its value, masked;
 * any extra top-level key only from `allowList`, at its listed default.
 */
export function configProblems(
  actual: Record<string, unknown>,
  golden: Record<string, unknown>,
  allowList: Readonly<Record<string, unknown>> = GOLDEN_NEW_KEYS
): { extra: string[]; missing: string[]; offDefault: string[] } {
  const extra = Object.keys(actual).filter((k) => !(k in golden) && !(k in allowList))
  const missing = Object.keys(golden).filter((k) => !(k in actual))
  const offDefault = Object.keys(actual).filter(
    (k) =>
      !(k in golden) && k in allowList && JSON.stringify(actual[k]) !== JSON.stringify(allowList[k])
  )
  return { extra, missing, offDefault }
}

/** `config.json` minus the allow-listed keys, masked: what must equal the golden's. */
export function comparableConfig(config: Record<string, unknown>): unknown {
  const kept = Object.fromEntries(Object.entries(config).filter(([k]) => !(k in GOLDEN_NEW_KEYS)))
  return maskJson(kept, JSON_MASKS['config.json']).masked
}

function readJsonl(text: string): unknown[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function readTree(dir: string, rel = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const full = path.join(dir, rel)
  if (fs.statSync(full).isFile()) {
    const text = fs.readFileSync(full, 'utf8')
    out[rel] = rel.endsWith('.jsonl') ? readJsonl(text) : JSON.parse(text)
    return out
  }
  for (const name of fs.readdirSync(full).sort()) {
    Object.assign(out, readTree(dir, rel ? path.posix.join(rel, name) : name))
  }
  return out
}

/** The frozen capture, in `GoldenCapture`'s shape. */
export function loadGolden(): GoldenCapture {
  const read = (rel: string): string => fs.readFileSync(path.join(GOLDEN_DIR, rel), 'utf8')
  return {
    config: JSON.parse(read('config.json')),
    userData: readTree(path.join(GOLDEN_DIR, 'userData')),
    drive: Object.fromEntries(
      fs
        .readdirSync(path.join(GOLDEN_DIR, 'drive'))
        .sort()
        .map((f) => [f, read(path.join('drive', f))])
    ),
    prepare: JSON.parse(read('prepare.json')),
    tick: JSON.parse(read('tick.json'))
  }
}
