// The `tracker:*` account, auth and logout channels (#695), the primary,
// mirror and feature-source setters (#696), the rate, sync-status and
// queue channels (#694, epic #688), the details read (#706), the calendar
// (#709) and the chronology (#710). Each handler validates its
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
import { isFeatureKey } from '@shared/trackers/feature-source'
import type { ApplyOutcome } from '../services/trackers/fan-out'
import { AniListUnmappedError } from '../trackers/anilist/errors'
import { storedAnilistMediaId } from '../trackers/anilist/id-map'
import { getClientConfig, setClientConfig } from '../trackers/client-config'
import { storedFeatureSource } from '../trackers/feature-source'
import { assertMayConnect } from '../trackers/flags'
import { isConnected } from '../trackers/primary'
import { createShikimoriCalendar } from '../services/shikimori-sync/calendar'
import { createShikimoriChronology } from '../services/shikimori-sync/chronology'
import { adapterKindOf, buildChronology } from '../trackers/chronology'
import { TRACKER_LABELS } from '../trackers/types'
import type { ShikiUserRateStatus } from '../shikimori'
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
  if (!isFeatureKey(value)) throw new Error(`Unknown feature: ${String(value)}`)
  return value
}

function mirrorOptionsArg(value: unknown): TrackerSetMirrorOptions {
  if (value === undefined || value === null) return {}
  const confirm = (value as { confirm?: unknown }).confirm
  if (confirm === undefined) return {}
  if (typeof confirm !== 'boolean') throw new Error(`Invalid confirm: ${String(confirm)}`)
  return { confirm }
}

export function register({
  store,
  credentialVault,
  trackerRates: rates,
  trackerLifecycle: lifecycle,
  trackerAuth: auth,
  trackerChoices: choices,
  newTrackerCardsEnabled,
  secondTrackerEnabled,
  malSetup,
  shikimoriSyncService,
  lookupByMalIds,
  offlineService,
  anilistCalendar,
  anilistRelated,
  malRelated
}: AppDeps): void {
  // `shikimori:get-calendar`'s body (#709): the same function, so the two
  // channels can't disagree while Shikimori is the `calendar` source.
  const getShikimoriCalendar = createShikimoriCalendar({
    store,
    sync: shikimoriSyncService,
    lookupByMalIds,
    isOffline: () => offlineService?.isOffline() ?? false
  })
  // `shikimori:get-related`'s body (#710), with the primary's statuses passed in.
  const getShikimoriRelated = createShikimoriChronology({ store, lookupByMalIds })

  const clientConfigView = (): TrackerClientConfig => ({
    ...getClientConfig(store),
    ...(malSetup ? { redirectUri: malSetup.redirectUri() } : {})
  })

  // The AniList and MyAnimeList cards are hidden in a packaged build until the
  // flag lifts (#703 § 8, #702), and main refuses their sign-in too: no bind
  // and no browser.
  const signInArg = (value: unknown): TrackerId => {
    const id = trackerIdArg(value)
    if (id !== 'shikimori' && !newTrackerCardsEnabled) {
      throw new Error(`${TRACKER_LABELS[id]} sign-in isn't available in this build yet`)
    }
    return id
  }

  // Accounts, auth and logout (#695). `docs/trackers.md` § Accounts and sign-in.
  ipcMain.handle(
    CHANNELS.TRACKER_LIST_ACCOUNTS,
    (): TrackerAccountsState => lifecycle.accountsState()
  )

  ipcMain.handle(
    CHANNELS.TRACKER_BEGIN_AUTH,
    (_event, trackerId: unknown): Promise<TrackerAuthResult> => {
      const id = signInArg(trackerId)
      // The second-tracker flag (#701), before the attempt: no bind, no
      // browser. The commit re-checks it (`trackers/lifecycle.ts`).
      assertMayConnect(secondTrackerEnabled, id, (t) => isConnected(store, t))
      return auth.begin(id)
    }
  )

  ipcMain.handle(
    CHANNELS.TRACKER_COMPLETE_AUTH,
    (_event, trackerId: unknown, urlOrToken: unknown): Promise<TrackerAuthResult> => {
      const id = signInArg(trackerId)
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
      const mal = malIdArg(malId)
      let read: Awaited<ReturnType<typeof rates.readRate>>
      try {
        read = await rates.readRate(id, mal)
      } catch (err) {
        // A title AniList doesn't have: no row, and no media id (T8b's "not on AniList").
        if (err instanceof AniListUnmappedError) return { values: null, stale: false }
        throw err
      }
      const t = rates.instance(id)
      if (!read || !t) return null
      // AniList's own media id, from a positive id-map entry only (#703 § 5).
      const mediaId = id === 'anilist' ? storedAnilistMediaId(store, mal) : null
      const extra = mediaId !== null ? { mediaId } : {}
      if (!read.stale)
        return { values: read.entry ? read.entry.values : null, stale: false, ...extra }
      return { values: read.row ? t.rateCache.read(read.row).values : null, stale: true, ...extra }
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

  // The airing calendar from the resolved `calendar` source (#709), read at
  // call time. MyAnimeList has no schedule, so with no source (no account, or
  // MAL only) it is the empty shape and no request is made.
  ipcMain.handle(
    CHANNELS.TRACKER_GET_CALENDAR,
    async (_event, force?: unknown): Promise<TrackerCalendarResult> => {
      const refetch = force === true
      const source = storedFeatureSource(store, 'calendar')
      if (source === 'shikimori') {
        return { trackerId: source, ...(await getShikimoriCalendar(refetch)) }
      }
      if (source === 'anilist' && anilistCalendar) {
        return { trackerId: source, ...(await anilistCalendar.get(refetch)) }
      }
      return { trackerId: null, data: [], fetchedAt: null, stale: false }
    }
  )

  // The chronology from the resolved `chronology` source (#710), read at call
  // time. Shikimori's branch is `shikimori:get-related`'s body; it is also the
  // public, token-less answer with no source and for a title AniList doesn't
  // map. Status chips come from the primary's normalized cache: none without one.
  ipcMain.handle(
    CHANNELS.TRACKER_GET_RELATED,
    async (_event, malId: unknown): Promise<ShikiRelatedEntry[]> => {
      const mal = malIdArg(malId)
      const source = storedFeatureSource(store, 'chronology')
      const statusByMalId = new Map<number, ShikiUserRateStatus>()
      for (const e of rates.primaryEntries()) statusByMalId.set(e.malId, e.values.status)
      if (source === 'anilist' && anilistRelated) {
        const graph = await anilistRelated.walk(mal)
        if (graph) {
          return buildChronology(graph, {
            lookupByMalIds,
            kindOf: adapterKindOf,
            statusByMalId,
            isOnList: anilistRelated.isOnList
          })
        }
      } else if (source === 'mal' && malRelated) {
        return buildChronology(await malRelated.walk(mal), {
          lookupByMalIds,
          kindOf: adapterKindOf,
          // A node MAL listed but the walk didn't fetch has no year of its own.
          yearOf: (node, smotret) => node.year ?? smotret?.year ?? null,
          statusByMalId
        })
      }
      return getShikimoriRelated(mal, statusByMalId)
    }
  )

  // A non-Shikimori tracker's cached details (#706): never the network. A miss
  // kicks that tracker's prefetch, whose write arrives as
  // `tracker:details-updated`. Shikimori's stay on `shikimori:get-anime-details`.
  ipcMain.handle(
    CHANNELS.TRACKER_GET_DETAILS,
    (_event, malId: unknown, trackerId?: unknown): TrackerDetails | null => {
      const mal = malIdArg(malId)
      const id =
        trackerId === undefined || trackerId === null
          ? storedFeatureSource(store, 'details')
          : trackerIdArg(trackerId)
      if (id === null || id === 'shikimori') return null
      const t = rates.instance(id)
      if (!t) return null
      const details = t.cachedDetails(mal)
      // A stale entry is still answered; its refetch arrives as `tracker:details-updated`.
      if (!details || t.detailsStale(mal)) t.requestDetails(mal)
      return details
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
