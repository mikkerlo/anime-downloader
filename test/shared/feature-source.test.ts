// The feature-source resolver and the capability matrix (#706), shared by main
// and the renderer. Every feature against every combination of connected
// trackers, with and without a primary and an override.
import { describe, it, expect } from 'vitest'
import {
  CAPABILITY_MATRIX,
  FEATURE_CAPABILITY,
  FEATURE_KEYS,
  TRACKER_ORDER,
  isCapable,
  isFeatureKey,
  resolveFeatureSource,
  type CapabilityMatrix,
  type FeatureKey
} from '../../src/shared/trackers/feature-source'
import { createShikimoriProvider } from '../../src/main/trackers/shikimori.provider'
import { TRACKER_CAPABILITIES, type TrackerProvider } from '../../src/main/trackers/types'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const IDS: TrackerId[] = ['shikimori', 'anilist', 'mal']

/** none; each alone; each pair; all three. */
const COMBOS: TrackerId[][] = [
  [],
  ['shikimori'],
  ['anilist'],
  ['mal'],
  ['shikimori', 'anilist'],
  ['shikimori', 'mal'],
  ['anilist', 'mal'],
  ['shikimori', 'anilist', 'mal']
]

/** The issue's table, written out independently of the module. */
const TABLE: Record<FeatureKey, Record<TrackerId, boolean>> = {
  calendar: { shikimori: true, anilist: true, mal: false },
  chronology: { shikimori: true, anilist: true, mal: true },
  forYou: { shikimori: true, anilist: true, mal: true },
  details: { shikimori: true, anilist: true, mal: true },
  airing: { shikimori: true, anilist: true, mal: false }
}

/** The rule restated, as an oracle for the sweep. */
function oracle(
  feature: FeatureKey,
  connected: TrackerId[],
  primary: TrackerId | null,
  override: TrackerId | undefined
): TrackerId | null {
  const ok = (id: TrackerId | null | undefined): id is TrackerId =>
    !!id && connected.includes(id) && TABLE[feature][id]
  if (ok(override)) return override
  if (ok(primary)) return primary
  for (const id of ['shikimori', 'anilist', 'mal'] as const) if (ok(id)) return id
  return null
}

describe('the capability matrix', () => {
  it('is the table: MAL has no calendar and no airing', () => {
    for (const feature of FEATURE_KEYS) {
      expect(CAPABILITY_MATRIX[FEATURE_CAPABILITY[feature]], feature).toEqual(TABLE[feature])
    }
    expect(FEATURE_CAPABILITY).toEqual({
      calendar: 'getCalendar',
      chronology: 'getRelated',
      forYou: 'getRecommendations',
      details: 'getDetails',
      airing: 'getAiringInfo'
    })
  })

  it('has a getFriends row outside FeatureKey: Shikimori and AniList, not MAL', () => {
    expect(CAPABILITY_MATRIX.getFriends).toEqual({ shikimori: true, anilist: true, mal: false })
    expect(FEATURE_KEYS).not.toContain('friends')
    expect(isFeatureKey('getFriends')).toBe(false)
    expect(isFeatureKey('friends')).toBe(false)
    const state = { connected: IDS, primary: null, overrides: {} }
    // @ts-expect-error `getFriends` has no feature key.
    void (() => resolveFeatureSource('getFriends', state))
    // @ts-expect-error nor has Friends.
    void (() => resolveFeatureSource('friends', state))
  })

  it('agrees with every real provider: no declared capability the matrix lacks, and each declared one implemented', () => {
    // Shikimori is the only provider on main; #702 and #703 add theirs here.
    // Equality waits for T11b-d, T6 and T7, which add the remaining members.
    const providers: TrackerProvider<unknown, unknown>[] = [
      createShikimoriProvider({ store: new InMemoryStorage() as never }) as never
    ]
    for (const p of providers) {
      for (const cap of TRACKER_CAPABILITIES) {
        const declared = p.capabilities[cap]
        const member = typeof (p as unknown as Record<string, unknown>)[cap] === 'function'
        expect(declared, `${p.id}.${cap} declared vs implemented`).toBe(member)
        if (declared && cap in CAPABILITY_MATRIX) {
          expect(CAPABILITY_MATRIX[cap as keyof CapabilityMatrix][p.id], `${p.id}.${cap}`).toBe(
            true
          )
        }
      }
    }
  })

  it('isCapable reads the matrix', () => {
    expect(isCapable('airing', 'mal')).toBe(false)
    expect(isCapable('details', 'mal')).toBe(true)
    expect(isFeatureKey('details')).toBe(true)
    expect(isFeatureKey(7)).toBe(false)
  })
})

describe('resolveFeatureSource', () => {
  it('matches the rule for every feature, combination, primary and override', () => {
    let cases = 0
    for (const feature of FEATURE_KEYS) {
      for (const connected of COMBOS) {
        for (const primary of [null, ...IDS]) {
          for (const override of [undefined, ...IDS]) {
            const overrides = override ? { [feature]: override } : {}
            const got = resolveFeatureSource(feature, { connected, primary, overrides })
            expect(got, JSON.stringify({ feature, connected, primary, override })).toBe(
              oracle(feature, connected, primary, override)
            )
            cases++
          }
        }
      }
    }
    expect(cases).toBe(5 * 8 * 4 * 4)
  })

  it('the override wins when connected and capable', () => {
    expect(
      resolveFeatureSource('details', {
        connected: IDS,
        primary: 'shikimori',
        overrides: { details: 'mal' }
      })
    ).toBe('mal')
  })

  it('a disconnected or incapable override falls through to the primary, then the fixed order', () => {
    const disconnected = {
      connected: ['shikimori', 'anilist'] as TrackerId[],
      primary: 'anilist' as TrackerId
    }
    expect(
      resolveFeatureSource('details', { ...disconnected, overrides: { details: 'mal' } })
    ).toBe('anilist')
    expect(
      resolveFeatureSource('airing', {
        connected: IDS,
        primary: 'mal',
        overrides: { airing: 'mal' }
      })
    ).toBe('shikimori')
    expect(
      resolveFeatureSource('calendar', {
        connected: ['anilist', 'mal'],
        primary: 'mal',
        overrides: { calendar: 'mal' }
      })
    ).toBe('anilist')
  })

  it('airing and calendar never resolve to MAL; MAL-only resolves both to null', () => {
    for (const feature of ['airing', 'calendar'] as const) {
      for (const connected of COMBOS) {
        for (const primary of [null, ...IDS]) {
          const got = resolveFeatureSource(feature, {
            connected,
            primary,
            overrides: { [feature]: 'mal' }
          })
          expect(got).not.toBe('mal')
        }
      }
      expect(
        resolveFeatureSource(feature, { connected: ['mal'], primary: 'mal', overrides: {} })
      ).toBeNull()
    }
  })

  it('an expired session (user present, credentials null) still resolves to that tracker', () => {
    // "Connected" is the user; credentials aren't an input at all.
    expect(
      resolveFeatureSource('airing', {
        connected: ['shikimori', 'anilist'],
        primary: 'shikimori',
        overrides: {}
      })
    ).toBe('shikimori')
  })

  it('with no tracker every feature is null', () => {
    for (const feature of FEATURE_KEYS) {
      expect(resolveFeatureSource(feature, { connected: [], primary: null, overrides: {} })).toBe(
        null
      )
    }
  })

  it('without capabilities it resolves as with the exported matrix; a custom matrix overrides it', () => {
    for (const feature of FEATURE_KEYS) {
      for (const connected of COMBOS) {
        const state = { connected, primary: null, overrides: {} }
        expect(resolveFeatureSource(feature, state)).toBe(
          resolveFeatureSource(feature, { ...state, capabilities: CAPABILITY_MATRIX })
        )
      }
    }
    const malAiring: CapabilityMatrix = {
      ...CAPABILITY_MATRIX,
      getAiringInfo: { shikimori: false, anilist: false, mal: true }
    }
    expect(
      resolveFeatureSource('airing', {
        connected: IDS,
        primary: 'shikimori',
        overrides: {},
        capabilities: malAiring
      })
    ).toBe('mal')
  })

  it('walks the TrackerId order', () => {
    expect(TRACKER_ORDER).toEqual(['shikimori', 'anilist', 'mal'])
    expect(
      resolveFeatureSource('details', {
        connected: ['mal', 'anilist'],
        primary: null,
        overrides: {}
      })
    ).toBe('anilist')
  })
})
