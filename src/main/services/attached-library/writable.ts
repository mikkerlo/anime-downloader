// The one read-only check for attached Shared Libraries (#578). S8 (#582)
// reuses it on every availability transition. It never creates, opens for
// writing, renames or deletes anything: `access(W_OK)` on `<root>/.anime-dl`.
// Node's `fs.statfs` has no read-only flag, so `access` is the check. Where it
// can't see the truth (Windows write-protected media), S8 demotes a library on
// the first real write that fails with one of these codes.

import { constants, promises as fsp } from 'fs'
import * as path from 'path'
import { LIBRARY_DIR } from '../../lib/shared-library/read'

/** The errors that mean "this medium refuses writes". */
export const READ_ONLY_CODES: ReadonlySet<string> = new Set(['EROFS', 'EACCES', 'EPERM'])

export type WritableVerdict =
  | { kind: 'writable' }
  | { kind: 'read-only'; code: string }
  // Anything else: the caller leaves `access` as it was and logs `error`.
  | { kind: 'unknown'; error: unknown }

export async function checkWritable(
  root: string,
  access: (p: string, mode: number) => Promise<void> = (p, mode) => fsp.access(p, mode)
): Promise<WritableVerdict> {
  try {
    await access(path.join(root, LIBRARY_DIR), constants.W_OK)
    return { kind: 'writable' }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code && READ_ONLY_CODES.has(code)) return { kind: 'read-only', code }
    return { kind: 'unknown', error: err }
  }
}
