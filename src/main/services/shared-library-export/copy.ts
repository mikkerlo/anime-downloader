// The copy, verify and small-file helpers live in `lib/shared-library/copy.ts`
// (#579), shared with the import; only the export merge's temp name is its own.

import { TMP_SUFFIX } from '../../lib/shared-library/copy'

export * from '../../lib/shared-library/copy'

/** An export merge's output (#576): ffmpeg picks the muxer from the extension. */
export const MERGE_TMP_SUFFIX = `${TMP_SUFFIX}.mkv`
