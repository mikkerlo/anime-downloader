// The Shikimori chronology characterization (#710): franchises, the stores
// around them and the `shikimori:get-related` output captured on `main`
// (4fa7e3d1, before `buildChronology` was lifted out of the handler). Both
// `test/ipc/tracker-related.ipc.test.ts` (the handler) and
// `test/trackers/chronology.test.ts` (`buildChronology` itself) assert on them.
import * as fs from 'fs'
import * as path from 'path'

const SHIKIMORI_FIXTURES = path.join(__dirname, '..', 'fixtures', 'shikimori')

/** `test/fixtures/shikimori/franchise.json`, parsed fresh. */
export function franchiseFixture(): {
  links: unknown[]
  nodes: { id: number }[]
  current_id: number
} {
  return JSON.parse(fs.readFileSync(path.join(SHIKIMORI_FIXTURES, 'franchise.json'), 'utf8'))
}

/**
 * `shikimori:get-related(5114)` as `main` answered it: `plain` over
 * `franchise.json` (smotret has 121, no stores), `rich` over `RICH_FRANCHISE`
 * with `RICH_STORE` and `RICH_SMOTRET`.
 */
export function capturedChronology(): {
  plain: ShikiRelatedEntry[]
  rich: ShikiRelatedEntry[]
} {
  return JSON.parse(
    fs.readFileSync(path.join(SHIKIMORI_FIXTURES, 'franchise-chronology.json'), 'utf8')
  )
}

/** The smotret join for the plain case. */
export const PLAIN_SMOTRET: Record<number, Record<string, unknown>> = { 121: { id: 1, type: 'TV' } }

const node = (
  id: number,
  name: string,
  kind: string | null,
  date: number | null,
  year: number | null
) => ({
  id,
  date,
  name,
  image_url: `https://shikimori.one/system/animes/original/${id}.jpg`,
  url: `https://shikimori.one/animes/${id}`,
  year,
  kind,
  weight: 1
})

let linkId = 0
const link = (source: number, target: number, relation: string) => ({
  id: ++linkId,
  source_id: source,
  target_id: target,
  source,
  target,
  weight: 1,
  relation
})

/**
 * A franchise around 5114 that reaches every branch of today's handler: a
 * localized kind for each rule, a `pv` / `music` node dropped by the excluded
 * kinds, a node only `character`-linked (unreachable), a null date (sorts
 * last), a node whose kind the details cache overrides and one the rate cache
 * overrides, a smotret type, and a non-canonical edge out of current.
 */
export const RICH_FRANCHISE = {
  current_id: 5114,
  nodes: [
    node(5114, 'FMA: Brotherhood', 'TV Сериал', 1239000000, 2009),
    node(121, 'Fullmetal Alchemist', 'tv', 1065000000, 2003),
    node(9135, 'Sacred Star of Milos', 'Полнометражный фильм', 1309000000, 2011),
    node(6421, 'FMA: Brotherhood OP', 'Клип', 1240000000, 2009),
    node(6422, 'FMA: Brotherhood PV', 'Проморолик', 1230000000, 2009),
    node(6423, 'FMA: Brotherhood CM', 'Реклама', 1231000000, 2009),
    node(7777, 'Isekai Quartet', 'TV Сериал', 1555000000, 2019),
    node(8888, 'FMA: Reflections', 'Спешл', null, null),
    node(8889, 'FMA: TV Special', 'ТВ-спешл', 1100000000, 2004),
    node(9999, 'FMA: The Movie', 'tv', 1121000000, 2005),
    node(1111, 'FMA: Mini', 'ONA', 1600000000, 2020),
    node(2222, 'FMA: Premium', 'OVA', 1260000000, 2009),
    node(3333, 'FMA: Odd', 'Unknown kind', 1270000000, 2010)
  ],
  links: [
    link(121, 5114, 'sequel'),
    link(5114, 121, 'prequel'),
    link(5114, 9135, 'side_story'),
    link(9135, 5114, 'parent_story'),
    link(5114, 6421, 'other'),
    link(5114, 6421, 'side_story'),
    link(5114, 6422, 'summary'),
    link(6423, 5114, 'side_story'),
    link(5114, 7777, 'character'),
    link(121, 8888, 'side_story'),
    link(121, 8889, 'full_story'),
    link(5114, 9999, 'alternative_version'),
    link(9999, 1111, 'spin_off'),
    link(1111, 2222, 'alternative_setting'),
    link(2222, 3333, 'summary')
  ]
}

/** The stores the rich case reads: a details-cache kind, rate-cache kinds and statuses. */
export const RICH_STORE = {
  shikimoriAnimeDetails: {
    '9999': { details: { kind: 'movie' }, fetchedAt: 1 }
  },
  shikimoriUserRates: [
    {
      rate: { id: 1, target_id: 1111, status: 'completed', episodes: 1, score: 0 },
      shikiAnime: { id: 1111, kind: 'ona' },
      smotretAnime: null
    },
    {
      rate: { id: 2, target_id: 121, status: 'watching', episodes: 1, score: 0 },
      shikiAnime: { id: 121 },
      smotretAnime: null
    },
    {
      rate: { id: 3, target_id: 2222, status: 'dropped', episodes: 1, score: 0 },
      shikiAnime: { id: 2222, kind: 'special' },
      smotretAnime: null
    }
  ]
}

/** The smotret join for the rich case: 121 and 3333 are on smotret. */
export const RICH_SMOTRET: Record<number, Record<string, unknown>> = {
  121: { id: 1, type: 'TV', title: 'FMA', posterUrlSmall: 'p121.jpg', year: 2003 },
  3333: { id: 3, type: 'Special', title: 'Odd', posterUrlSmall: 'p3333.jpg', year: 2010 }
}
