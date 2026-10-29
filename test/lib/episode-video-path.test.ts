// The player's name rule, shared with Prepare for offline's integrity step (#592).
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { episodeVideoCandidates } from '../../src/main/lib/episode-video-path'
import { sanitizeFilename } from '../../src/main/download-manager'

describe('episodeVideoCandidates', () => {
  it('per root: tagged .mkv/.mp4, then legacy .mkv/.mp4, hot before cold', () => {
    const got = episodeVideoCandidates({
      dirs: ['/hot', '/cold'],
      animeName: 'Show: Part 2',
      episodeInt: '3',
      author: 'Sub/Team',
      sanitizeFilename
    })
    const dir = sanitizeFilename('Show: Part 2')
    const base = sanitizeFilename('Show: Part 2 - 03')
    const tag = `${base} [${sanitizeFilename('Sub/Team')}]`
    expect(got).toEqual([
      path.join('/hot', dir, `${tag}.mkv`),
      path.join('/hot', dir, `${tag}.mp4`),
      path.join('/hot', dir, `${base}.mkv`),
      path.join('/hot', dir, `${base}.mp4`),
      path.join('/cold', dir, `${tag}.mkv`),
      path.join('/cold', dir, `${tag}.mp4`),
      path.join('/cold', dir, `${base}.mkv`),
      path.join('/cold', dir, `${base}.mp4`)
    ])
  })

  it('keeps a fractional episode as is and pads a single digit', () => {
    const [first] = episodeVideoCandidates({
      dirs: ['/d'],
      animeName: 'A',
      episodeInt: '12.5',
      author: 'x',
      sanitizeFilename
    })
    expect(path.basename(first)).toBe('A - 12.5 [x].mkv')
  })
})
