// The pairwise sweep's self-test (#659): recomputes, from `FACTORS`, every
// pair of values a PC can have, and checks that the committed rows cover each
// one, that each row is needed, and that each row's world is what its values
// say. Builds no world.
import { describe, expect, it } from 'vitest'
import {
  AGREED_O9,
  allowed,
  FACTORS,
  FILE_FACTORS,
  hasFile,
  PAIRWISE,
  parseTable,
  ROWS,
  S32,
  TABLE,
  type Factor,
  type Row
} from './pairwise'
import { Q3, RECORD_LESS } from './sources'

const NAMES = Object.keys(FACTORS) as Factor[]

const pair = (f: Factor, a: string, g: Factor, b: string): string => `${f}=${a} + ${g}=${b}`

/** A pair with a file factor counts only where the file is on this PC. */
function counts(f: Factor, a: string, g: Factor, b: string): boolean {
  if (FILE_FACTORS.includes(f) && g === 'location') return hasFile(b)
  if (FILE_FACTORS.includes(g) && f === 'location') return hasFile(a)
  return true
}

function requiredPairs(): string[] {
  const out: string[] = []
  NAMES.forEach((f, i) => {
    for (const g of NAMES.slice(i + 1)) {
      for (const a of FACTORS[f]) {
        for (const b of FACTORS[g]) {
          if (allowed({ [f]: a, [g]: b }) && counts(f, a, g, b)) out.push(pair(f, a, g, b))
        }
      }
    }
  })
  return out
}

function pairsOf(row: Row): string[] {
  const out: string[] = []
  const file = hasFile(row.location)
  NAMES.forEach((f, i) => {
    for (const g of NAMES.slice(i + 1)) {
      if (!file && (FILE_FACTORS.includes(f) || FILE_FACTORS.includes(g))) continue
      out.push(pair(f, row[f], g, row[g]))
    }
  })
  return out
}

function uncovered(rows: Row[]): string[] {
  const covered = new Set(rows.flatMap(pairsOf))
  return requiredPairs().filter((p) => !covered.has(p))
}

describe('the pairwise sweep', () => {
  it('has a column per factor, in order, and only their levels', () => {
    const { header, rows } = parseTable(TABLE)
    expect(header).toEqual(['id', ...NAMES])
    const bad = rows.flatMap((r) =>
      NAMES.filter((f) => !(FACTORS[f] as readonly string[]).includes(r[f])).map(
        (f) => `${r.id}: ${f} ${r[f]}`
      )
    )
    expect(bad).toEqual([])
    expect(ROWS.map((r) => r.id)).toEqual(ROWS.map((_, i) => `P${String(i + 1).padStart(2, '0')}`))
  })

  it('holds only PCs that can exist: cold storage needs advanced mode', () => {
    expect(ROWS.filter((r) => !allowed(r)).map((r) => r.id)).toEqual([])
  })

  it('covers every pair of values', () => {
    expect(uncovered(ROWS)).toEqual([])
  })

  it('needs every row: each covers a pair no other row does', () => {
    const redundant = ROWS.filter((r) => uncovered(ROWS.filter((o) => o !== r)).length === 0)
    expect(redundant.map((r) => r.id)).toEqual([])
  })

  it("builds each row's world from its values", () => {
    // Read back from the world spec, independently of how `rowScenario` built it.
    const read = PAIRWISE.map((s) => {
      const n = s.id.slice(1)
      const [t] = s.world.titles
      const [e] = t.entries
      const name = (under: string | undefined): string =>
        ({ [`P${n} Show`]: 'first', [`П${n} Шоу`]: 'other', [`P${n} Old Name`]: 'old' })[
          under ?? ''
        ] ?? `? ${under}`
      const location =
        e.file === 'none'
          ? 'none'
          : e.where === 'cold'
            ? s.world.coldAway
              ? 'away'
              : 'cold'
            : 'hot'
      const row: Record<string, string> = {
        id: s.id,
        record: t.downloaded ? 'yes' : 'no',
        starred: t.library ? 'yes' : 'no',
        cache:
          t.cache === undefined
            ? 'absent'
            : t.cache === null
              ? 'null'
              : t.cache.romaji === `P${n} Show`
                ? 'same'
                : t.cache.romaji === `P${n} Renamed`
                  ? 'other'
                  : `? ${t.cache.romaji}`,
        recent: t.recent ? 'yes' : 'no',
        watched: (t.watchedDaysAgo ?? Infinity) <= 90 ? 'yes' : 'no',
        key: e.key ?? 'three',
        location,
        folder: name(e.under),
        file: e.file ?? 'healthy',
        tag: e.untagged ? 'untagged' : 'tagged',
        ext: e.ext ?? 'mp4',
        mode: s.world.mode ?? 'simple',
        ffmpeg: s.world.ffmpeg === false ? 'no' : 'yes',
        player: s.world.playerMode ?? 'system',
        offline: s.world.offline === false ? 'no' : 'yes'
      }
      return row
    })
    // A row with no file on this PC has no file state to read back.
    const expected = ROWS.map((r) => (r.location === 'none' ? { ...r, file: 'none' } : r))
    expect(read).toEqual(expected)
    // An online row runs step 3 first.
    expect(
      PAIRWISE.filter((s) => s.world.offline === false).every(
        (s) => s.actions?.[0]?.do === 'metadata'
      )
    ).toBe(true)
  })

  it('cites, for each O9 exemption, the acceptance that fits the row', () => {
    const misfit = Object.entries(AGREED_O9).flatMap(([id, source]) => {
      const r = ROWS.find((x) => x.id === id)
      if (!r) return [`${id}: no such row`]
      // The cache scope (`createCacheScope`): recorded, starred or watched in 90 days.
      const inScope = r.record === 'yes' || r.starred === 'yes' || r.watched === 'yes'
      if (source === RECORD_LESS) {
        return r.record === 'no' && !inScope ? [] : [`${id}: in the Library or the cache scope`]
      }
      if (source === Q3) {
        const fits = inScope && r.offline === 'yes' && ['null', 'absent'].includes(r.cache)
        return fits ? [] : [`${id}: not an in-scope, uncached title in an offline run`]
      }
      return [`${id}: ${source}`]
    })
    expect(misfit).toEqual([])
  })

  it('S32 runs O6 over every pairwise world, with the fixture library attached', () => {
    expect(S32.map((s) => s.id)).toEqual(PAIRWISE.map((p) => `S32/${p.id}`))
    for (const [i, s] of S32.entries()) {
      expect(s.world).toEqual({ ...PAIRWISE[i].world, library: {} })
      expect(s.oracles).toEqual(['O6'])
    }
  })
})
