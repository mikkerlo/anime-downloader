// The offline scenario matrix (#659): each row is a "PC" (`WorldSpec`), what
// the user does on it, the oracles that must hold, and step 4's exact output.
// Titles and comments cite issue numbers and function names, never file:line,
// so a PR that moves `local-integrity.ts` doesn't have to edit this table.
// Made-up ids and names only.
//
// A (row, oracle) pair that reports violations carries exactly one of:
// - `known`: a filed bug. The pin is the exact list seen today, so the fix PR
//   turns it red and removes it.
// - `agreed`: behaviour mikkerlo or an approved plan accepted, citing where.
//   The oracle must still report at least one violation, so the exemption
//   can't outlive the behaviour it excuses.
// A pin and its fix can land in either order: a bug fixed before its row
// landed (#660 in S07, S08 and S21, #662 in S31, #663 in S33, #664 in S17,
// #676 in S37 and S38, which landed with their fix, #679 in O11 on S09, S38,
// S40, P02 and P14, which landed with its fix) is a row with no pin, and
// a fix that lands after its pin removes it (#661 in S15/S16, and #674 in
// S36, which this matrix found). The pairwise rows
// P01–P23 and S32's are built in `pairwise.ts`.

import { named, type Action, type PreparedStep, type WorldSpec } from '../../helpers/offline-world'
import type { OracleId, Violation } from '../../helpers/offline-oracles'
import { PAIRWISE, S32 } from './pairwise'
import { LOCKED, Q3, RECORD_LESS } from './sources'

export interface Scenario {
  id: string
  title: string
  world: WorldSpec
  actions?: Action[]
  oracles: OracleId[]
  /** Step 4's run, temp roots normalised. */
  expect?: { status: PrepareOfflineStatus; details: string[] }
  /** Step 5's run (Shared Libraries), in a world with a `library`. */
  expectAttached?: { status: PrepareOfflineStatus; details: string[] }
  /** A whole run through the runner (`World.runPrepare`); O6 then covers that run too. */
  expectRun?: PreparedStep[]
  known?: { issue: number; oracle: OracleId; violations: Violation[] }[]
  agreed?: { source: string; oracle: OracleId }[]
  /** Uses a read-only folder for a file locked open, which neither Windows nor root honours. */
  locked?: true
}

const SHOW = named('Show')
const COLD_SHOW = named('Cold Show')

const BINARIES_OK: PreparedStep = {
  id: 'binaries',
  status: 'ok',
  details: ['ffmpeg: ok', 'ffprobe: ok', 'fpcalc: ok']
}
const offlineSkip = (id: PreparedStep['id']): PreparedStep => ({
  id,
  status: 'skipped',
  reason: 'Offline: connect to run this step',
  details: []
})
const NO_LIBRARY: PreparedStep[] = (['attached-integrity', 'library-sync'] as const).map((id) => ({
  id,
  status: 'unavailable',
  reason: 'No Shared Library attached',
  details: []
}))

export const SCENARIOS: Scenario[] = [
  {
    id: 'S01',
    title:
      'recorded, cached under the same name, a healthy hot file, and a .part the download manager owns',
    world: {
      titles: [{ id: 101, downloaded: SHOW, cache: SHOW, entries: [{ ep: '1', trId: 1011 }] }],
      parts: [{ under: 'Show', ep: '2', status: 'downloading' }]
    },
    oracles: ['O1', 'O2', 'O6', 'O8'],
    // The owned .part is not an orphan line, and ffprobe ran, so no ffprobe line.
    expect: { status: 'ok', details: ['1 of 1 episode ok'] }
  },
  {
    id: 'S02',
    title: 'recorded, a healthy file in cold storage (advanced mode)',
    world: {
      mode: 'advanced',
      titles: [
        {
          id: 102,
          downloaded: SHOW,
          cache: SHOW,
          entries: [{ ep: '1', trId: 1021, where: 'cold' }]
        }
      ]
    },
    oracles: ['O1', 'O6'],
    expect: { status: 'ok', details: ['1 of 1 episode ok'] }
  },
  {
    id: 'S03',
    title: 'recorded: a 0-byte file, a truncated .mp4, a missing file and an orphan .part',
    world: {
      titles: [
        {
          id: 103,
          downloaded: named('Broken'),
          cache: named('Broken'),
          entries: [
            { ep: '1', trId: 1031, file: 'empty' },
            { ep: '2', trId: 1032, file: 'truncated' },
            { ep: '3', trId: 1033, file: 'none' }
          ]
        }
      ],
      parts: [{ under: 'Broken', ep: '4', status: null }]
    },
    oracles: ['O2', 'O6', 'O8'],
    expect: {
      status: 'warning',
      details: [
        '0 of 3 episodes ok',
        'Broken episode 1: the video file is empty (0 bytes)',
        "Broken episode 2: ffprobe can't read it (moov atom not found)",
        'Broken episode 3: the video file is missing',
        'Broken - 04 [Author].mp4.part: a partial download with no download running'
      ]
    }
  },
  {
    id: 'S04',
    title: 'an untagged file from before author tags, under a three-part key',
    world: {
      titles: [
        {
          id: 104,
          downloaded: named('Untagged'),
          cache: named('Untagged'),
          entries: [{ ep: '1', trId: 1041, untagged: true }]
        }
      ]
    },
    oracles: ['O1'],
    expect: { status: 'ok', details: ['1 of 1 episode ok'] }
  },
  {
    id: 'S05',
    title: "an entry tagged with author A, and only author B's file on disk",
    world: {
      titles: [
        {
          id: 105,
          downloaded: named('Wrong Tag'),
          cache: named('Wrong Tag'),
          entries: [{ ep: '1', trId: 1051, author: 'A', fileAuthor: 'B' }]
        }
      ]
    },
    oracles: ['O1', 'O2'],
    expect: {
      status: 'warning',
      details: ['0 of 1 episode ok', 'Wrong Tag episode 1: the video file is missing']
    }
  },
  {
    id: 'S06',
    title: 'two translations of one episode, one of the files gone',
    world: {
      titles: [
        {
          id: 106,
          downloaded: named('Two Tr'),
          cache: named('Two Tr'),
          entries: [
            { ep: '1', trId: 1061, author: 'A' },
            { ep: '1', trId: 1062, author: 'B', file: 'none' }
          ]
        }
      ]
    },
    oracles: ['O2', 'O8'],
    expect: {
      status: 'warning',
      details: ['1 of 2 episodes ok', 'Two Tr episode 1: the video file is missing']
    }
  },
  {
    // #660 part A, fixed before this row landed: the step looks under the
    // player's record (`playerRecordFrom`, the cached details first).
    id: 'S07',
    title: 'name drift: the downloadedAnime record says "Old Name", the cached details "New Name"',
    world: {
      titles: [
        {
          id: 107,
          downloaded: named('Old Name'),
          cache: named('New Name'),
          entries: [{ ep: '1', trId: 1071 }]
        }
      ]
    },
    oracles: ['O1'],
    expect: {
      status: 'warning',
      details: [
        '0 of 1 episode ok',
        'New Name episode 1: the file is in the "Old Name" folder, but the player looks in "New Name"'
      ]
    }
  },
  {
    // #660 part A, fixed before this row landed.
    id: 'S08',
    title: 'romaji empty at download (folder under ru), the cached details gain romaji later',
    world: {
      titles: [
        {
          id: 108,
          downloaded: { romaji: '', ru: 'Дельта', title: 'Delta' },
          cache: { romaji: 'Delta R', ru: 'Дельта', title: 'Delta' },
          entries: [{ ep: '1', trId: 1081 }]
        }
      ]
    },
    oracles: ['O1'],
    expect: {
      status: 'warning',
      details: [
        '0 of 1 episode ok',
        'Delta R episode 1: the file is in the "Дельта" folder, but the player looks in "Delta R"'
      ]
    }
  },
  {
    id: 'S09',
    title: "recorded, the file only under the title's ru folder",
    world: {
      titles: [
        {
          id: 109,
          downloaded: { romaji: 'Nine', ru: 'Девять', title: 'Nine' },
          cache: { romaji: 'Nine', ru: 'Девять', title: 'Nine' },
          entries: [{ ep: '1', trId: 1091, under: 'Девять' }]
        }
      ]
    },
    oracles: ['O1', 'O2', 'O11'],
    expect: {
      status: 'warning',
      details: [
        '0 of 1 episode ok',
        'Nine episode 1: the file is in the "Девять" folder, but the player looks in "Nine"'
      ]
    }
  },
  {
    id: 'S10',
    title:
      'no downloadedAnime record, a recentAnimeMeta name, watched within 90 days; an online step 3 first',
    world: {
      titles: [
        {
          id: 110,
          recent: named('Watched'),
          watchedDaysAgo: 5,
          entries: [{ ep: '1', trId: 1101 }]
        }
      ]
    },
    actions: [{ do: 'metadata' }],
    oracles: ['O1', 'O9'],
    expect: { status: 'ok', details: ['1 of 1 episode ok'] }
  },
  {
    id: 'S11',
    title:
      'auto-downloaded (no record, a recentAnimeMeta name), not watched in 90 days; an online step 3 first',
    world: {
      titles: [
        {
          id: 111,
          recent: named('Auto Show'),
          watchedDaysAgo: 120,
          entries: [
            { ep: '1', trId: 1111 },
            { ep: '2', trId: 1112 }
          ]
        }
      ]
    },
    actions: [{ do: 'metadata' }],
    oracles: ['O2', 'O9'],
    agreed: [{ source: RECORD_LESS, oracle: 'O9' }],
    expect: { status: 'ok', details: ['2 of 2 episodes ok'] }
  },
  {
    id: 'S12',
    title: 'recorded, animeDetail: null in the cache, run offline',
    world: {
      titles: [
        {
          id: 112,
          downloaded: named('No Details'),
          cache: null,
          entries: [{ ep: '1', trId: 1121 }]
        }
      ]
    },
    oracles: ['O2', 'O6', 'O8', 'O9'],
    agreed: [{ source: Q3, oracle: 'O9' }],
    expect: { status: 'ok', details: ['1 of 1 episode ok'] }
  },
  {
    id: 'S13',
    title: 'Library → Delete while a file is locked, a recentAnimeMeta name, then Prepare',
    world: {
      titles: [
        {
          id: 113,
          downloaded: named('Locked'),
          cache: named('Locked'),
          recent: named('Locked'),
          entries: [{ ep: '1', trId: 1131 }]
        }
      ]
    },
    actions: [{ do: 'delete', id: 113, locked: true }],
    oracles: ['O3', 'O9'],
    agreed: [
      { source: LOCKED, oracle: 'O3' },
      { source: LOCKED, oracle: 'O9' }
    ],
    locked: true,
    expect: { status: 'ok', details: ['1 of 1 episode ok'] }
  },
  {
    id: 'S14',
    title: 'Library → Delete while a file is locked, no other name source, then Prepare',
    world: {
      titles: [
        {
          id: 114,
          downloaded: named('Locked Bare'),
          cache: named('Locked Bare'),
          entries: [{ ep: '1', trId: 1141 }]
        }
      ]
    },
    actions: [{ do: 'delete', id: 114, locked: true }],
    oracles: ['O2'],
    locked: true,
    // #657 Risks: "A record-less title with files and no name source … is
    // skipped", kept silent by mikkerlo's #657 answer 1
    // (https://github.com/mikkerlo/anime-downloader/issues/657#issuecomment-6617346173);
    // `0 of 0` reads `ok` (the #657 pin).
    expect: { status: 'ok', details: ['0 of 0 episodes ok'] }
  },
  {
    id: 'S15',
    title:
      'advanced, a cold-only title: cancel its queued episode after "Clear completed", then Prepare',
    world: {
      mode: 'advanced',
      titles: [
        {
          id: 115,
          downloaded: COLD_SHOW,
          cache: COLD_SHOW,
          queued: [{ ep: '3', trId: 1153 }],
          entries: [
            { ep: '1', trId: 1151, where: 'cold' },
            { ep: '2', trId: 1152, where: 'cold' }
          ]
        }
      ]
    },
    actions: [{ do: 'cancel-by-episode', id: 115, ep: '3' }],
    oracles: ['O7', 'O2'],
    // #661: the cancel sweep looks for files in every configured root, so the
    // title keeps its record and cached details, and both cold files count.
    expect: { status: 'ok', details: ['2 of 2 episodes ok'] }
  },
  {
    id: 'S16',
    title: 'S15 with a recentAnimeMeta name',
    world: {
      mode: 'advanced',
      titles: [
        {
          id: 116,
          downloaded: COLD_SHOW,
          cache: COLD_SHOW,
          recent: COLD_SHOW,
          queued: [{ ep: '3', trId: 1163 }],
          entries: [
            { ep: '1', trId: 1161, where: 'cold' },
            { ep: '2', trId: 1162, where: 'cold' }
          ]
        }
      ]
    },
    actions: [{ do: 'cancel-by-episode', id: 116, ep: '3' }],
    oracles: ['O7', 'O9'],
    // #661: the title keeps its record and cached details, so its page opens.
    expect: { status: 'ok', details: ['2 of 2 episodes ok'] }
  },
  {
    // #664, fixed in this row's base: the line names the unplugged drive.
    id: 'S17',
    title: 'advanced, the cold drive unplugged, recorded episodes on it',
    world: {
      mode: 'advanced',
      coldAway: true,
      titles: [
        {
          id: 117,
          downloaded: named('Away'),
          cache: named('Away'),
          entries: [
            { ep: '1', trId: 1171, where: 'cold' },
            { ep: '2', trId: 1172, where: 'cold' }
          ]
        }
      ]
    },
    oracles: ['O4'],
    expect: {
      status: 'warning',
      details: [
        '0 of 2 episodes ok',
        "Away episode 1: cold storage isn't connected (<cold>), so this episode wasn't checked",
        "Away episode 2: cold storage isn't connected (<cold>), so this episode wasn't checked"
      ]
    }
  },
  {
    id: 'S18',
    title: 'advanced, the cold drive unplugged, record-less episodes on it',
    world: {
      mode: 'advanced',
      coldAway: true,
      titles: [
        {
          id: 118,
          recent: named('Away Auto'),
          entries: [{ ep: '1', trId: 1181, where: 'cold' }]
        }
      ]
    },
    oracles: ['O2'],
    // #657 Risks: "Away cold drive": a record-less title whose files are only
    // on an unplugged cold drive is skipped, not reported.
    expect: { status: 'ok', details: ['0 of 0 episodes ok'] }
  },
  // Shared Library rows: the fixture library's titles are 101 (a shortened
  // folder, an .mp4 and its .ass) and 202 (an .mkv).
  {
    // #660 part B, fixed before this row landed: Copy to this PC files a title
    // with no record under this PC's name (`playerRecordFrom`: the cached
    // details, then the star), not the drive snapshot's.
    id: 'S21',
    title: 'Copy to this PC of a starred, cached title that the drive snapshot names differently',
    world: {
      titles: [{ id: 101, library: named('Local Name'), cache: named('Local Name'), entries: [] }],
      library: { names: { 101: 'Foreign Name' } }
    },
    actions: [{ do: 'copy-to-pc', keys: ['101:1:9001'] }],
    oracles: ['O1'],
    expect: { status: 'ok', details: ['1 of 1 episode ok'] }
  },
  {
    id: 'S22',
    title: 'Copy to this PC of a recorded title that the drive snapshot names differently',
    world: {
      titles: [
        { id: 101, downloaded: named('Local Name'), cache: named('Local Name'), entries: [] }
      ],
      library: { names: { 101: 'Foreign Name' } }
    },
    actions: [{ do: 'copy-to-pc', keys: ['101:1:9001'] }],
    oracles: ['O1'],
    expect: { status: 'ok', details: ['1 of 1 episode ok'] }
  },
  {
    id: 'S23',
    title: 'an attached library with an .mkv, ffmpeg missing, the built-in player',
    world: {
      ffmpeg: false,
      playerMode: 'builtin',
      titles: [
        { id: 101, cache: named('Drive Show'), entries: [] },
        { id: 202, cache: named('Drive Mkv'), entries: [] }
      ],
      library: {}
    },
    oracles: ['O1'],
    // mikkerlo's Q1 answer
    // (https://github.com/mikkerlo/anime-downloader/issues/659#issuecomment-6634458758):
    // today's lines are enough, so step 5 counts the .mkv ok and O1 has no
    // .mkv clause.
    expectAttached: { status: 'ok', details: ['Fixture library: 2 items ok'] }
  },
  {
    id: 'S24',
    title: 'a local .mkv, ffmpeg missing, the built-in player',
    world: {
      ffmpeg: false,
      playerMode: 'builtin',
      titles: [
        {
          id: 124,
          downloaded: named('Local Mkv'),
          cache: named('Local Mkv'),
          entries: [{ ep: '1', trId: 1241, ext: 'mkv' }]
        }
      ]
    },
    oracles: ['O1'],
    // mikkerlo's Q1 answer, as S23: counted ok, and the ffprobe line is the
    // only word about the missing binaries.
    expect: {
      status: 'warning',
      details: ['1 of 1 episode ok', "ffprobe isn't installed, so durations weren't checked"]
    }
  },
  {
    id: 'S25',
    title: 'an attached library whose drive is unplugged',
    world: { titles: [], library: { away: true } },
    oracles: ['O4'],
    expectAttached: { status: 'skipped', details: ['Fixture library: Drive not connected'] }
  },
  {
    id: 'S26',
    title: 'an attached library with one item gone from the drive and one of the wrong size',
    world: {
      titles: [],
      library: { damaged: { '101:1:9001': 'wrong-size', '202:1:9101': 'missing' } }
    },
    oracles: ['O2'],
    expectAttached: {
      status: 'warning',
      details: [
        "Fixture library: Frieren episode 1 (Crunchyroll): the file's size doesn't match the library",
        'Fixture library: Dungeon Meshi episode 1 (AniLibria): missing on the drive'
      ]
    }
  },
  {
    id: 'S27',
    title: 'no Shared Library attached',
    world: {
      titles: [{ id: 127, downloaded: SHOW, cache: SHOW, entries: [{ ep: '1', trId: 1271 }] }]
    },
    oracles: [],
    expectRun: [
      BINARIES_OK,
      offlineSkip('shikimori-rates'),
      offlineSkip('metadata'),
      { id: 'local-integrity', status: 'ok', details: ['1 of 1 episode ok'] },
      ...NO_LIBRARY
    ]
  },
  {
    id: 'S28',
    title: 'Work offline (offline-manual): the network steps are skipped, the local ones run',
    world: {
      titles: [{ id: 128, downloaded: SHOW, cache: SHOW, entries: [{ ep: '1', trId: 1281 }] }]
    },
    // O6 over the whole run: step 3 would refresh this title's cached details.
    oracles: ['O6'],
    expectRun: [
      BINARIES_OK,
      offlineSkip('shikimori-rates'),
      offlineSkip('metadata'),
      { id: 'local-integrity', status: 'ok', details: ['1 of 1 episode ok'] },
      ...NO_LIBRARY
    ]
  },
  {
    id: 'S29',
    title: 'logged out of Shikimori, an online run',
    world: {
      offline: false,
      titles: [{ id: 129, downloaded: SHOW, cache: SHOW, entries: [{ ep: '1', trId: 1291 }] }]
    },
    oracles: [],
    expectRun: [
      BINARIES_OK,
      { id: 'shikimori-rates', status: 'skipped', details: ['Not logged in'] },
      { id: 'metadata', status: 'ok', details: ['1 of 1 title up to date'] },
      { id: 'local-integrity', status: 'ok', details: ['1 of 1 episode ok'] },
      ...NO_LIBRARY
    ]
  },
  {
    id: 'S30',
    title: 'logged in to Shikimori with one queued edit, an offline run',
    world: {
      shikimori: { queued: 1 },
      titles: [{ id: 130, downloaded: SHOW, cache: SHOW, entries: [{ ep: '1', trId: 1301 }] }]
    },
    // O6 over the whole run: the queued edit is still there, unsent.
    oracles: ['O6'],
    expectRun: [
      BINARIES_OK,
      offlineSkip('shikimori-rates'),
      offlineSkip('metadata'),
      { id: 'local-integrity', status: 'ok', details: ['1 of 1 episode ok'] },
      ...NO_LIBRARY
    ]
  },
  {
    // #662, fixed before this row landed: a file gone before its `stat` is a line.
    id: 'S31',
    title: 'a file is unlinked mid-run, between the lookup and its stat',
    world: {
      titles: [
        {
          id: 131,
          downloaded: named('Race'),
          cache: named('Race'),
          entries: [{ ep: '1', trId: 1311 }]
        },
        {
          id: 132,
          downloaded: named('Other'),
          cache: named('Other'),
          entries: [{ ep: '1', trId: 1321 }]
        }
      ]
    },
    actions: [{ do: 'unlink-before-stat', match: 'Race - 01' }],
    oracles: ['O8', 'O2'],
    expect: {
      status: 'warning',
      details: ['1 of 2 episodes ok', 'Race episode 1: the video file is missing']
    }
  },
  ...S32,
  {
    // #663, fixed before this row landed: Delete also removes the title's
    // episodes under its ru and title folders (`deleteEpisodeFilesUnderOtherNames`).
    id: 'S33',
    title:
      'Library → Delete of a recorded title with episode 1 under its ru folder, 2 under romaji',
    world: {
      titles: [
        {
          id: 133,
          downloaded: { romaji: 'Split', ru: 'Сплит', title: 'Split' },
          cache: { romaji: 'Split', ru: 'Сплит', title: 'Split' },
          entries: [
            { ep: '1', trId: 1331, under: 'Сплит' },
            { ep: '2', trId: 1332 }
          ]
        }
      ]
    },
    actions: [{ do: 'delete', id: 133 }],
    oracles: ['O2', 'O7'],
    expect: { status: 'ok', details: ['0 of 0 episodes ok'] }
  },
  {
    id: 'S34',
    title: "Library → Delete, then Prepare, then a restart's reconcile, then the export",
    world: {
      titles: [
        {
          id: 134,
          downloaded: named('Gone'),
          cache: named('Gone'),
          entries: [
            { ep: '1', trId: 1341 },
            { ep: '2', trId: 1342 }
          ]
        },
        {
          id: 234,
          downloaded: named('Kept'),
          cache: named('Kept'),
          entries: [{ ep: '1', trId: 2341 }]
        }
      ]
    },
    actions: [{ do: 'delete', id: 134 }],
    oracles: ['O3'],
    expect: { status: 'ok', details: ['1 of 1 episode ok'] }
  },
  {
    // Going offline puts an active transfer back to 'queued' and keeps its
    // .part (`suspendForOffline`); any item that isn't cancelled owns it.
    id: 'S35',
    title: 'the .part of a download that going offline suspended',
    world: {
      titles: [
        {
          id: 135,
          downloaded: named('Suspended'),
          cache: named('Suspended'),
          entries: [{ ep: '1', trId: 1351 }]
        }
      ],
      parts: [{ under: 'Suspended', ep: '2', status: 'queued' }]
    },
    oracles: ['O2'],
    expect: { status: 'ok', details: ['1 of 1 episode ok'] }
  },
  {
    // #674: step 3 refreshes the cache to the new name and leaves
    // `recentAnimeMeta` on the old one. Step 4 searches every record's names
    // (`animeRecordsFrom`), so the folder under the name the title was watched
    // and downloaded under is found, and is the folder line, not skipped.
    id: 'S36',
    title:
      'no downloadedAnime record, watched online under the old name, renamed upstream; an online step 3 first',
    world: {
      titles: [
        {
          id: 136,
          recent: named('Old Name'),
          cache: named('Old Name'),
          remote: named('New Name'),
          watchedDaysAgo: 5,
          entries: [{ ep: '1', trId: 1361 }]
        }
      ]
    },
    actions: [{ do: 'metadata' }],
    oracles: ['O1', 'O2', 'O9'],
    expect: {
      status: 'warning',
      details: [
        '0 of 1 episode ok',
        'New Name episode 1: the file is in the "Old Name" folder, but the player looks in "New Name"'
      ]
    }
  },
  {
    // #676: the tick downloads under the subscription's `animeName`, which no
    // record holds once the page is opened after a rename. Step 4 tries it
    // after every record's names, so the file is the folder line, not skipped
    // (S37) or "missing" (S38).
    id: 'S37',
    title:
      'no downloadedAnime record, auto-downloaded under the subscription name, every record renamed since',
    world: {
      titles: [
        {
          id: 137,
          recent: named('New Name'),
          cache: named('New Name'),
          subscribed: 'Old Name',
          watchedDaysAgo: 5,
          entries: [{ ep: '1', trId: 1371, under: 'Old Name' }]
        }
      ]
    },
    oracles: ['O1', 'O2', 'O9'],
    expect: {
      status: 'warning',
      details: [
        '0 of 1 episode ok',
        'New Name episode 1: the file is in the "Old Name" folder, but the player looks in "New Name"'
      ]
    }
  },
  {
    id: 'S38',
    title:
      'recorded under the new name, episode 1 auto-downloaded under the subscription name before the rename',
    world: {
      titles: [
        {
          id: 138,
          downloaded: named('New Name'),
          recent: named('New Name'),
          cache: named('New Name'),
          subscribed: 'Old Name',
          entries: [
            { ep: '1', trId: 1381, under: 'Old Name' },
            { ep: '2', trId: 1382 }
          ]
        }
      ]
    },
    oracles: ['O1', 'O2', 'O9', 'O11'],
    expect: {
      status: 'warning',
      details: [
        '1 of 2 episodes ok',
        'New Name episode 1: the file is in the "Old Name" folder, but the player looks in "New Name"'
      ]
    }
  },
  {
    // #679: the only recorded row whose old name only a later record holds, so
    // step 4's every-record search (#674) and the restart's reconcile run on
    // the same world.
    id: 'S40',
    title:
      'recorded under the new name, episode 1 under the old name that only recentAnimeMeta still holds',
    world: {
      titles: [
        {
          id: 140,
          downloaded: named('New Name'),
          cache: named('New Name'),
          recent: named('Old Name'),
          entries: [
            { ep: '1', trId: 1401, under: 'Old Name' },
            { ep: '2', trId: 1402 }
          ]
        }
      ]
    },
    oracles: ['O1', 'O2', 'O11'],
    expect: {
      status: 'warning',
      details: [
        '1 of 2 episodes ok',
        'New Name episode 1: the file is in the "Old Name" folder, but the player looks in "New Name"'
      ]
    }
  },
  ...PAIRWISE
]
