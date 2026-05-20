import { describe, it, expect } from 'vitest'
import { parseEpisodeFromFilename } from '../../src/main/lib/filename'

describe('parseEpisodeFromFilename', () => {
  it('parses an integer episode and normalizes leading zeros', () => {
    expect(parseEpisodeFromFilename('Some Anime - 01.mkv')).toEqual({
      episodeInt: '1',
      ext: 'mkv'
    })
    expect(parseEpisodeFromFilename('Some Anime - 12.mp4')).toEqual({
      episodeInt: '12',
      ext: 'mp4'
    })
  })

  it('preserves fractional (.5) episodes verbatim', () => {
    expect(parseEpisodeFromFilename('Some Anime - 5.5.ass')).toEqual({
      episodeInt: '5.5',
      ext: 'ass'
    })
  })

  it('ignores an author tag suffix and lowercases the extension', () => {
    expect(parseEpisodeFromFilename('Some Anime - 03 [AniLibria].MKV')).toEqual({
      episodeInt: '3',
      ext: 'mkv'
    })
  })

  it('returns null for non-matching names', () => {
    expect(parseEpisodeFromFilename('Some Anime - 03.part')).toBeNull()
    expect(parseEpisodeFromFilename('poster.jpg')).toBeNull()
    expect(parseEpisodeFromFilename('Some Anime-03.mkv')).toBeNull()
  })
})
