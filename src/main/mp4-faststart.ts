import * as fs from 'fs/promises'

export interface Mp4FaststartProbe {
  faststart: boolean
  firstNonFtypBox: string
}

export interface Mp4StreamingStatsSample {
  animeId: number
  animeName: string
  episodeInt: string
  episodeLabel: string
  filePath: string
  firstNonFtypBox: string
  checkedAt: number
}

export interface Mp4StreamingStats {
  totalChecked: number
  faststartCount: number
  nonFaststartSamples: Mp4StreamingStatsSample[]
}

const PEEK_SIZE = 64 * 1024

export async function probeMp4Faststart(filePath: string): Promise<Mp4FaststartProbe | null> {
  let fh: fs.FileHandle | null = null
  try {
    fh = await fs.open(filePath, 'r')
    const stat = await fh.stat()
    const len = Math.min(PEEK_SIZE, stat.size)
    if (len < 16) return null
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)

    let offset = 0
    let firstNonFtypBox: string | null = null
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset)
      const type = buf.toString('ascii', offset + 4, offset + 8)
      let boxSize = size
      if (size === 1) {
        if (offset + 16 > buf.length) break
        const high = buf.readUInt32BE(offset + 8)
        const low = buf.readUInt32BE(offset + 12)
        boxSize = high * 0x100000000 + low
      } else if (size === 0) {
        boxSize = stat.size - offset
      }

      if (type !== 'ftyp' && firstNonFtypBox === null) {
        firstNonFtypBox = type
      }
      if (type === 'moov') {
        return { faststart: true, firstNonFtypBox: firstNonFtypBox ?? 'moov' }
      }
      if (type === 'mdat') {
        return { faststart: false, firstNonFtypBox: firstNonFtypBox ?? 'mdat' }
      }
      if (boxSize < 8) break
      offset += boxSize
    }
    return firstNonFtypBox ? { faststart: false, firstNonFtypBox } : null
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ })
  }
}
