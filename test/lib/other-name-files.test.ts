// Library → Delete's pass over a title's other names (#663), on its own.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { deleteEpisodeFilesUnderOtherNames } from '../../src/main/lib/other-name-files'
import { sanitizeFilename } from '../../src/main/download-manager'
import type { DownloadedEpisodeEntry } from '../../src/main/lib/downloaded-episodes'

const entry = (author: string, translationId: number): DownloadedEpisodeEntry => ({
  translationType: 'subRu',
  author,
  quality: 720,
  translationId
})

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'other-name-files-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function put(folder: string, file: string): string {
  fs.mkdirSync(path.join(root, folder), { recursive: true })
  const fp = path.join(root, folder, file)
  fs.writeFileSync(fp, 'v')
  return fp
}

describe('deleteEpisodeFilesUnderOtherNames', () => {
  it('skips a name whose sanitized folder is the one the caller removed', () => {
    const kept = put('Show_', 'Show_ - 01 [Studio].mp4')
    const leftOnDisk = deleteEpisodeFilesUnderOtherNames({
      animeId: 32,
      names: ['Show?', 'Show_'],
      removedName: 'Show?',
      dirs: [root],
      episodes: { '32:1:321': entry('Studio', 321) },
      sanitizeFilename
    })
    expect(leftOnDisk).toBe(false)
    expect(fs.existsSync(kept)).toBe(true)
  })

  it("resolves only this title's entries, not another title's in the shared folder", () => {
    const mine = put('Шоу', 'Шоу - 01 [Studio].mp4')
    const theirs = put('Шоу', 'Шоу - 05 [Other].mp4')
    deleteEpisodeFilesUnderOtherNames({
      animeId: 32,
      names: ['Show', 'Шоу'],
      removedName: 'Show',
      dirs: [root],
      episodes: {
        '32:1:321': entry('Studio', 321),
        '7:5:71': entry('Other', 71)
      },
      sanitizeFilename
    })
    expect(fs.existsSync(mine)).toBe(false)
    expect(fs.existsSync(theirs)).toBe(true)
  })
})
