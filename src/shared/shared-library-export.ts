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

export interface ExportEstimate {
  /** Bytes to copy: selected ready items the target doesn't already have. */
  bytes: number
  /** Selected ready items to copy. */
  items: number
  /** Selected items the target already has (same key, same size). */
  alreadyThere: number
  /** Selected items that are missing or busy, so not copied. */
  skipped: number
}

/** What exporting `selected` (item keys) into a target that has `present` would copy. */
export function exportEstimate(
  titles: readonly ExportTreeTitle[],
  selected: ReadonlySet<string>,
  present: readonly string[]
): ExportEstimate {
  const there = new Set(present)
  const out: ExportEstimate = { bytes: 0, items: 0, alreadyThere: 0, skipped: 0 }
  for (const t of titles) {
    for (const tr of t.translations) {
      for (const ep of tr.episodes) {
        if (!selected.has(ep.key)) continue
        if (ep.state !== 'ready') out.skipped++
        else if (there.has(ep.key)) out.alreadyThere++
        else {
          out.items++
          out.bytes += ep.size
        }
      }
    }
  }
  return out
}
