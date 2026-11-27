// AniList's calendar mapping (#709), pure: the tracked rows of
// `anilistUserRates`, a `Page.media(id_in)` response
// (`test/fixtures/anilist/calendar-tracked.json`) and the cached
// `displayAdultContent` in, `CalendarEntry[]` out. The IPC rows are
// `test/ipc/tracker-calendar.ipc.test.ts`'s.
import { describe, it, expect } from 'vitest'
import { anilistFixture } from '../helpers/anilist-server'
import {
  anilistCalendarEntries,
  trackedCalendarTitles,
  type AniListCalendarMedia
} from '../../src/main/trackers/anilist/calendar'
import type { AniListCachedRow } from '../../src/main/trackers/anilist/provider'

function row(mediaId: number, idMal: number | null, status: string): AniListCachedRow {
  return {
    entry: {
      id: 9000 + mediaId,
      mediaId,
      status: status as never,
      score: 0,
      progress: 0,
      repeat: 0,
      updatedAt: 1,
      media: { id: mediaId, idMal }
    },
    smotretAnime: null
  }
}

const ROWS: AniListCachedRow[] = [
  row(235, 235, 'CURRENT'),
  row(154587, 52991, 'PLANNING'),
  row(301, 301, 'REPEATING'),
  row(302, 302, 'CURRENT'),
  // AniList's answer has lost its MAL id since the list was read.
  row(303, 303, 'CURRENT'),
  row(950, 950, 'CURRENT'),
  row(400, 400, 'COMPLETED'),
  row(401, 401, 'PAUSED'),
  row(402, 402, 'DROPPED')
]

const media = (): AniListCalendarMedia[] =>
  anilistFixture<{ data: { Page: { media: AniListCalendarMedia[] } } }>('calendar-tracked').data
    .Page.media

describe('trackedCalendarTitles', () => {
  it('keeps watching, rewatching and planned rows, keyed by AniList id', () => {
    const tracked = trackedCalendarTitles(ROWS)
    expect([...tracked.keys()].sort((a, b) => a - b)).toEqual([235, 301, 302, 303, 950, 154587])
    expect(tracked.get(154587)).toEqual({ malId: 52991, status: 'planned' })
    expect(tracked.get(301)).toEqual({ malId: 301, status: 'rewatching' })
    expect(tracked.get(235)).toEqual({ malId: 235, status: 'watching' })
  })

  it('skips a row with no MAL id', () => {
    expect(trackedCalendarTitles([row(500, null, 'CURRENT')]).size).toBe(0)
  })
})

describe('anilistCalendarEntries', () => {
  it('maps one entry per tracked title from nextAiringEpisode, matched on id whatever the order', () => {
    const out = anilistCalendarEntries({ rows: ROWS, media: media(), displayAdultContent: false })
    expect(out.map((e) => e.malId)).toEqual([301, 235, 52991])
    const frieren = out.find((e) => e.malId === 52991)!
    expect(frieren).toEqual({
      malId: 52991,
      animeId: null,
      name: "Frieren: Beyond Journey's End",
      posterUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587.jpg',
      kind: 'tv',
      episodeInt: '5',
      nextEpisodeAt: new Date(1764300000 * 1000).toISOString(),
      userStatus: 'planned'
    })
  })

  it('a long-running title yields exactly one entry, its next episode', () => {
    const out = anilistCalendarEntries({ rows: ROWS, media: media(), displayAdultContent: false })
    expect(out.filter((e) => e.malId === 235)).toEqual([
      expect.objectContaining({ episodeInt: '1181', name: 'Case Closed' })
    ])
  })

  it('drops a title with nextAiringEpisode: null', () => {
    const out = anilistCalendarEntries({ rows: ROWS, media: media(), displayAdultContent: true })
    expect(out.some((e) => e.malId === 302)).toBe(false)
  })

  it('drops a media with no idMal', () => {
    const out = anilistCalendarEntries({ rows: ROWS, media: media(), displayAdultContent: true })
    expect(out.some((e) => e.malId === 303 || e.name === 'No MAL Id')).toBe(false)
  })

  it('drops a media that isn’t tracked (completed on the list)', () => {
    const out = anilistCalendarEntries({ rows: ROWS, media: media(), displayAdultContent: true })
    expect(out.some((e) => e.malId === 400)).toBe(false)
  })

  it('kind is format lowercased: TV_SHORT → tv_short', () => {
    const out = anilistCalendarEntries({ rows: ROWS, media: media(), displayAdultContent: false })
    expect(out.find((e) => e.malId === 301)!.kind).toBe('tv_short')
  })

  it('the name is the English title, else romaji', () => {
    const out = anilistCalendarEntries({ rows: ROWS, media: media(), displayAdultContent: false })
    expect(out.find((e) => e.malId === 301)!.name).toBe('Mini Anime')
  })

  it('displayAdultContent: false drops an adult title, true keeps it', () => {
    const off = anilistCalendarEntries({ rows: ROWS, media: media(), displayAdultContent: false })
    expect(off.some((e) => e.malId === 950)).toBe(false)
    const on = anilistCalendarEntries({ rows: ROWS, media: media(), displayAdultContent: true })
    expect(on.find((e) => e.malId === 950)).toMatchObject({ kind: 'ona', episodeInt: '3' })
  })

  it('smotret’s id and poster win when it has the title; AniList’s cover is the fallback', () => {
    const out = anilistCalendarEntries({
      rows: ROWS,
      media: media(),
      displayAdultContent: false,
      smotret: {
        52991: { id: 31337, posterUrlSmall: 'https://smotret/frieren.jpg' } as never,
        235: { id: 4242, posterUrlSmall: '' } as never
      }
    })
    expect(out.find((e) => e.malId === 52991)).toMatchObject({
      animeId: 31337,
      posterUrl: 'https://smotret/frieren.jpg'
    })
    expect(out.find((e) => e.malId === 235)).toMatchObject({
      animeId: 4242,
      posterUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx235.jpg'
    })
  })
})
