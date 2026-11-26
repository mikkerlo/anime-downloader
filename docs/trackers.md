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
  token. The drain reads the owner once (`services/trackers/sync.ts:447`) and
  takes its session once (`services/trackers/sync.ts:458`), and keeps both for
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
reading `TRACKER_ERROR_POLICY` (`services/trackers/sync.ts:573-574`):

| Class | The drain | The queue entry | Also |
|---|---|---|---|
| `network` | aborts | kept | |
| `auth` | aborts | kept | on an `auth()` failure: stop the timer when the session is gone (Shikimori: `instanceof ShikiAuthError`, `services/trackers/sync.ts:479`); after an account switch, the failure belongs to the previous account and is ignored, and the drain re-kicks (`services/trackers/sync.ts:463-466`) |
| `rate-limit` | aborts | kept | |
| `server` | continues with the next item | kept; dropped once that item has seen 24 h of server errors | |
| `item` | continues with the next item | dropped immediately | |
| `config` | aborts | kept | sets the tracker's "Needs setup" state |

- For Shikimori this is the 6.x drain, decision for decision. `network`, `auth`
  (401/403) and `rate-limit` (429) abort (`services/trackers/sync.ts:578-593`).
  A 5xx keeps the item and moves on until `recordConsumedServerError`
  (`services/trackers/sync.ts:318-342`) reports that item's 24 h window has
  expired, and then drops it (`services/trackers/sync.ts:595-613`). Anything
  else drops (`services/trackers/sync.ts:615-617`). Shikimori never produces
  `config`.
- `item` is the only class that drops on the first error; `server` drops only
  after the 24 h window.
- **`lastSyncError` per class**, written only while the item's owner is still
  signed in: `auth` and `config` write the error's message, `rate-limit` writes
  `<Tracker> rate limit — will retry`, a kept `server` item writes `<Tracker>
  server error — will retry`, and `network` writes nothing.
- **The `auth()` failure path** (the token step,
  `services/trackers/sync.ts:459-481`). A failure there has no item, so whatever
  its class it aborts the run and leaves the queue untouched. In order:
  1. The account-switch check runs first, for every class: if the owner changed
     since the drain started, the error is dropped silently, with no
     `lastSyncError` and no timer change, and the drain re-kicks
     (`services/trackers/sync.ts:463-466`).
  2. Otherwise `lastSyncError` is set only for a failure that is not
     `network`-class (`services/trackers/sync.ts:469-472`).
  3. A `config`-class failure sets "Needs setup" (`services/trackers/sync.ts:474`),
     so MyAnimeList's `invalid_client` on refresh parks the queue instead of
     refreshing again on every tick.
  4. The timer stops only when the session is gone (the provider's
     `isSessionGone`, `services/trackers/sync.ts:479`). For Shikimori that is
     `instanceof ShikiAuthError`, which is narrower than the `auth` class: a
     plain `ShikiApiError(403)` from the refresh endpoint classifies as `auth`
     but leaves the timer running, as in 6.x.

### The classifiers

Each classifier lives beside its adapter, not in `errors.ts`: it needs
`isNetworkError` and its client's error class, and `lib/errors.ts` imports
`errors.ts`, so a classifier inside the leaf would close a cycle.

- **Shikimori** (`src/main/trackers/shikimori.errors.ts`) mirrors the 6.x
  drain's branches in their order, which the generic drain now applies through
  the class (`services/trackers/sync.ts:571-619`); the first matching row wins,
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

## The fan-out writer

`src/main/services/trackers/fan-out.ts` (#692, T2b) is the one writer of list
changes. Its factory is `createTrackerFanOut({ store, trackers })`, and every
change goes through `applyChange(malId, change, { target, cause })`, where the
change is a `{ kind: 'set', values, fields?, origin? }` or a mark-watched
`{ kind: 'mark-watched', episode }`. `cause` is `'user' | 'merge' | 'mirror' |
'reconcile'`, named so it can't be read as a queue entry's persisted `origin`.
`index.ts` builds it with one entry per tracker sync instance (Shikimori alone
today) and passes it to the routers as `AppDeps.trackers`.

`applyChange` resolves to an `ApplyOutcome`: `{ kind: 'primary', result }`
when the primary branch ran (`result` null when it wrote nothing), or
`{ kind: 'queued', entry }` when the change was only queued (`entry` null when
nothing differed). Each tracker's `result` is typed through `PrimaryResults`,
and `setPrimaryWriter` takes a writer of that type. A caller that replies to a
request builds the reply from the outcome. The Shikimori handlers reply with
the primary's rate, the synthetic rate `queueRate` builds for a queued copy,
and for an equal copy the requested values under the cached rate id
(update-rate; they match the projection, which a refresh can leave the cached
row behind) or null (mark-watched).

- **The primary** is the stored `trackerPrimary` if that tracker is connected,
  else the first connected tracker in `shikimori`, `anilist`, `mal` order, else
  null. Connected means `<provider>User` is set.
- **A user change to the primary** runs that tracker's own primary branch,
  unchanged. Shikimori's is `services/trackers/shikimori-primary.ts`: 6.x's
  `sendRate` / `queueRate` and the two handler bodies, moved verbatim, with the
  router's refresh and recommendations invalidation injected
  (`setPrimaryWriter`). It throws or returns null on a refusal, exactly as
  before; otherwise it returns its result, the rate the change was made against
  (the live rate when sent, the cached entry when queued) and the rate it wrote.
- **Mirrors fan out only after the primary wrote**, live or queued (parked
  included). On a throw or a null no mirror gets an entry and no mirror clock
  is stamped. The fan-out then reads each other connected tracker's mirror
  toggle (`trackerMirror[id]`, missing means on) in the same synchronous step
  as its append, after every await, and skips a title the provider's optional
  `hasTitle(malId)` says isn't there.
- **A mirror entry is built from the mirror's own projection**: its cached row
  with each live queued entry for the title laid over it in queue order, each
  entry's `intendedFields` only (a title that is only queued starts from the
  first entry's `before`). For a `set`, `fields` are the fields the user changed
  (where the post-change values differ from the primary's basis) that also
  differ from the projection, and `after` is the projection with those applied.
  A mirror with no row, cached or queued, takes the create rule: `before` is
  `NO_RATE_BEFORE` and `after` / `fields` are all four post-change values. A
  mark-watched runs `nextWatchedRate` on the mirror's projection; null sends
  nothing. Empty `fields` queue nothing. Every mirror entry carries
  `via: 'mirror'` and is queued, never sent live.
- **A user change to a non-primary tracker** (T8b's "Copy from primary") is
  diffed against that tracker's projection, queued only with `via: 'copy'`,
  never fans out, never prompts, and is skipped when nothing differs. A
  non-primary mark-watched has no caller and returns null.
- **`'mirror'` and `'reconcile'` changes** use the same builder with
  `via: 'mirror'` / `via: 'reconcile'`, restricted to `fields` when given; a
  `'mirror'` change keeps a carried `origin` (#716) and never writes
  `resolvedFields`. Neither fans out again, and the drain's settle never calls
  `applyChange`. A `'merge'` change is refused: the merge leg and the conflict
  resolution keep writing through `mergeQueues`, with no cache patch.
- **Clocks and the prompt.** A user change stamps each target tracker's clock
  (`rateClockKey`): the primary through its own branch, each mirror and copy
  with its entry's `before` / `after`. `maybeBroadcastCleanupPrompt` stays in
  the primary branch.
- **The enqueue cache patch.** Every entry `applyChange` queues goes through
  the instance's `enqueue(entry)`: the append, then `patchCachedRate` over the
  signed-in user's existing row (the cache `store.set`, `onRateUpdated`, the
  `rateUpdatedChannel` broadcast), then `offlineQueueChangedChannel`, in one
  synchronous step, with no recommendations invalidation and no prompt. No row,
  no patch. A drift-declined item self-corrects on settle through its
  `reconcileCacheFromRate`. The entry's `queuedAt` is the larger of now and
  every `queuedAt` in that queue plus one; the tracker's timer starts and its
  drain is kicked.

| `cause` | Written to | Clock | Prompt | Fans out |
|---|---|---|---|---|
| `'user'`, primary | the primary's own path, then each enabled mirror (`via: 'mirror'`) | each target's | primary only | after the primary wrote |
| `'user'`, not primary | that tracker's queue, `via: 'copy'` | that tracker's | never | never |
| `'mirror'` | that tracker's queue, `via: 'mirror'` | none | never | never |
| `'reconcile'` | that tracker's queue, `via: 'reconcile'` | none (T10's) | never | never |
| `'merge'` | refused: `mergeQueues`, as today | none | never | never |

### Consolidation and the drop match

- `consolidateQueue` builds one item per MAL id **and `via` value**, placed at
  its first entry: a `via` entry never consolidates with a non-`via` one, and
  `'mirror'`, `'reconcile'` and `'copy'` stay apart. Entries with the same `via`
  consolidate as before.
- On a via-free item, a later entry that changes a field's value without
  provenance for it clears that field's provenance (and `origin` once none is
  left). A user edit that writes the merge's own value keeps it.
- The settled event carries the item's `via`. The drain drops and stamps 5xx
  clocks on `(malId, queuedAt, via)` (`dropFromParked`, `recordServerError`,
  `recordServerErrorInParked` take the `via`), so two items that share a
  `queuedAt` across `via` values never consume each other's entries.
- A `via` item with nothing to change makes no `upsertEntry` call; every other
  item keeps the PATCH on a drift match.

### `discardQueue(trackerId)`

Called by T3c / T5b after the user confirms switching a mirror off. Under that
tracker's `withQueueLock`, in one synchronous step, it removes every live
`via: 'mirror'` entry (owner-leg entries, copies, reconcile winners and parked
buckets stay), rebases the later `via` survivors, reverts the dropped fields in
the cache locally (no refresh), broadcasts the queue and returns the count.
`mirrorQueueCount(trackerId)` counts those entries for T3c's warning.

The revert and the rebase are one pure helper, `revertAndRebase(slots, opts)`
in `lib/shikimori-queue.ts`, shared with Forget (#716 § 5 adds its cache step).
A slot is one queue entry through a strip: as queued, what is left of it, and
the fields taken. Per title with a cached row, for each stripped field `f`,
with `L` the last stripped entry that has `f`:

1. a survivor queued after `L` that has `f` leaves the field alone;
2. so does a cache that no longer shows `L.after[f]` (a refresh, a settle or a
   later write rewrote it);
3. otherwise the target is the `after[f]` of the last survivor queued before
   `L` that has `f`, else the earliest stripped entry's `before[f]`.

A survivor's fields are its `intendedFields`, so an unscoped survivor counts as
all four. Only fields that differ are written, with one codec patch per row
carrying the current row with only those fields replaced. The rebase sets, for
each stripped `f`, every surviving `via` entry queued after the earliest
stripped entry for `f` to `before[f]` = the `after[f]` of the nearest survivor
before it that has `f` (else that earliest stripped `before[f]`), and also
`after[f]` when it doesn't carry `f`. Non-`via` survivors are never rebased.

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
