// The export size estimate and free-space rule (#574), shared so the dialog's
// live bar and main's start check can't disagree.

/** The margin kept free on the target, on top of the bytes to copy. */
export const FREE_SPACE_MARGIN = 0.01

/** The bytes an export of `bytes` needs free: the bytes plus a 1% margin. */
export function requiredBytes(bytes: number): number {
  return bytes + Math.ceil(bytes * FREE_SPACE_MARGIN)
}

/** Whether `bytes` fit in `free`; an unknown `free` (statfs failed) doesn't block. */
export function fitsFreeSpace(bytes: number, free: number | null): boolean {
  return free === null || requiredBytes(bytes) <= free
}

/**
 * A re-encode's output size isn't known up front (#576), so its free-space
 * need is its source's plus this margin.
 */
export const REENCODE_MARGIN = 0.1

/** The bytes an unmerged pair of `size` bytes needs when merged: the sum, plus 10% for a re-encode. */
export function mergedBytes(size: number, reencode: boolean): number {
  return reencode ? size + Math.ceil(size * REENCODE_MARGIN) : size
}

/** How unmerged pairs are exported (#576): merged or not, and whether the video is re-encoded. */
export interface ExportMergeChoice {
  merge: boolean
  reencode: boolean
}

export interface ExportEstimate {
  /** Bytes to copy: selected ready items the target doesn't already have. */
  bytes: number
  /** Selected ready items to copy. */
  items: number
  /** Of those, unmerged `.mp4` + `.ass` pairs (#576). */
  unmerged: number
  /** Selected items the target already has (same key, same size). */
  alreadyThere: number
  /** Selected items that are missing or busy, so not copied. */
  skipped: number
}

/** What exporting `selected` (item keys) into a target that has `present` would copy. */
export function exportEstimate(
  titles: readonly ExportTreeTitle[],
  selected: ReadonlySet<string>,
  present: readonly string[],
  choice: ExportMergeChoice = { merge: false, reencode: false }
): ExportEstimate {
  const there = new Set(present)
  const out: ExportEstimate = { bytes: 0, items: 0, unmerged: 0, alreadyThere: 0, skipped: 0 }
  for (const t of titles) {
    for (const tr of t.translations) {
      for (const ep of tr.episodes) {
        if (!selected.has(ep.key)) continue
        if (ep.state !== 'ready') out.skipped++
        else if (there.has(ep.key)) out.alreadyThere++
        else {
          out.items++
          if (ep.unmerged) out.unmerged++
          out.bytes += ep.unmerged && choice.merge ? mergedBytes(ep.size, choice.reencode) : ep.size
        }
      }
    }
  }
  return out
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

// The preflight's item warnings (#575), shared so the dialog's selection view
// and main's start say the same.
export const skippedWarning = (n: number): string =>
  `This drive is FAT32: ${n} ${plural(n, 'file', 'files')} over 4 GB will be skipped.`
export const mayBeSkippedWarning = (n: number): string =>
  `${n} re-encoded ${plural(n, 'file', 'files')} may be skipped if ${plural(n, 'it’s', 'they’re')} still over 4 GB.`
export const renamedWarning = (n: number): string =>
  `${n} ${plural(n, 'name', 'names')} will be changed to fit this drive and Windows. An index.html will help find them without the app.`
export const overflowWarning = (n: number): string =>
  `${n} ${plural(n, 'file', 'files')} will have paths too long for some Windows apps. Choose a shorter folder.`

export function preflightItemWarnings(p: {
  skipped: readonly string[]
  mayBeSkipped: readonly string[]
  renamed: readonly string[]
  overflow: readonly string[]
}): string[] {
  const out: string[] = []
  if (p.skipped.length > 0) out.push(skippedWarning(p.skipped.length))
  if (p.mayBeSkipped.length > 0) out.push(mayBeSkippedWarning(p.mayBeSkipped.length))
  if (p.renamed.length > 0) out.push(renamedWarning(p.renamed.length))
  if (p.overflow.length > 0) out.push(overflowWarning(p.overflow.length))
  return out
}

/** A plan-time preflight narrowed to the selected item keys. */
export function preflightForSelection(
  p: ExportPreflight,
  selected: ReadonlySet<string>
): ExportPreflight {
  const pick = (keys: readonly string[]): string[] => keys.filter((k) => selected.has(k))
  const out = {
    ...p,
    skipped: pick(p.skipped),
    mayBeSkipped: pick(p.mayBeSkipped),
    renamed: pick(p.renamed),
    overflow: pick(p.overflow)
  }
  out.warnings = [...p.driveWarnings, ...preflightItemWarnings(out)]
  return out
}

// With metadata (S6e #586): the dialog's texts, and main's refusals, in one place.
/** A new With metadata library's default name. */
export const metadataLibraryName = (nickname: string): string => `Anime Library (${nickname})`
export const LOG_IN_FOR_METADATA = 'Log in to Shikimori to include watch state'
export const METADATA_HELP =
  'Includes watch progress, Shikimori status, stars and priority for these titles only. Never includes passwords or tokens.'
export const CLAIMED_TARGET =
  'You use this library through a claim. Your export goes into a new library next to it.'
export const ROUTED_TO_METADATA =
  'This library carries watch state, so new titles are added with it.'
export const takeoverWarning = (nickname: string): string =>
  `You'll become the owner of this library. Other PCs that use it will see it as ${nickname}'s library.`
export const takeoverUnconfirmed = (name: string): string =>
  `Upgrading '${name}' to With metadata makes you its owner: confirm it first.`
