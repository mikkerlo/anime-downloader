// The read-only sync history (#585): pages of `sync-log/<yyyy-mm>.jsonl`,
// newest first, turned into plain lines. There is no undo and no per-entry
// action; the renderer only shows these.

import type { SyncLog, SyncLogDetail, SyncLogRecord } from './log'
import { monthOf } from './log'

export const HISTORY_DEFAULT_LIMIT = 30
export const HISTORY_MAX_LIMIT = 100

export interface HistoryNames {
  title(animeId: string): string
  titleOfMal(malId: number): string
  library(libraryId: string): string
}

const STATUS_LABEL: Record<string, string> = {
  planned: 'Planned',
  watching: 'Watching',
  rewatching: 'Rewatching',
  completed: 'Completed',
  on_hold: 'On Hold',
  dropped: 'Dropped'
}

const TRIGGER_LABEL: Record<SyncTrigger, string> = {
  attach: 'Library opened',
  plug: 'Drive connected',
  online: 'Back online',
  login: 'Signed in',
  manual: 'Sync now',
  prepare: 'Prepare for offline',
  export: 'Export with watch state'
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const when = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

/** A title's field, from the path below `titles.<id>.` (or a conflict's `fieldPath`). */
export function fieldLabel(sub: string): string {
  const w = /^watch\.(.+)\.(position|watched|watchedAt)$/.exec(sub)
  if (w) {
    if (w[2] === 'position') return `Ep ${w[1]} position`
    if (w[2] === 'watched') return `Ep ${w[1]}`
    return `Ep ${w[1]} first watched`
  }
  const r = /^rate\.(episodes|status|score|rewatches)$/.exec(sub)
  if (r) return r[1] === 'episodes' ? 'episodes watched' : r[1]
  const s = /^skip\.(.+)$/.exec(sub)
  if (s) return `Ep ${s[1]} skip times`
  if (sub === 'starred') return 'starred'
  if (sub === 'priority') return 'priority'
  if (sub === 'dismissed') return 'continue-watching dismissals'
  if (sub === 'rate') return 'Shikimori rate'
  return sub
}

export function formatValue(sub: string, v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (/\.position$/.test(sub) && typeof v === 'object' && 'position' in (v as object)) {
    return clock((v as SyncWatchPosition).position)
  }
  if (/\.watched$/.test(sub)) return v ? 'watched' : 'unwatched'
  if (sub === 'rate.status') return STATUS_LABEL[String(v)] ?? String(v)
  if (sub === 'rate.score') return Number(v) > 0 ? `★ ${v}` : 'no score'
  if (sub === 'starred' || sub === 'priority') return v ? 'on' : 'off'
  if (Array.isArray(v)) return v.join(', ') || 'none'
  if (typeof v === 'object') return 'changed'
  return String(v)
}

/** The plain value at a merge change path, for the log's details (skip entries have none). */
export function valueAt(doc: SyncDoc, p: string): unknown {
  if (p === 'priorityOrder') return doc.priorityOrder?.value
  const { animeId, sub } = splitPath(p)
  const t = animeId ? doc.titles[animeId] : undefined
  if (!t) return undefined
  const w = /^watch\.(.+)\.(position|watched|watchedAt)$/.exec(sub)
  if (w) {
    const e = t.watch?.[w[1]]
    if (!e) return undefined
    return w[2] === 'watchedAt' ? e.watchedAt : e[w[2] as 'position' | 'watched']?.value
  }
  const r = /^rate\.(episodes|status|score|rewatches)$/.exec(sub)
  if (r) return t.rate?.[r[1] as SyncRateField]?.value
  if (sub === 'starred' || sub === 'priority') return t[sub] ? true : undefined
  if (sub === 'dismissed') return t.dismissed
  return undefined
}

function splitPath(p: string): { animeId: string | null; sub: string } {
  const m = /^titles\.([^.]+)\.(.+)$/.exec(p)
  return m ? { animeId: m[1], sub: m[2] } : { animeId: null, sub: p }
}

function partyName(
  side: SyncLogDetail['from'],
  libraryId: string | undefined,
  names: HistoryNames
) {
  if (side === 'shikimori') return 'Shikimori'
  if (side === 'local') return 'this PC'
  return libraryId ? names.library(libraryId) : 'the Shared Library'
}

function detailLine(d: SyncLogDetail, names: HistoryNames): string {
  const { animeId, sub } = splitPath(d.path)
  const what = animeId
    ? `${names.title(animeId)}: ${fieldLabel(sub)}`
    : sub === 'priorityOrder'
      ? 'Priority order'
      : sub
  const values =
    sub === 'priorityOrder' || /^skip\./.test(sub) || sub === 'dismissed'
      ? ''
      : ` ${formatValue(sub, d.before)} → ${formatValue(sub, d.after)}`
  const lib = partyName('library', d.libraryId, names)
  if (d.to === 'local') return `${what}${values} from ${partyName(d.from, d.libraryId, names)}`
  if (d.to === 'library') return `${what}${values} written to ${lib}`
  return `${what}${values} sent to Shikimori`
}

/** A record written before #585 has paths only: `local:<path>` / `library:<path>`. */
function changeLine(change: string, libraryIds: string[], names: HistoryNames): string {
  const sep = change.indexOf(':')
  const side = change.slice(0, sep)
  const { animeId, sub } = splitPath(change.slice(sep + 1))
  const what = animeId ? `${names.title(animeId)}: ${fieldLabel(sub)}` : fieldLabel(sub)
  const lib = libraryIds.length === 1 ? names.library(libraryIds[0]) : 'the Shared Library'
  return side === 'local' ? `${what} changed from ${lib}` : `${what} written to ${lib}`
}

function runEntry(
  r: Extract<SyncLogRecord, { kind: 'run' }>,
  names: HistoryNames
): Omit<SyncHistoryEntry, 'key'> {
  const details: string[] = []
  if (r.details) for (const d of r.details) details.push(detailLine(d, names))
  else for (const c of r.changes) details.push(changeLine(c, r.libraries, names))
  for (const x of r.raises) {
    const title = names.title(x.animeId)
    const lib = names.library(x.libraryId)
    details.push(
      x.kind === 'forward'
        ? `${title}: Shikimori episodes ${x.from ?? '—'} → ${x.episodes} from episodes watched on ${lib}`
        : `${title}: Shikimori rewatch (episode ${x.episodes}) from episodes watched on ${lib}, until Shikimori confirms it`
    )
  }
  if (r.skippedMalIds.length > 0) {
    details.push(
      `Waiting for your queued Shikimori edits: ${r.skippedMalIds.map((m) => names.titleOfMal(m)).join(', ')}`
    )
  }
  for (const c of r.clamps) {
    const { animeId, sub } = splitPath(c.path)
    const what = animeId ? `${names.title(animeId)}: ${fieldLabel(sub)}` : c.path
    details.push(`${what} was dated ${when(c.at)} UTC, in the future; it counts as the sync time`)
  }
  for (const c of r.conflicts) {
    details.push(`Needs your input: ${names.title(c.animeId)}: ${fieldLabel(c.fieldPath)}`)
  }
  for (const c of r.resolvedElsewhere) {
    details.push(`${names.title(c.animeId)}: ${fieldLabel(c.fieldPath)} resolved elsewhere`)
  }
  const parts = [plural(r.counts.applied, 'update', 'updates')]
  if (r.counts.conflicts > 0) parts.push(`${r.counts.conflicts} need your input`)
  return {
    kind: 'run',
    at: r.at,
    trigger: r.trigger,
    libraries: r.libraries.map((id) => ({ libraryId: id, name: names.library(id) })),
    summary: `${TRIGGER_LABEL[r.trigger] ?? r.trigger}: ${parts.join(', ')}`,
    details
  }
}

function choiceText(choice: string, names: HistoryNames): string {
  if (choice === 'local') return 'kept this PC’s value'
  if (choice === 'shikimori') return 'kept Shikimori’s value'
  if (choice.startsWith('library:')) return `kept ${names.library(choice.slice(8))}’s value`
  if (choice === 'combine') return 'combined both'
  if (choice === 'one') return 'counted one rewatch'
  if (choice === 'two') return 'counted two rewatches'
  return choice
}

export function toEntry(
  r: SyncLogRecord,
  key: string,
  names: HistoryNames
): SyncHistoryEntry | null {
  if (r.kind === 'run') return { key, ...runEntry(r, names) }
  if (r.kind === 'rewatch-superseded') {
    return {
      key,
      kind: r.kind,
      at: r.at,
      libraries: r.libraryId ? [{ libraryId: r.libraryId, name: names.library(r.libraryId) }] : [],
      summary: `Your rewatch of ${names.title(r.animeId)} (episode ${r.episodes}) didn't count because Shikimori changed after it.`,
      details: []
    }
  }
  if (r.kind === 'shikimori-rejected') {
    return {
      key,
      kind: r.kind,
      at: r.at,
      libraries: [],
      summary: `Shikimori rejected ${r.fields.join(', ')} of ${names.titleOfMal(r.malId)} three times; it needs your input.`,
      details: r.error ? [r.error] : []
    }
  }
  if (r.kind === 'resolution') {
    const label = fieldLabel(r.fieldPath)
    const wrote = [
      ...(r.wrote.local ? ['this PC'] : []),
      ...r.wrote.libraries.map((id) => names.library(id)),
      ...(r.wrote.shikimori === 'queued' ? ['Shikimori (queued)'] : []),
      ...(r.wrote.shikimori === 'already' ? ['Shikimori (already had it)'] : [])
    ]
    return {
      key,
      kind: r.kind,
      at: r.at,
      libraries: r.libraryIds.map((id) => ({ libraryId: id, name: names.library(id) })),
      summary: `${names.title(r.animeId)}: ${label}: you ${choiceText(r.choice, names)} (${formatValue(r.fieldPath, r.value)})`,
      details: [...(wrote.length > 0 ? [`Written to ${wrote.join(', ')}`] : []), ...r.notes]
    }
  }
  return null
}

function mentions(r: SyncLogRecord, libraryId: string): boolean {
  if (r.kind === 'run') return r.libraries.includes(libraryId)
  if (r.kind === 'rewatch-superseded') return r.libraryId === libraryId
  if (r.kind === 'resolution') return r.libraryIds.includes(libraryId)
  return false
}

/**
 * One page, newest first: records with `at < before`, filtered by library.
 *
 * A file is not in `at` order: a run is stamped when it starts and appended
 * when it ends, and a resolution or a settle can append in between. So each
 * month is sorted by `at` (stable, newest first) before the walk. `append`
 * files a record by `monthOf(record.at)`, so month order plus the sort is the
 * global `at` order, and `before` is a cursor that skips nothing. (An
 * append-position cursor would shift when the size bound rewrites a file.)
 * Records sharing the last `at` all go on the same page, so a boundary never
 * splits a tie. Each month's file is read at most once per page and is
 * bounded by size.
 */
export async function listHistory(
  log: SyncLog,
  req: SyncHistoryRequest,
  names: HistoryNames
): Promise<SyncHistoryPage> {
  const before =
    typeof req.before === 'number' && Number.isFinite(req.before)
      ? req.before
      : Number.POSITIVE_INFINITY
  const limit = Math.min(
    HISTORY_MAX_LIMIT,
    Math.max(1, Math.floor(Number(req.limit) || HISTORY_DEFAULT_LIMIT))
  )
  const libraryId = typeof req.libraryId === 'string' ? req.libraryId : null
  const lastMonth = Number.isFinite(before) ? monthOf(before) : null
  const picked: { r: SyncLogRecord; key: string }[] = []
  let more = false
  for (const month of await log.months()) {
    if (lastMonth && month > lastMonth) continue
    const records = (await log.read(month))
      .map((r, i) => ({ r, key: `${month}:${i}:${r.at}` }))
      .reverse()
      .sort((a, b) => b.r.at - a.r.at)
    for (const x of records) {
      const r = x.r
      if (!(r.at < before) || (libraryId && !mentions(r, libraryId))) continue
      if (picked.length >= limit && r.at !== picked[picked.length - 1].r.at) {
        more = true
        break
      }
      picked.push(x)
    }
    if (more) break
  }
  const entries = picked
    .map((p) => toEntry(p.r, p.key, names))
    .filter((e): e is SyncHistoryEntry => !!e)
  return { entries, nextBefore: more ? picked[picked.length - 1].r.at : null }
}
