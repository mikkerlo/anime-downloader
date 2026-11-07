// The poster cache only ever holds images (#684): a host that answers a poster
// URL with a 200 HTML page must not leave that page behind as `<id>.jpg`.

/** Bytes needed to tell every accepted format apart (WebP's `WEBP` ends at 12). */
export const IMAGE_SIGNATURE_BYTES = 12

function startsWith(buf: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false
  return sig.every((b, i) => buf[offset + i] === b)
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/** True for a JPEG, PNG, GIF or WebP header. */
export function isImageBytes(buf: Uint8Array): boolean {
  return (
    startsWith(buf, [0xff, 0xd8, 0xff]) ||
    startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWith(buf, ascii('GIF87a')) ||
    startsWith(buf, ascii('GIF89a')) ||
    (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8))
  )
}
