// Streaming fMP4 keyframe tracker for the MSE back-eviction (#653).
//
// A plain module, not a composable. It is fed the raw `player:stream-chunk`
// payloads in order: ~256 KB batches of ffmpeg stdout that are not aligned to
// boxes, so a box header or a whole `moof` can be split across two chunks. It
// buffers only `moov` and `moof` boxes (carried over between chunks) and skips
// every other box, `mdat` included, by a remaining-byte count.
//
// For each video fragment whose first sample is a sync sample it records
// `tfdt / timescale + timestampOffset - frameDuration`: the fragment's decode
// time, which is at or below its PTS, one frame lower still. Chromium labels
// the keyframe at its PTS, so the recorded value always sits below it and a
// `remove()` ending there cannot cross it, whatever the rounding in the
// offset. On the copy path `tfdt` is already 2 frames below the PTS; the
// transcode encoders emit no composition offsets, so there the subtracted
// frame is the only margin.
//
// Uint8Array + DataView only, no Node `Buffer`.

const SAMPLE_IS_NON_SYNC = 0x00010000
// `moov` and `moof` are small on this mux (≤ 444 B per `moof`); anything larger
// than this is not something worth holding in memory, so it is skipped.
const MAX_BUFFERED_BOX = 4 * 1024 * 1024

export interface KeyframeTracker {
  /** Starts a new ffmpeg run whose fragments the SourceBuffer labels with `timestampOffset`. */
  reset(timestampOffset: number): void
  push(chunk: Uint8Array): void
  /** Recorded keyframe times on the SourceBuffer timeline, ascending. */
  keyframes(): readonly number[]
  /** Drops every entry at or below `before`. */
  prune(before: number): void
}

interface Box {
  type: string
  body: number
  end: number
}

interface TrackDefaults {
  duration: number
  flags: number
}

function typeAt(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3)
  )
}

function u64(view: DataView, at: number): number {
  return view.getUint32(at) * 0x1_0000_0000 + view.getUint32(at + 4)
}

function children(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = []
  let at = start
  while (at + 8 <= end) {
    let size = view.getUint32(at)
    const type = typeAt(view, at + 4)
    let header = 8
    if (size === 1) {
      if (at + 16 > end) break
      size = u64(view, at + 8)
      header = 16
    } else if (size === 0) {
      size = end - at
    }
    if (size < header || at + size > end) break
    out.push({ type, body: at + header, end: at + size })
    at += size
  }
  return out
}

function child(view: DataView, parent: Box, type: string): Box | undefined {
  return children(view, parent.body, parent.end).find((b) => b.type === type)
}

export function createKeyframeTracker(): KeyframeTracker {
  let offset = 0
  let list: number[] = []

  let videoTrackId: number | null = null
  let timescale = 0
  const trex = new Map<number, TrackDefaults>()

  // Box framing across chunks.
  const header = new Uint8Array(16)
  let headerFill = 0
  let headerNeed = 8
  let skip = 0
  let box: Uint8Array | null = null
  let boxFill = 0
  // A size-0 box runs to the end of the stream: nothing after it is a box.
  let done = false

  function reset(timestampOffset: number): void {
    offset = timestampOffset
    list = []
    videoTrackId = null
    timescale = 0
    trex.clear()
    headerFill = 0
    headerNeed = 8
    skip = 0
    box = null
    boxFill = 0
    done = false
  }

  function record(time: number): void {
    let i = list.length
    while (i > 0 && list[i - 1] > time) i--
    if (i > 0 && list[i - 1] === time) return
    list.splice(i, 0, time)
  }

  function parseMoov(view: DataView, moov: Box): void {
    for (const b of children(view, moov.body, moov.end)) {
      if (b.type === 'trak') {
        const tkhd = child(view, b, 'tkhd')
        const mdia = child(view, b, 'mdia')
        if (!tkhd || !mdia) continue
        const hdlr = child(view, mdia, 'hdlr')
        const mdhd = child(view, mdia, 'mdhd')
        if (!hdlr || !mdhd || typeAt(view, hdlr.body + 8) !== 'vide') continue
        videoTrackId = view.getUint32(tkhd.body + (view.getUint8(tkhd.body) === 1 ? 20 : 12))
        timescale = view.getUint32(mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12))
      } else if (b.type === 'mvex') {
        for (const t of children(view, b.body, b.end)) {
          if (t.type !== 'trex') continue
          trex.set(view.getUint32(t.body + 4), {
            duration: view.getUint32(t.body + 12),
            flags: view.getUint32(t.body + 20)
          })
        }
      }
    }
  }

  function parseTraf(view: DataView, traf: Box): void {
    let trackId: number | null = null
    let tfhdDuration: number | undefined
    let tfhdFlags: number | undefined
    let decodeTime: number | undefined
    let firstFlags: number | undefined
    let firstDuration: number | undefined
    let sawTrun = false
    for (const b of children(view, traf.body, traf.end)) {
      if (b.type === 'tfhd') {
        const flags = view.getUint32(b.body) & 0xffffff
        trackId = view.getUint32(b.body + 4)
        let at = b.body + 8
        if (flags & 0x01) at += 8
        if (flags & 0x02) at += 4
        if (flags & 0x08) {
          tfhdDuration = view.getUint32(at)
          at += 4
        }
        if (flags & 0x10) at += 4
        if (flags & 0x20) tfhdFlags = view.getUint32(at)
      } else if (b.type === 'tfdt') {
        decodeTime =
          view.getUint8(b.body) === 1 ? u64(view, b.body + 4) : view.getUint32(b.body + 4)
      } else if (b.type === 'trun' && !sawTrun) {
        // Only the fragment's first run: its first sample is where it starts.
        sawTrun = true
        const flags = view.getUint32(b.body) & 0xffffff
        if (view.getUint32(b.body + 4) === 0) return
        let at = b.body + 8
        if (flags & 0x01) at += 4
        if (flags & 0x04) {
          firstFlags = view.getUint32(at)
          at += 4
        }
        if (flags & 0x100) {
          firstDuration = view.getUint32(at)
          at += 4
        }
        if (flags & 0x200) at += 4
        if (flags & 0x400 && firstFlags === undefined) firstFlags = view.getUint32(at)
      }
    }
    if (trackId === null || trackId !== videoTrackId || decodeTime === undefined) return
    if (!sawTrun) return
    const defaults = trex.get(trackId)
    const flags = firstFlags ?? tfhdFlags ?? defaults?.flags ?? 0
    if (flags & SAMPLE_IS_NON_SYNC) return
    const duration = firstDuration ?? tfhdDuration ?? defaults?.duration ?? 0
    record((decodeTime - duration) / timescale + offset)
  }

  function parseTop(bytes: Uint8Array, type: string): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const [top] = children(view, 0, bytes.byteLength)
    if (!top) return
    try {
      if (type === 'moov') parseMoov(view, top)
      else if (videoTrackId !== null && timescale > 0) {
        for (const traf of children(view, top.body, top.end)) {
          if (traf.type === 'traf') parseTraf(view, traf)
        }
      }
    } catch {
      // A malformed box costs that box's keyframe, never the stream.
    }
  }

  function startBox(): void {
    const view = new DataView(header.buffer, 0, headerFill)
    const size32 = view.getUint32(0)
    const type = typeAt(view, 4)
    let size = size32
    if (size32 === 1) {
      if (headerFill < 16) {
        headerNeed = 16
        return
      }
      size = u64(view, 8)
    }
    const headerLength = headerFill
    headerFill = 0
    headerNeed = 8
    if (size32 === 0 || size < headerLength) {
      done = true
      return
    }
    if ((type === 'moov' || type === 'moof') && size <= MAX_BUFFERED_BOX) {
      box = new Uint8Array(size)
      box.set(header.subarray(0, headerLength))
      boxFill = headerLength
      if (boxFill === size) finishBox()
    } else {
      skip = size - headerLength
    }
  }

  function finishBox(): void {
    const bytes = box!
    box = null
    boxFill = 0
    parseTop(bytes, typeAt(new DataView(bytes.buffer), 4))
  }

  function push(chunk: Uint8Array): void {
    let at = 0
    while (at < chunk.byteLength && !done) {
      if (skip > 0) {
        const n = Math.min(skip, chunk.byteLength - at)
        skip -= n
        at += n
      } else if (box) {
        const n = Math.min(box.byteLength - boxFill, chunk.byteLength - at)
        box.set(chunk.subarray(at, at + n), boxFill)
        boxFill += n
        at += n
        if (boxFill === box.byteLength) finishBox()
      } else {
        const n = Math.min(headerNeed - headerFill, chunk.byteLength - at)
        header.set(chunk.subarray(at, at + n), headerFill)
        headerFill += n
        at += n
        if (headerFill === headerNeed) startBox()
      }
    }
  }

  return {
    reset,
    push,
    keyframes: () => list,
    prune(before: number): void {
      list = list.filter((k) => k > before)
    }
  }
}
