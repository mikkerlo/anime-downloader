// `copyVerified`'s `expect` (PR #633 review): the source is checked against
// what the caller expects on the temp file, before anything at `dest` is
// touched. Without `expect` (S6a's export), a copy is placed as before.
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import {
  ExpectationError,
  TMP_SUFFIX,
  copyVerified,
  nodeFs
} from '../../../src/main/lib/shared-library/copy'
import { cleanup, tempRoot } from '../../helpers/shared-library'

afterEach(cleanup)

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

function setup(): { src: string; dest: string; bytes: Buffer; old: Buffer } {
  const root = tempRoot()
  const bytes = Buffer.from('the drive’s episode')
  const old = Buffer.from('this PC’s own episode, longer than the other one')
  const src = path.join(root, 'src.mkv')
  const dest = path.join(root, 'out', 'dest.mkv')
  fs.writeFileSync(src, bytes)
  fs.mkdirSync(path.dirname(dest))
  fs.writeFileSync(dest, old)
  return { src, dest, bytes, old }
}

describe('copyVerified with expect', () => {
  it.each([
    ['a size', (b: Buffer) => ({ size: b.length + 1 })],
    ['a hash', (b: Buffer) => ({ size: b.length, sha256: sha(Buffer.from('else')) })]
  ])('%s that differs: ExpectationError, dest untouched, no temp file left', async (_l, want) => {
    const { src, dest, bytes, old } = setup()
    await expect(copyVerified(nodeFs, src, dest, { expect: want(bytes) })).rejects.toBeInstanceOf(
      ExpectationError
    )
    expect(fs.readFileSync(dest)).toEqual(old)
    expect(fs.existsSync(`${dest}${TMP_SUFFIX}`)).toBe(false)
  })

  it('a match is placed over dest', async () => {
    const { src, dest, bytes } = setup()
    const r = await copyVerified(nodeFs, src, dest, {
      expect: { size: bytes.length, sha256: sha(bytes) }
    })
    expect(r).toEqual({ size: bytes.length, sha256: sha(bytes) })
    expect(fs.readFileSync(dest)).toEqual(bytes)
  })

  it('without expect (the export) the copy is placed as before', async () => {
    const { src, dest, bytes } = setup()
    await copyVerified(nodeFs, src, dest)
    expect(fs.readFileSync(dest)).toEqual(bytes)
  })
})
