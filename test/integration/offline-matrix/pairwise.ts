// The pairwise sweep of the offline scenario matrix (#659): worlds of one
// title with one entry, which together hold every pair of values of the 15
// factors below. Cold storage needs advanced mode, so a pair of a cold or
// away location with simple mode isn't required. A row with no file on this
// PC (location `none` or `away`) has no folder, file state, tag or container,
// so a pair with one of those counts only in a row whose file is there. The
// rows are a committed literal (a greedy covering array);
// `pairwise-coverage.test.ts` recomputes the pairs they cover, so a new
// level, or a deleted row, fails until a row covers its pairs. Made-up ids
// and names only.

import type { Action, EntrySpec, Names, TitleSpec } from '../../helpers/offline-world'
import type { Scenario } from './scenarios'
import { Q3, RECORD_LESS } from './sources'

export const FACTORS = {
  /** `downloadedAnime[id]`. */
  record: ['yes', 'no'],
  /** `library[id]`. */
  starred: ['yes', 'no'],
  /** `animeCache[id]`: under the download-time name, under a newer one, `animeDetail: null`, none. */
  cache: ['same', 'other', 'null', 'absent'],
  /** `recentAnimeMeta[id]`. */
  recent: ['yes', 'no'],
  /** Watched in the last 90 days (5 days ago), or not (120 days ago). */
  watched: ['yes', 'no'],
  /** `animeId:ep:trId`, or the legacy `animeId:ep`. */
  key: ['three', 'two'],
  /** The file in hot, in cold, in cold on an unplugged drive, or nowhere. */
  location: ['hot', 'cold', 'away', 'none'],
  /** The folder: the download-time first name, the title's ru name, a name no record holds. */
  folder: ['first', 'other', 'old'],
  file: ['healthy', 'empty', 'truncated'],
  tag: ['tagged', 'untagged'],
  ext: ['mp4', 'mkv'],
  mode: ['simple', 'advanced'],
  ffmpeg: ['yes', 'no'],
  player: ['system', 'builtin'],
  /** An offline run, or an online one, whose step 3 runs first. */
  offline: ['yes', 'no']
} as const

export type Factor = keyof typeof FACTORS
export type Row = { id: string } & { [F in Factor]: (typeof FACTORS)[F][number] }

/** Whether these values, a whole row's or some of them, can be one PC. */
export function allowed(values: Partial<Record<Factor, string>>): boolean {
  return !(values.mode === 'simple' && (values.location === 'cold' || values.location === 'away'))
}

/** The factors that describe the entry's file on this PC. */
export const FILE_FACTORS: readonly Factor[] = ['folder', 'file', 'tag', 'ext']
export const hasFile = (location: string): boolean => location === 'hot' || location === 'cold'

export const TABLE = `
id  record starred cache  recent watched key   location folder file      tag      ext mode     ffmpeg player  offline
P01 no     no      null   no     yes     two   hot      old    truncated untagged mkv advanced no     system  yes
P02 yes    yes     same   yes    no      three hot      other  healthy   untagged mp4 simple   yes    builtin no
P03 no     yes     absent no     yes     two   none     first  empty     untagged mp4 simple   yes    system  no
P04 yes    no      other  yes    no      two   cold     first  empty     tagged   mp4 advanced no     system  yes
P05 yes    no      absent no     yes     three away     first  healthy   untagged mkv advanced yes    builtin yes
P06 no     yes     other  yes    no      three none     old    truncated tagged   mkv simple   no     builtin no
P07 yes    no      same   no     no      two   none     first  truncated tagged   mp4 simple   no     system  yes
P08 yes    yes     absent yes    no      three hot      old    truncated tagged   mkv simple   yes    builtin no
P09 no     yes     absent no     no      three cold     other  empty     untagged mkv advanced no     system  yes
P10 no     no      same   no     yes     two   hot      old    empty     tagged   mp4 simple   yes    builtin no
P11 yes    no      null   yes    no      three hot      first  healthy   untagged mp4 simple   no     system  yes
P12 yes    yes     other  yes    yes     two   cold     old    truncated tagged   mkv advanced yes    builtin no
P13 no     no      same   yes    no      two   away     first  truncated tagged   mkv advanced no     system  no
P14 yes    no      other  no     yes     two   hot      other  healthy   tagged   mp4 simple   yes    builtin yes
P15 no     yes     other  yes    yes     three away     other  truncated tagged   mp4 advanced yes    builtin yes
P16 yes    yes     null   no     yes     three none     old    healthy   untagged mp4 advanced yes    builtin yes
P17 no     yes     same   yes    yes     two   hot      first  truncated tagged   mkv simple   no     builtin yes
P18 no     yes     null   no     no      two   away     first  empty     tagged   mkv advanced no     builtin no
P19 no     no      null   no     no      two   hot      other  truncated tagged   mp4 advanced yes    builtin yes
P20 yes    yes     same   no     no      two   cold     old    healthy   untagged mp4 advanced no     builtin yes
P21 yes    no      other  no     no      two   cold     first  healthy   untagged mkv advanced no     system  no
P22 no     no      absent yes    no      two   hot      first  healthy   untagged mp4 simple   yes    builtin no
P23 no     no      null   no     no      two   cold     other  empty     untagged mkv advanced yes    builtin yes
`

/** The table's header and its rows, as words; the self-test checks them against `FACTORS`. */
export function parseTable(text: string): { header: string[]; rows: Record<string, string>[] } {
  const [head, ...lines] = text
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
  return {
    header: head,
    rows: lines.map((words) => Object.fromEntries(head.map((h, i) => [h, words[i]])))
  }
}

export const ROWS = parseTable(TABLE).rows as Row[]

/**
 * The rows whose O9 fires, and the acceptance that covers it: a title with no
 * record, outside the Library and the cache scope (S11's), or an in-scope title
 * whose details aren't cached, in an offline run (S12's, the Q3 answer to
 * "Should step 4 flag a title whose details aren't cached?"; P05 has no cache
 * entry at all, P11 and P16 `animeDetail: null`, P09 is record-less but
 * starred). Every other row's O9 holds.
 */
export const AGREED_O9: Record<string, string> = {
  P05: Q3,
  P09: Q3,
  P11: Q3,
  P16: Q3,
  P22: RECORD_LESS
}

/** A row's world: title `300 + n`, its names `P<n> Show` / `П<n> Шоу`, renamed `P<n> Renamed`. */
export function rowScenario(row: Row): Scenario {
  const n = row.id.slice(1)
  const id = 300 + Number(n)
  const base: Names = { romaji: `P${n} Show`, ru: `П${n} Шоу`, title: `P${n} Show` }
  const renamed: Names = { romaji: `P${n} Renamed`, ru: base.ru, title: `P${n} Renamed` }
  const entry: EntrySpec = {
    ep: '1',
    trId: id * 10 + 1,
    key: row.key,
    where: row.location === 'cold' || row.location === 'away' ? 'cold' : 'hot',
    under:
      row.folder === 'first' ? base.romaji : row.folder === 'other' ? base.ru : `P${n} Old Name`,
    file: row.location === 'none' ? 'none' : row.file,
    ...(row.tag === 'untagged' ? { untagged: true } : {}),
    ext: row.ext
  }
  const cache = { same: base, other: renamed, null: null, absent: undefined }[row.cache]
  const title: TitleSpec = {
    id,
    ...(row.record === 'yes' ? { downloaded: base } : {}),
    ...(row.starred === 'yes' ? { library: base } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(row.recent === 'yes' ? { recent: base } : {}),
    watchedDaysAgo: row.watched === 'yes' ? 5 : 120,
    // Online, the server names the title as the newer cached details do.
    remote: row.cache === 'other' ? renamed : base,
    entries: [entry]
  }
  const actions: Action[] = row.offline === 'no' ? [{ do: 'metadata' }] : []
  const source = AGREED_O9[row.id]
  return {
    id: row.id,
    title: (Object.keys(FACTORS) as Factor[]).map((f) => `${f} ${row[f]}`).join(', '),
    world: {
      mode: row.mode,
      coldAway: row.location === 'away',
      ffmpeg: row.ffmpeg === 'yes',
      playerMode: row.player,
      offline: row.offline === 'yes',
      titles: [title]
    },
    ...(actions.length > 0 ? { actions } : {}),
    oracles: ['O1', 'O2', 'O6', 'O8', 'O9'],
    ...(source ? { agreed: [{ source, oracle: 'O9' as const }] } : {})
  }
}

export const PAIRWISE: Scenario[] = ROWS.map(rowScenario)

/** S32: O6 over every pairwise world, with the fixture library attached so step 5 runs too. */
export const S32: Scenario[] = PAIRWISE.map((p) => ({
  id: `S32/${p.id}`,
  title: `report only over ${p.id}'s world, with the fixture library attached`,
  world: { ...p.world, library: {} },
  ...(p.actions ? { actions: p.actions } : {}),
  oracles: ['O6']
}))
