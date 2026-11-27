// The `tracker:*` account, auth and logout channels (#695), the primary,
// mirror and feature-source setters (#696), and the rate, sync-status and
// queue channels (#694, epic #688). Each handler validates its
// arguments, calls the shared function its `shikimori:*` alias calls too (in
// `services/trackers/rates.ts`, or `trackers/lifecycle.ts` for the accounts),
// and shapes the reply per `trackerId`. This router names none of the
// `EVENT_CHANNELS.TRACKER_*` symbols: the bridge emits them, configured from
// `index.ts`, which is where the emitter scan has to find them.

import { ipcMain } from 'electron'
import { CHANNELS } from '@shared/ipc/channels'
import type { RateValues } from '../lib/shikimori-rate'
import { STATUS_ORDER } from '../lib/shikimori-rate'
import { isTrackerId } from '../services/trackers/rates'
import { isTrackerFeature } from '../services/trackers/choices'
import type { ApplyOutcome } from '../services/trackers/fan-out'
import { getClientConfig, setClientConfig } from '../trackers/client-config'
import { TRACKER_LABELS } from '../trackers/types'
import type { AppDeps } from './index'

function trackerIdArg(value: unknown): TrackerId {
  if (!isTrackerId(value)) throw new Error(`Unknown tracker: ${String(value)}`)
  return value
}

function malIdArg(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid MAL id: ${String(value)}`)
  }
  return value
}

function isStatus(value: unknown): value is RateValues['status'] {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATUS_ORDER, value)
}

function countArg(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${String(value)}`)
  }
  return value
}

function rateValuesArg(value: unknown): RateValues {
  const v = (value ?? {}) as Record<string, unknown>
  if (!isStatus(v.status)) throw new Error(`Invalid status: ${String(v.status)}`)
  return {
    episodes: countArg(v.episodes, 'episodes'),
    status: v.status,
    score: countArg(v.score, 'score'),
    rewatches: countArg(v.rewatches, 'rewatches')
  }
}

// What the primary branch wrote or queued (null when it wrote nothing), or the
// entry a copy queued (null when it queued nothing).
function writtenValues(outcome: ApplyOutcome): RateValues | null {
  if (outcome.kind === 'primary') return outcome.after ?? null
  return outcome.entry ? { ...outcome.entry.after } : null
}

function malOnly(value: unknown): 'mal' {
  const id = trackerIdArg(value)
  if (id !== 'mal') throw new Error(`${TRACKER_LABELS[id]} has no client config`)
  return id
}

function clientConfigArg(value: unknown): TrackerClientConfigInput {
  const v = (value ?? {}) as Record<string, unknown>
  if (typeof v.clientId !== 'string' || v.clientId.trim() === '') {
    throw new Error('Invalid client ID')
  }
  if (v.secret !== undefined && v.secret !== null && typeof v.secret !== 'string') {
    throw new Error('Invalid client secret')
  }
  const input: TrackerClientConfigInput = { clientId: v.clientId.trim() }
  // An empty secret field means "no secret", as null does.
  if (v.secret !== undefined) input.secret = v.secret === '' ? null : (v.secret as string | null)
  return input
}

function logoutArg(value: unknown): TrackerLogoutOptions {
  if (value === undefined || value === null) return {}
  const pending = (value as { pending?: unknown }).pending
  if (pending === undefined) return {}
  if (pending !== 'keep' && pending !== 'discard') {
    throw new Error(`Invalid pending: ${String(pending)}`)
  }
  return { pending }
}

function featureArg(value: unknown): TrackerFeature {
  if (!isTrackerFeature(value)) throw new Error(`Unknown feature: ${String(value)}`)
  return value
}

function mirrorOptionsArg(value: unknown): TrackerSetMirrorOptions {
  if (value === undefined || value === null) return {}
  const confirm = (value as { confirm?: unknown }).confirm
  if (confirm === undefined) return {}
  if (typeof confirm !== 'boolean') throw new Error(`Invalid confirm: ${String(confirm)}`)
  return { confirm }
}

/** The trackers whose card `newTrackerCardsEnabled` hides (#702; #703 adds AniList). */
const FLAGGED_CARDS: ReadonlySet<TrackerId> = new Set<TrackerId>(['mal'])

export function register({
  store,
  credentialVault,
  trackerRates: rates,
  trackerLifecycle: lifecycle,
  trackerAuth: auth,
  trackerChoices: choices,
  newTrackerCardsEnabled,
  malSetup
}: AppDeps): void {
  const clientConfigView = (): TrackerClientConfig => ({
    ...getClientConfig(store),
    ...(malSetup ? { redirectUri: malSetup.redirectUri() } : {})
  })

  // Accounts, auth and logout (#695). `docs/trackers.md` § Accounts and sign-in.
  ipcMain.handle(
    CHANNELS.TRACKER_LIST_ACCOUNTS,
    (): TrackerAccountsState => lifecycle.accountsState()
  )

  ipcMain.handle(
    CHANNELS.TRACKER_BEGIN_AUTH,
    async (_event, trackerId: unknown): Promise<TrackerAuthResult> => {
      const id = trackerIdArg(trackerId)
      // The card is hidden in this build: no bind and no browser (#702).
      if (FLAGGED_CARDS.has(id) && !newTrackerCardsEnabled) {
        return {
          status: 'error',
          kind: 'config',
          message: `${TRACKER_LABELS[id]} sign-in isn't available in this build yet`
        }
      }
      return auth.begin(id)
    }
  )

  ipcMain.handle(
    CHANNELS.TRACKER_COMPLETE_AUTH,
    (_event, trackerId: unknown, urlOrToken: unknown): Promise<TrackerAuthResult> => {
      const id = trackerIdArg(trackerId)
      if (typeof urlOrToken !== 'string') throw new Error('Invalid sign-in input')
      return auth.complete(id, urlOrToken)
    }
  )

  ipcMain.handle(CHANNELS.TRACKER_CANCEL_AUTH, (_event, trackerId: unknown): void => {
    auth.cancel(trackerIdArg(trackerId))
  })

  ipcMain.handle(
    CHANNELS.TRACKER_LOGOUT,
    (_event, trackerId: unknown, opts?: unknown): TrackerLogoutResult =>
      lifecycle.logout(trackerIdArg(trackerId), logoutArg(opts))
  )

  // The primary, the mirror toggles and the feature sources (#696).
  // `docs/trackers.md` § Primary, mirrors and feature sources.
  ipcMain.handle(
    CHANNELS.TRACKER_SET_PRIMARY,
    (_event, trackerId: unknown): TrackerAccountsState =>
      choices.setPrimary(trackerIdArg(trackerId))
  )

  ipcMain.handle(
    CHANNELS.TRACKER_SET_MIRROR,
    (_event, trackerId: unknown, enabled: unknown, opts?: unknown) => {
      const id = trackerIdArg(trackerId)
      if (typeof enabled !== 'boolean') throw new Error(`Invalid enabled: ${String(enabled)}`)
      return choices.setMirror(id, enabled, mirrorOptionsArg(opts))
    }
  )

  ipcMain.handle(
    CHANNELS.TRACKER_SET_FEATURE_SOURCE,
    (_event, feature: unknown, trackerId: unknown): TrackerAccountsState =>
      choices.setFeatureSource(
        featureArg(feature),
        trackerId === null ? null : trackerIdArg(trackerId)
      )
  )

  ipcMain.handle(
    CHANNELS.TRACKER_GET_CLIENT_CONFIG,
    (_event, trackerId: unknown): TrackerClientConfig => {
      malOnly(trackerId)
      return clientConfigView()
    }
  )

  // The only writer of `myanimelistClientConfig` and `myanimelistClientSecret`:
  // the settings guard refuses both (#690). A saved config clears the
  // instance's "Needs setup" (#702), whose hook broadcasts the accounts state;
  // otherwise a saved client ID can still end MAL's missing-client-ID "Needs
  // setup", which this handler broadcasts itself (#696). One broadcast either way.
  ipcMain.handle(
    CHANNELS.TRACKER_SET_CLIENT_CONFIG,
    async (_event, trackerId: unknown, input: unknown): Promise<TrackerClientConfig> => {
      const id = malOnly(trackerId)
      const needsSetup = lifecycle.account(id).needsSetup
      await setClientConfig(store, credentialVault, clientConfigArg(input))
      const t = rates.instance(id)
      const instanceFlag = t?.needsSetup() ?? false
      t?.clearNeedsSetup()
      if (!instanceFlag && lifecycle.account(id).needsSetup !== needsSetup) {
        lifecycle.notifyAccountsChanged()
      }
      return clientConfigView()
    }
  )

  // The MAL card's Test of the saved client ID (#702). Success is a successful
  // request, so it clears "Needs setup"; a failure leaves it as it is.
  ipcMain.handle(
    CHANNELS.TRACKER_TEST_CLIENT_CONFIG,
    async (_event, trackerId: unknown): Promise<TrackerTestClientConfigResult> => {
      const id = malOnly(trackerId)
      if (!malSetup) throw new Error(`${TRACKER_LABELS[id]} setup isn't available`)
      const result = await malSetup.testClientConfig()
      if (result.ok) rates.instance(id)?.clearNeedsSetup()
      return result
    }
  )

  ipcMain.handle(
    CHANNELS.TRACKER_GET_RATE,
    async (_event, trackerId: unknown, malId: unknown): Promise<TrackerRateResult | null> => {
      const id = trackerIdArg(trackerId)
      const read = await rates.readRate(id, malIdArg(malId))
      const t = rates.instance(id)
      if (!read || !t) return null
      if (!read.stale) return { values: read.entry ? read.entry.values : null, stale: false }
      return { values: read.row ? t.rateCache.read(read.row).values : null, stale: true }
    }
  )

  ipcMain.handle(
    CHANNELS.TRACKER_GET_RATES,
    async (_event, trackerId: unknown, status: unknown): Promise<TrackerRatesSnapshot> => {
      const id = trackerIdArg(trackerId)
      if (status !== undefined && status !== null && !isStatus(status)) {
        throw new Error(`Invalid status: ${String(status)}`)
      }
      const rows = await rates.getRates(id, status ?? undefined)
      const t = rates.instance(id)
      if (!rows || !t) return { trackerId: id, entries: [], queuedAfter: {} }
      return {
        trackerId: id,
        entries: rows.map((row) => t.rateCache.entryOf(row)),
        queuedAfter: rates.queuedAfter(id),
        // The persisted rows, for the views that still read `shikiAnime.*` (#717 drops it).
        ...(id === 'shikimori' ? { raw: rows as ShikiAnimeRateEntry[] } : {})
      }
    }
  )

  ipcMain.handle(
    CHANNELS.TRACKER_UPDATE_RATE,
    async (
      _event,
      malId: unknown,
      change: unknown,
      opts?: { only?: unknown }
    ): Promise<TrackerRateValues> => {
      const id = malIdArg(malId)
      const values = rateValuesArg(change)
      const only =
        opts?.only === undefined || opts.only === null ? undefined : trackerIdArg(opts.only)
      const outcome = await rates.updateRate(
        id,
        values,
        rates.writeTarget(only),
        only === undefined
      )
      // A copy that queued nothing: `values` already match that tracker's projection.
      return writtenValues(outcome) ?? values
    }
  )

  // Fan-out: the primary, then every mirror that is on (#692). With no primary
  // it resolves null and calls no provider, like the alias signed out.
  ipcMain.handle(
    CHANNELS.TRACKER_MARK_EPISODE_WATCHED,
    async (_event, malId: unknown, epNum: unknown): Promise<TrackerRateValues | null> => {
      const id = malIdArg(malId)
      if (typeof epNum !== 'number' || !Number.isFinite(epNum)) {
        throw new Error(`Invalid episode: ${String(epNum)}`)
      }
      const outcome = await rates.markEpisodeWatched(id, epNum, rates.primary())
      return outcome ? writtenValues(outcome) : null
    }
  )

  ipcMain.handle(
    CHANNELS.TRACKER_GET_SYNC_STATUS,
    (_event, trackerId: unknown): TrackerSyncStatus => rates.getSyncStatus(trackerIdArg(trackerId))
  )

  ipcMain.handle(CHANNELS.TRACKER_GET_OFFLINE_QUEUE_LENGTH, (_event, trackerId: unknown) =>
    rates.getOfflineQueueLength(trackerIdArg(trackerId))
  )

  ipcMain.handle(CHANNELS.TRACKER_TRIGGER_SYNC, (_event, trackerId?: unknown) => {
    rates.triggerSync(
      trackerId === undefined || trackerId === null ? undefined : trackerIdArg(trackerId)
    )
  })

  ipcMain.handle(
    CHANNELS.TRACKER_GET_PARKED_QUEUES,
    (_event, trackerId: unknown): TrackerParkedQueueSummary[] => {
      const id = trackerIdArg(trackerId)
      return rates.getParkedQueues(id).map((bucket) => ({ trackerId: id, ...bucket }))
    }
  )

  ipcMain.handle(
    CHANNELS.TRACKER_DISCARD_PARKED_QUEUE,
    (_event, trackerId: unknown, ownerId: unknown) => {
      const id = trackerIdArg(trackerId)
      if (ownerId !== null && typeof ownerId !== 'string') {
        throw new Error(`Invalid owner: ${String(ownerId)}`)
      }
      rates.discardParkedQueue(id, ownerId)
    }
  )
}
