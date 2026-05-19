import type Ffmpeg from 'fluent-ffmpeg'

export function avcCodecString(stream: Ffmpeg.FfprobeStream): string | null {
  if (stream.codec_name !== 'h264') return null
  const profile = (stream.profile || '').toString().toLowerCase()
  let pp: string, cc: string
  if (profile.includes('constrained baseline')) {
    pp = '42'
    cc = 'E0'
  } else if (profile.includes('baseline')) {
    pp = '42'
    cc = '00'
  } else if (profile.includes('main')) {
    pp = '4D'
    cc = '40'
  } else if (profile.includes('high 10')) {
    pp = '6E'
    cc = '00'
  } else if (profile.includes('high 4:2:2')) {
    pp = '7A'
    cc = '00'
  } else if (profile.includes('high 4:4:4')) {
    pp = 'F4'
    cc = '00'
  } else if (profile.includes('high')) {
    pp = '64'
    cc = '00'
  } else return null
  const level = typeof stream.level === 'number' ? stream.level : 0
  if (level <= 0) return null
  const ll = level.toString(16).padStart(2, '0').toUpperCase()
  return `avc1.${pp}${cc}${ll}`
}

export function hevcCodecString(stream: Ffmpeg.FfprobeStream): string | null {
  if (stream.codec_name !== 'hevc') return null
  // Format: hvc1.<profile_space><profile_idc>.<compat_flags_hex_reversed>.<tier><level_idc>.<constraint_bytes>
  // Reference: ISO/IEC 14496-15 Annex E, Chromium spec at
  // https://source.chromium.org/chromium/chromium/src/+/main:media/base/video_codecs.cc
  const profile = (stream.profile || '').toString().toLowerCase()
  let profileIdc: number
  let compatFlags: number
  // `compatFlags` holds the raw general_profile_compatibility_flag bitfield
  // exactly as laid out in ISO/IEC 14496-15 §E.3 (MSB = flag[0] = Main profile,
  // next bit = Main 10, next = Main Still Picture, …). The codec string wants
  // the bit-reversed (LSB-first) hex form, which `reverseBits32` below produces:
  //   Main           → raw 0x60000000 → codec hex "6"  → hvc1.1.6.Lxx.B0
  //   Main 10        → raw 0x20000000 → codec hex "4"  → hvc1.2.4.Lxx.B0
  //   Main Still Pic → raw 0x40000000 → codec hex "2"  → hvc1.3.2.Lxx.B0
  if (profile.includes('main 10')) {
    profileIdc = 2
    compatFlags = 0x20000000
  } else if (profile.includes('main still')) {
    profileIdc = 3
    compatFlags = 0x40000000
  } else if (profile.includes('main')) {
    // Main-profile bitstreams are also decodable by Main 10 decoders, hence two bits set.
    profileIdc = 1
    compatFlags = 0x60000000
  } else {
    return null
  }
  // For HEVC, ffprobe's `level` is the raw HEVC level_idc value (for example
  // 120 → level 4.0, 150 → 5.0, 153 → 5.1, 156 → 5.2 in human-readable form).
  // The codec string uses that raw value directly, so we emit `L<level_idc>`
  // (for example `L120`, `L150`) rather than converting it to a decimal level.
  const levelIdc = typeof stream.level === 'number' ? stream.level : 0
  if (levelIdc <= 0) return null
  // Reverse 32-bit compatibility flags and emit as hex without leading zeros.
  const reversed = reverseBits32(compatFlags)
  const compatHex = reversed.toString(16).toUpperCase()
  // Tier: assume Main tier (L) — High tier (H) is rare outside 8K broadcast content.
  const tierAndLevel = `L${levelIdc}`
  // Constraint indicator flags: 6 bytes, typically all zero; Chromium accepts a
  // trailing `.B0` (or even truncation). Use `.B0` as a compact default.
  return `hvc1.${profileIdc}.${compatHex}.${tierAndLevel}.B0`
}

function reverseBits32(value: number): number {
  let v = value >>> 0
  let result = 0
  for (let i = 0; i < 32; i++) {
    result = (result << 1) | (v & 1)
    v >>>= 1
  }
  return result >>> 0
}

export function aacCodecString(stream: Ffmpeg.FfprobeStream): string | null {
  if (stream.codec_name !== 'aac') return null
  const profile = (stream.profile || '').toString().toUpperCase()
  if (profile === 'HE-AAC') return 'mp4a.40.5'
  if (profile === 'HE-AACV2' || profile === 'HE-AAC V2') return 'mp4a.40.29'
  return 'mp4a.40.2'
}
