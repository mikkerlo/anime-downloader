// Hand-built fMP4 boxes for the keyframe tracker tests (#653): just enough of
// an init segment and of each fragment for a box walker, laid out as ffmpeg's
// `+frag_keyframe+empty_moov+default_base_moof+separate_moof` mux writes them.

export const SYNC = 0x02000000
export const NON_SYNC = 0x01010000

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0)
  return b
}

export function u64(n: number): Uint8Array {
  return concat([u32(Math.floor(n / 0x1_0000_0000)), u32(n % 0x1_0000_0000)])
}

function fourcc(type: string): Uint8Array {
  return new Uint8Array([...type].map((c) => c.charCodeAt(0)))
}

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload)
  return concat([u32(8 + body.byteLength), fourcc(type), body])
}

/** A box with the 64-bit `largesize` header (size field 1). */
export function largeBox(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload)
  return concat([u32(1), fourcc(type), u64(16 + body.byteLength), body])
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]) {
  return box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...payload)
}

export interface TrackSpec {
  id: number
  handler: 'vide' | 'soun'
  timescale: number
  trexDuration?: number
  trexFlags?: number
  /** Header version of `tkhd` and `mdhd` (1 = 64-bit times). */
  version?: 0 | 1
}

export function initSegment(tracks: TrackSpec[]): Uint8Array {
  const traks = tracks.map((t) => {
    const v = t.version ?? 0
    const time = v === 1 ? u64(0) : u32(0)
    const tkhd = fullBox('tkhd', v, 3, time, time, u32(t.id), u32(0), time, new Uint8Array(60))
    const mdhd = fullBox('mdhd', v, 0, time, time, u32(t.timescale), time, u32(0))
    const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc(t.handler), new Uint8Array(13))
    return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf')))
  })
  const trex = tracks.map((t) =>
    fullBox(
      'trex',
      0,
      0,
      u32(t.id),
      u32(1),
      u32(t.trexDuration ?? 0),
      u32(0),
      u32(t.trexFlags ?? 0)
    )
  )
  return concat([
    box('ftyp', fourcc('isom'), u32(512)),
    box('moov', fullBox('mvhd', 0, 0, new Uint8Array(96)), ...traks, box('mvex', ...trex))
  ])
}

export interface SampleSpec {
  duration?: number
  size?: number
  flags?: number
  cto?: number
}

export interface TrafSpec {
  trackId: number
  tfdt: number
  tfdtVersion?: 0 | 1
  tfhdDuration?: number
  tfhdFlags?: number
  firstSampleFlags?: number
  samples: SampleSpec[]
}

function traf(t: TrafSpec): Uint8Array {
  let tfhdBits = 0x020000
  const tfhdFields: Uint8Array[] = []
  if (t.tfhdDuration !== undefined) {
    tfhdBits |= 0x08
    tfhdFields.push(u32(t.tfhdDuration))
  }
  if (t.tfhdFlags !== undefined) {
    tfhdBits |= 0x20
    tfhdFields.push(u32(t.tfhdFlags))
  }
  const tfhd = fullBox('tfhd', 0, tfhdBits, u32(t.trackId), ...tfhdFields)
  const v = t.tfdtVersion ?? 0
  const tfdt = fullBox('tfdt', v, 0, v === 1 ? u64(t.tfdt) : u32(t.tfdt))
  const has = (k: keyof SampleSpec): boolean => t.samples.some((s) => s[k] !== undefined)
  let trunBits = 0x01
  if (t.firstSampleFlags !== undefined) trunBits |= 0x04
  if (has('duration')) trunBits |= 0x100
  if (has('size')) trunBits |= 0x200
  if (has('flags')) trunBits |= 0x400
  if (has('cto')) trunBits |= 0x800
  const fields: Uint8Array[] = [u32(t.samples.length), u32(0)]
  if (t.firstSampleFlags !== undefined) fields.push(u32(t.firstSampleFlags))
  for (const s of t.samples) {
    if (trunBits & 0x100) fields.push(u32(s.duration ?? 0))
    if (trunBits & 0x200) fields.push(u32(s.size ?? 0))
    if (trunBits & 0x400) fields.push(u32(s.flags ?? 0))
    if (trunBits & 0x800) fields.push(u32(s.cto ?? 0))
  }
  return box('traf', tfhd, tfdt, fullBox('trun', 0, trunBits, ...fields))
}

/** One `moof` + `mdat` pair; `mdatBytes` of payload, optionally behind a `largesize` header. */
export function fragment(
  trafs: TrafSpec[],
  opts: { mdatBytes?: number; largeMdat?: boolean; seq?: number } = {}
): Uint8Array {
  const moof = box('moof', fullBox('mfhd', 0, 0, u32(opts.seq ?? 1)), ...trafs.map(traf))
  const payload = new Uint8Array(opts.mdatBytes ?? 64).fill(0xab)
  return concat([moof, opts.largeMdat ? largeBox('mdat', payload) : box('mdat', payload)])
}

export { concat }

/** Top-level boxes of an MP4 byte stream, as `[type, start, end)`. */
export function topLevelBoxes(bytes: Uint8Array): { type: string; start: number; end: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: { type: string; start: number; end: number }[] = []
  let at = 0
  while (at + 8 <= bytes.byteLength) {
    let size = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    if (size === 1) size = view.getUint32(at + 8) * 0x1_0000_0000 + view.getUint32(at + 12)
    else if (size === 0) size = bytes.byteLength - at
    out.push({ type, start: at, end: at + size })
    at += size
  }
  return out
}
