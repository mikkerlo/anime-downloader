import { describe, it, expect } from 'vitest'
import type Ffmpeg from 'fluent-ffmpeg'
import {
  avcCodecString,
  hevcCodecString,
  aacCodecString
} from '../../src/main/streaming/codec-strings'

function stream(s: Partial<Ffmpeg.FfprobeStream>): Ffmpeg.FfprobeStream {
  return s as Ffmpeg.FfprobeStream
}

describe('avcCodecString', () => {
  it('maps profiles and levels to avc1 codec strings', () => {
    expect(avcCodecString(stream({ codec_name: 'h264', profile: 'High', level: 40 }))).toBe(
      'avc1.640028'
    )
    expect(avcCodecString(stream({ codec_name: 'h264', profile: 'Main', level: 31 }))).toBe(
      'avc1.4D401F'
    )
    expect(
      avcCodecString(stream({ codec_name: 'h264', profile: 'Constrained Baseline', level: 30 }))
    ).toBe('avc1.42E01E')
  })

  it('returns null for non-h264, unknown profile, or non-positive level', () => {
    expect(avcCodecString(stream({ codec_name: 'vp9', profile: 'High', level: 40 }))).toBeNull()
    expect(avcCodecString(stream({ codec_name: 'h264', profile: 'Weird', level: 40 }))).toBeNull()
    expect(avcCodecString(stream({ codec_name: 'h264', profile: 'High', level: 0 }))).toBeNull()
  })
})

describe('hevcCodecString', () => {
  it('produces hvc1 strings with bit-reversed compatibility flags', () => {
    expect(hevcCodecString(stream({ codec_name: 'hevc', profile: 'Main', level: 120 }))).toBe(
      'hvc1.1.6.L120.B0'
    )
    expect(hevcCodecString(stream({ codec_name: 'hevc', profile: 'Main 10', level: 150 }))).toBe(
      'hvc1.2.4.L150.B0'
    )
    expect(
      hevcCodecString(stream({ codec_name: 'hevc', profile: 'Main Still Picture', level: 93 }))
    ).toBe('hvc1.3.2.L93.B0')
  })

  it('returns null for non-hevc, unsupported profile, or non-positive level', () => {
    expect(hevcCodecString(stream({ codec_name: 'h264', profile: 'Main', level: 120 }))).toBeNull()
    expect(hevcCodecString(stream({ codec_name: 'hevc', profile: 'Rext', level: 120 }))).toBeNull()
    expect(hevcCodecString(stream({ codec_name: 'hevc', profile: 'Main', level: 0 }))).toBeNull()
  })
})

describe('aacCodecString', () => {
  it('maps AAC profiles to mp4a object types', () => {
    expect(aacCodecString(stream({ codec_name: 'aac', profile: 'LC' }))).toBe('mp4a.40.2')
    expect(aacCodecString(stream({ codec_name: 'aac', profile: 'HE-AAC' }))).toBe('mp4a.40.5')
    expect(aacCodecString(stream({ codec_name: 'aac', profile: 'HE-AACv2' }))).toBe('mp4a.40.29')
  })

  it('returns null for non-aac streams', () => {
    expect(aacCodecString(stream({ codec_name: 'mp3', profile: 'LC' }))).toBeNull()
  })
})
