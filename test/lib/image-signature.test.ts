import { describe, it, expect } from 'vitest'
import { isImageBytes } from '../../src/main/lib/image-signature'

const bytes = (...b: number[]): Buffer => Buffer.from(b)

describe('isImageBytes (#684)', () => {
  it('accepts JPEG, PNG, GIF and WebP headers', () => {
    expect(isImageBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe(true)
    expect(isImageBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(true)
    expect(isImageBytes(Buffer.from('GIF87a…'))).toBe(true)
    expect(isImageBytes(Buffer.from('GIF89a…'))).toBe(true)
    expect(
      isImageBytes(Buffer.concat([Buffer.from('RIFF'), bytes(1, 2, 3, 4), Buffer.from('WEBPVP8 ')]))
    ).toBe(true)
  })

  it('rejects HTML, empty and truncated buffers', () => {
    expect(isImageBytes(Buffer.from('<!DOCTYPE html><html><title>Адрес сайта изменился!'))).toBe(
      false
    )
    expect(isImageBytes(Buffer.alloc(0))).toBe(false)
    expect(isImageBytes(bytes(0xff, 0xd8))).toBe(false)
    expect(isImageBytes(bytes(0x89, 0x50, 0x4e, 0x47))).toBe(false)
    expect(isImageBytes(Buffer.from('GIF8'))).toBe(false)
    // A RIFF container that is not WebP (a WAV), and a WebP cut before its tag.
    expect(isImageBytes(Buffer.from('RIFF\x01\x02\x03\x04WAVEfmt '))).toBe(false)
    expect(isImageBytes(Buffer.from('RIFF\x01\x02\x03\x04WE'))).toBe(false)
  })
})
