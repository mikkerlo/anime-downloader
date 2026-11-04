// The offline scenario matrix (#659): each row is a "PC" (`WorldSpec`), what
// the user does on it, the oracles that must hold, and step 4's exact output.
// Titles and comments cite issue numbers and function names, never file:line,
// so a PR that moves `local-integrity.ts` doesn't have to edit this table.
// Made-up ids and names only.

import { named, type Action, type WorldSpec } from '../../helpers/offline-world'
import type { OracleId } from '../../helpers/offline-oracles'

export interface Scenario {
  id: string
  title: string
  world: WorldSpec
  actions?: Action[]
  oracles: OracleId[]
  /** Step 4's run, temp roots normalised. */
  expect?: { status: PrepareOfflineStatus; details: string[] }
}

const SHOW = named('Show')

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
  }
]
