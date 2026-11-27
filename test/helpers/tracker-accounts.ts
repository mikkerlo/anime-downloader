// A `tracker:list-accounts` reply for renderer tests (#706): each named tracker
// connected, `active` with credentials and `expired` with the user only.

export type AccountSpec = Partial<Record<TrackerId, 'active' | 'expired'>>

const ORDER: TrackerId[] = ['shikimori', 'anilist', 'mal']

export function trackerAccounts(
  spec: AccountSpec = {},
  opts: { primary?: TrackerId | null; featureSources?: TrackerAccountsState['featureSources'] } = {}
): TrackerAccountsState {
  const accounts = ORDER.map((trackerId, i): TrackerAccount => {
    const state = spec[trackerId]
    const hasCredentials = state === 'active'
    return {
      trackerId,
      user: state ? { id: i + 1, nickname: `${trackerId}-user`, avatar: null } : null,
      hasCredentials,
      sessionExpired: state === 'expired',
      needsSetup: false,
      credentialState: hasCredentials ? 'ok' : 'none'
    }
  })
  return {
    accounts,
    primary: opts.primary !== undefined ? opts.primary : (ORDER.find((id) => spec[id]) ?? null),
    mirror: {},
    featureSources: opts.featureSources ?? {}
  }
}
