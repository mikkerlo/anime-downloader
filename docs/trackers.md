# Trackers

The app keeps your list on a tracker. Shikimori is the only one today; epic
#688 adds AniList and MyAnimeList beside it. #689 (T0) defines the seam every
tracker plugs into, the error taxonomy, and the canonical vocabulary. #691
(T2a) routes the Shikimori sync service through it, as the first instance of the
generic tracker sync service ([below](#the-sync-service)), and Shikimori's
behaviour does not change (the 6.0.21 goldens in `docs/testing.md` hold it).

## The seam: `TrackerProvider`

`src/main/trackers/types.ts` defines `TrackerProvider<TSession, TNative, TRate =
unknown>`. `TSession` is the provider's session, `TNative` its list row, and
`TRate` its single-entry rate (what `getEntry` and `upsertEntry` return, as
`native`; code that only lists can leave it `unknown`).

- **`auth(): Promise<TSession>`** returns the provider's session. Shikimori's is
  `ShikimoriSession = { token, userId }`; AniList and MyAnimeList define theirs
  in #703 (T7) and #702 (T6). A refresh failure throws what the provider's
  refresh throws.
- **Every data member takes that session first:** `listEntries(session, opts?)`,
  `getEntry(session, ref)`, `upsertEntry(session, ref, values, changedFields)`,
  and the optional `deleteEntry(session, ref)`, which only reconcile's "remove"
  (#708, T10) uses. `upsertEntry` creates the entry when `ref.remoteId` is null
  and updates it otherwise. `changedFields` names what the user changed; a
  provider may still send every field, and Shikimori does (today's behaviour).
- **Members with no session:** `getUser(token)`, which is what produces the
  `userId` a session carries (sign-in), and `classifyError(err)`, which is pure.
- **Session pinning.** A caller takes one session from `auth()` and passes it to
  every data call of a run; the drain pins it for the whole run. An adapter
  never re-reads its credentials or its user inside a data member. That is what
  keeps an in-flight item on the old account after an account switch (#588): if
  a member re-read the store, a switch mid-drain would send A's item with B's
  token. The drain reads the owner once (`services/trackers/sync.ts:400`) and
  takes its session once (`services/trackers/sync.ts:411`), and keeps both for
  the run.
- **Capabilities** are optional members, and `TrackerCapabilities` says which a
  provider has: `getAiringInfo`, `getCalendar`, `getRelated`,
  `getRecommendations`, `getDetails`, `getFriends`, `getFriendsActivity`,
  `getFriendsRates`. Each is implemented, and its signature finished, by the
  slice that consumes it (T11a–d, T12).
  - **Reads that need the user's auth or list take the session first:**
    `getFriends`, `getFriendsActivity`, `getFriendsRates`.
  - **Public reads by id take no session:** `getRelated` (and AniList's
    `getRelatedBatch`), `getDetails`, `getCalendar`, `getRecommendations` (the
    caller reads the seeds from the source tracker's rate cache and passes their
    ids) and `getAiringInfo` (cache-first; its network read is public). A public
    read acts on no account, so there is nothing to pin. A capability that needs
    a list on a cold cache gets it from the tracker's sync instance, which holds
    the session.
- **`TrackerRef`** is `{ malId, remoteId }`: the MAL id and the tracker's own id
  for the user's entry (Shikimori's rate id), null when there is no entry yet.
- **`TrackerUser`** is `{ id: number, nickname: string, avatar: string | null }`,
  ambient in `src/shared/types/trackers.d.ts` with `TrackerId` and
  `TrackerErrorClass` (their only definitions, so the renderer can name them
  without an import). A tracker with no picture gives `avatar: null`, and the
  sidebar chip falls back to the nickname's initial. On a drive `owner.provider`
  is an open string, so `TrackerId` never validates drive data.

### `TrackerRateEntry`: the listed entry

`listEntries` returns `TrackerRateEntry<TNative>`, a read-side-only normalized
entry: `{ trackerId, malId, remoteId, values, updatedAt, anime: { title, poster,
kind, episodes, episodesAired, status }, smotretAnime, native }`.

- **`native` is the provider's own row, untouched.** The normalized fields are
  lossy, so whatever must be written back exactly is built from `native`.
  Shikimori's rate cache (`CachedRateEntry`, `lib/shikimori-rate-cache.ts`)
  needs the whole `shikiAnime` block and the row's `updated_at`; T2a's codec
  passes the `native` rows through `buildRateCacheEntries` so
  `shikimoriUserRates` keeps its bytes. The normalized block is never written
  into `shikimoriUserRates`.
- **`updatedAt` is in ms, and `null`** when the row has no timestamp or it
  doesn't parse. Never `NaN`.
- **`smotretAnime`** is the smotret catalog join (`lookupByMalIds`), as the rate
  refresh does it today; null for a title the catalog doesn't have.
- **Shikimori's `anime.title` is `russian || name`**, the app's display rule;
  `name` stays available as `native.anime.name`.

### The Shikimori adapter

`src/main/trackers/shikimori.provider.ts` (`createShikimoriProvider({ store,
lookupByMalIds? })`) wraps `src/main/shikimori.ts` and adds no behaviour. Every
member calls the same function with the same positional arguments as today's
call sites, taken from the session it is given, through the module namespace
(so a `vi.mock` of `src/main/shikimori` intercepts it). `auth()` reads
`shikimoriUser` first and then awaits `ensureFreshToken(store)`, the drain's
order, so `session.userId` is the account the token was refreshed for; a null
user throws `Not logged in to Shikimori` after the refresh.

## Error taxonomy

`classifyError` sorts every tracker error into one class:
`network | auth | config | rate-limit | server | item`.

`src/main/trackers/errors.ts` is a **leaf module**: the class list, the
`TrackerApiError` base class (tracker id, HTTP status, scrubbed body) that the
AniList and MyAnimeList clients throw, and the policy table below as data
(`TRACKER_ERROR_POLICY`). It imports nothing from `lib/` or from a provider.
`lib/errors.ts` imports `TrackerApiError` so `isNetworkError` excludes it as it
excludes `ShikiApiError`; otherwise `errorCode` walking `cause` could classify
an API error as a network error.

### What each class implies

The drain ([the sync service](#the-sync-service), #691) implements this table,
reading `TRACKER_ERROR_POLICY` (`services/trackers/sync.ts:523-524`):

| Class | The drain | The queue entry | Also |
|---|---|---|---|
| `network` | aborts | kept | |
| `auth` | aborts | kept | on an `auth()` failure: stop the timer when the session is gone (Shikimori: `instanceof ShikiAuthError`, `services/trackers/sync.ts:432`); after an account switch, the failure belongs to the previous account and is ignored, and the drain re-kicks (`services/trackers/sync.ts:416-419`) |
| `rate-limit` | aborts | kept | |
| `server` | continues with the next item | kept; dropped once that item has seen 24 h of server errors | |
| `item` | continues with the next item | dropped immediately | |
| `config` | aborts | kept | sets the tracker's "Needs setup" state |

- For Shikimori this is the 6.x drain, decision for decision. `network`, `auth`
  (401/403) and `rate-limit` (429) abort (`services/trackers/sync.ts:528-543`).
  A 5xx keeps the item and moves on until `recordConsumedServerError`
  (`services/trackers/sync.ts:298-314`) reports that item's 24 h window has
  expired, and then drops it (`services/trackers/sync.ts:545-563`). Anything
  else drops (`services/trackers/sync.ts:565-567`). Shikimori never produces
  `config`.
- `item` is the only class that drops on the first error; `server` drops only
  after the 24 h window.
- **`lastSyncError` per class**, written only while the item's owner is still
  signed in: `auth` and `config` write the error's message, `rate-limit` writes
  `<Tracker> rate limit — will retry`, a kept `server` item writes `<Tracker>
  server error — will retry`, and `network` writes nothing.
- **The `auth()` failure path** (the token step,
  `services/trackers/sync.ts:412-434`). A failure there has no item, so whatever
  its class it aborts the run and leaves the queue untouched. In order:
  1. The account-switch check runs first, for every class: if the owner changed
     since the drain started, the error is dropped silently, with no
     `lastSyncError` and no timer change, and the drain re-kicks
     (`services/trackers/sync.ts:416-419`).
  2. Otherwise `lastSyncError` is set only for a failure that is not
     `network`-class (`services/trackers/sync.ts:422-425`).
  3. A `config`-class failure sets "Needs setup" (`services/trackers/sync.ts:427`),
     so MyAnimeList's `invalid_client` on refresh parks the queue instead of
     refreshing again on every tick.
  4. The timer stops only when the session is gone (the provider's
     `isSessionGone`, `services/trackers/sync.ts:432`). For Shikimori that is
     `instanceof ShikiAuthError`, which is narrower than the `auth` class: a
     plain `ShikiApiError(403)` from the refresh endpoint classifies as `auth`
     but leaves the timer running, as in 6.x.

### The classifiers

Each classifier lives beside its adapter, not in `errors.ts`: it needs
`isNetworkError` and its client's error class, and `lib/errors.ts` imports
`errors.ts`, so a classifier inside the leaf would close a cycle.

- **Shikimori** (`src/main/trackers/shikimori.errors.ts`) mirrors the 6.x
  drain's branches in their order, which the generic drain now applies through
  the class (`services/trackers/sync.ts:521-569`); the first matching row wins,
  and it never returns `config`:
  1. `network`: `isNetworkError`, which is false for any `ShikiApiError`, even
     one whose `cause` carries a network code.
  2. `auth`: `instanceof ShikiAuthError`, **whatever its status**.
     `ensureFreshToken` re-throws the refresh's own status, and an
     `invalid_grant` expiry is a 400; the class is discriminated by call site,
     never by status. It only comes out of `auth()`, never the item loop.
  3. `auth`: any other `ShikiApiError` with status 401 or 403.
  4. `rate-limit`: 429.
  5. `server`: 5xx.
  6. `item`: everything else.
- **AniList** (`src/main/trackers/anilist/classify.ts`; #703, T7, extends it
  against captured fixtures). A 200 can still carry `errors`, so the body is
  always checked and `errors[0].status` decides when it is there.
  - `auth`: HTTP 401, or `errors[0].status` 401.
  - `rate-limit`: 403 (AniList answers 403 when the API is down, so every
    request fails; under `server` the drain would keep sending and drop the
    whole queue after 24 h) and 429.
  - `server`: 5xx. `item`: any other 4xx.
- **MyAnimeList** (`src/main/trackers/mal/classify.ts`; #702, T6, extends it):
  - `config`: 400 "Invalid client id", and `invalid_client` on refresh.
  - 403: a body containing "DoS detected" (Akamai throttling) is transient,
    `rate-limit`; any other 403 (`forbidden`, a missing or blocked client
    header, or a body it doesn't recognise) is `config`.
  - `auth`: 401 (`invalid_token`, after T6's refresh retry).
  - `server`: 5xx. `item`: any other 4xx.

## The sync service

`src/main/services/trackers/sync.ts` (#691, T2a) holds the offline queue, its
drain, the sync timer, the error policy above, parking and the rate cache, for
one tracker: `createTrackerSyncService(provider, keys, deps)`.

- **One instance per tracker whose provider has landed**, each with its own
  keys (a `trackers/keys.ts` map) and its own closure state: the timer, the
  drain single-flight, the queue lock, `lastSyncAt` / `lastSyncError`, the
  settled listeners and "Needs setup". Its lifetime isn't tied to sign-in
  (#694). Being connected is the filter for draining: a run starts only when
  the `credentials` and `user` keys are set (a blob's presence; the drain never
  reads the vault), so a signed-out instance never drains. A failure on one
  instance never reaches another's queue, status or timer.
- **Shikimori's instance** is built by `createShikimoriSyncService(deps)`
  (`services/shikimori-sync`), with `createShikimoriProvider` and
  `SHIKIMORI_KEYS`. The wrapper adds the Shikimori-only extras (the details
  prefetch, the calendar and friends-activity snapshots, the recommendations
  cache), and `ShikimoriSyncService` is unchanged: `syncShikimoriQueue` is the
  generic drain.
- **The provider** is a `TrackerSyncProvider` (`trackers/types.ts`): the seam
  plus its rate-cache codec (`rateCache`) and the token step's "the session is
  gone" predicate (`isSessionGone`).
- **The session is pinned.** Each run calls `provider.auth()` once, in the same
  synchronous step as the owner read, and passes that session first to every
  `getEntry` / `upsertEntry`. The per-item owner guard stops the run once the
  stored user is no longer that owner. A session whose `userId` isn't the owner
  is an owner change: the run ends with no data call, and re-kicks only when the
  stored owner has moved.
- **`changedFields`.** An update passes the fields where what it sends differs
  from the server's entry; a create passes every field the item means to
  change. Shikimori's adapter still sends all four, as in 6.x; AniList's will
  leave an untouched `POINT_100` score alone.
- **The codec writes the cache from `native`.** `fromEntries` builds the rows a
  refresh writes (Shikimori: `buildRateCacheEntries` over the `native` rows and
  their smotret join, so `shikimoriUserRates` keeps `CachedRateEntry` exactly),
  `malIdOf` matches a row for `keepQueued`, and `indexOf` plus `patch` lay a
  value over an existing row. The normalized `TrackerRateEntry` is never
  written.
- **`patchCachedRate(ownerId, malId, values, remoteId?)`** is the one cache
  patch: the drain's settle calls it, and so will #692's `applyChange` at
  enqueue. It returns early when `ownerId` isn't the signed-in user (#588) or no
  row matches; otherwise it runs the cache `store.set`, then `onRateUpdated`,
  then the `rateUpdatedChannel` broadcast. A settled rate passes its `remoteId`;
  an enqueue patch leaves the row's id alone. It invalidates no
  recommendations, and the queue broadcast is the caller's.
- **The emit order is a contract:** on both the create and the update branch
  the drain patches the cache before it drops the consumed entries, so a
  drained item broadcasts `rateUpdatedChannel` before
  `offlineQueueChangedChannel`. #697's pending overlay relies on it.
- **The hooks** (optional deps):
  - `onRateUpdated(trackerId, malId)`: once per row the patch writes, before
    the rate broadcast;
  - `onRatesRefreshed(trackerId)`: once when `refreshRates` wrote a result,
    after the cache write and before the `ratesRefreshedChannel` broadcast;
    never for a null result;
  - `onNeedsSetupChanged(trackerId)`: on each "Needs setup" transition, after
    the flag changed.

  Shikimori's wrapper wires `onRateUpdated` to `invalidateCalendarCache()` and
  `onRatesRefreshed` to `invalidateCalendarCache()` then
  `invalidateRecommendations()`, 6.x's order and counts. #709 and #706 consume
  the first two for AniList; #702 passes the third.
- **"Needs setup"** is in-memory, read through `needsSetup()`, and not part of
  `getSyncStatus()`, so Shikimori's status keeps its five fields. A `config`
  result sets it, at the item step or the token step. While it is set no drain
  runs: a timer tick or a `drainNow` returns before the token step and sends no
  request. Only `clearNeedsSetup()` clears it (#702 calls it on a client-config
  change and on a successful Test), and a clear kicks one drain. Shikimori
  never produces `config`.
- **Strings are templated by tracker:** `<Tracker> rate limit — will retry`,
  `<Tracker> server error — will retry` and the `[<id> sync]` log prefix, with
  the names from `TRACKER_LABELS` (Shikimori, AniList, MyAnimeList). A refresh
  with no stored user rejects with `Not logged in to <Tracker>`, which every
  provider's `auth()` throws (Shikimori's: see [the adapter](#the-shikimori-adapter)).
- **A refresh reads the user before the token refresh**, because it goes
  through `auth()`. A switch that lands during the refresh now returns null at
  the owner guard, where 6.x fetched the new account's list with the old token.

## Statuses and scores

**The canonical vocabulary is Shikimori's six statuses**: `RateValues.status`
(`ShikiUserRateStatus`, `lib/shikimori-rate.ts`) *is* it, and every tracker maps
to and from it (`src/main/trackers/scores.ts`):

| App | AniList | MyAnimeList |
|---|---|---|
| `planned` | `PLANNING` | `plan_to_watch` |
| `watching` | `CURRENT` | `watching` |
| `rewatching` | `REPEATING` | `watching` with `is_rewatching=true` |
| `completed` | `COMPLETED` | `completed` |
| `on_hold` | `PAUSED` | `on_hold` |
| `dropped` | `DROPPED` | `dropped` |

The drain's drift ranking, `STATUS_ORDER`, lives beside `RateValues` in
`lib/shikimori-rate.ts`.

**The app score is an integer 0–10.** AniList's `scoreRaw` is always the
100-point scale whatever the user's `scoreFormat` (`POINT_100`,
`POINT_10_DECIMAL`, `POINT_10`, `POINT_5`, `POINT_3`):

- the app writes `scoreRaw` as `appScore * 10`, and reads a raw score as the
  nearest app score, except that a positive raw never reads as 0 ("no score"):
  a `POINT_100` 1–4 reads as 1, and clearing it writes 0;
- **rounding is never a change**: `anilistScoreUnchanged(appScore, storedRaw,
  format)` is true when the stored raw still reads as that app score (a
  `POINT_100` 85 read as 9 and left at 9), or when writing the app score would
  land on the same value in the user's format (a `POINT_5` user at 4 stars and
  an app 7). A clear to 0, or a set from 0, is always a change, even where the
  format would round a stale low raw to 0. Otherwise the stored raw is kept
  (`anilistRawToStore`), so it is never part of `changedFields` and never a
  reconcile diff.

## Store keys, key maps and the credential vault

#690 (T1) adds the AniList and MyAnimeList store keys, every one at its
default, with no migration: conf merges the defaults under an existing
`config.json`, so the first start adds them and a downgrade to 6.x carries them
forward untouched. Shikimori's keys don't change. [Settings](settings.md) lists
each key with its type, default and owner.

- **Key maps.** `src/main/trackers/keys.ts` exports `SHIKIMORI_KEYS`,
  `ANILIST_KEYS` and `MYANIMELIST_KEYS`: credentials, user, session-expired
  flag, rate cache, queue, parked queues and details, plus AniList's id map and
  MAL's client config. #691 (T2a)'s `createTrackerSyncService(provider, keys,
  deps)` takes one of them. MAL's keys are `myanimelist*`, never `mal*`,
  because `malIdMap` already means "a cache keyed by MAL id".
- **Rate clocks.** `rateClockKey(tracker, userId, malId)`
  (`src/main/store/sync-meta.ts`) builds the `syncMeta.rates` key, and
  `stampRateClocks` takes it. Shikimori keeps `<userId>:<malId>`, so its stamps
  and its two readers (`projectRate` and the sync runner's pending overlay) see
  exactly the 6.x bytes; AniList and MAL use `<provider>:<userId>:<malId>`.
- **The credential vault** (`src/main/trackers/credential-vault.ts`) holds
  `anilistCredentials`, `myanimelistCredentials` and `myanimelistClientSecret`
  as `{ v: 1, enc, data }` blobs, encrypted with `safeStorage` or, with no
  keyring, in plain text with a warning. It is lazy, never touched for a
  Shikimori-only user, and a blob it can't decrypt reads as `locked` until the
  user signs in again or disconnects. [Storage](storage.md#tracker-credential-vault-690)
  has the full contract: the encrypt/commit split, the conditional write, the
  guarded write-back and the plain upgrade.
- **Guards.** `set-setting` refuses the vault keys, `myanimelistClientConfig`,
  `trackerPrimary`, `trackerMirror` and `trackerFeatureSource`, and
  `get-setting` refuses the vault keys, both by the key's first path segment.
  A Shared Library export never carries the vault keys or the client config
  (`FORBIDDEN_FIELDS`).
