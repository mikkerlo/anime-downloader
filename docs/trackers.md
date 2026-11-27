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
- **`anime.poster` is an absolute URL, or null.** Shikimori's is the Home
  rail's pick (#698): `preview`, then `x96`, then `original`, with a relative
  path prefixed with `SHIKIMORI_ORIGIN`. AniList's and MAL's are absolute
  already, so continue-watching uses the poster as it is.

### The primary's entries: `primaryEntries()`

`trackerRates.primaryEntries()` (#698, `services/trackers/rates.ts`, passed to
the routers as `AppDeps.primaryEntries`) is what the Home rail
(`home:get-continue-watching`) and local search (`search:local`) read: the
primary's rate cache, each row through its codec's `entryOf`, with the cached
row itself as `native`. It writes nothing, and it is `[]` with no primary or
for a primary whose instance hasn't landed. For a Shikimori primary it reads
`shikimoriUserRates`, and both replies stay byte-identical to 6.x's, legacy
rows included (`test/ipc/t4b-golden.test.ts`).

- **Continue-watching keeps Shikimori's own `malId` pick.** For a
  `trackerId: 'shikimori'` entry its two `malIdMap` joins, the name lookup and
  the emitted `malId` read `native.rate.target_id`, which a row cached by an
  older version can lack. Every other tracker uses the entry's `malId`.
- **Local search uses the entry's `malId`**, which for Shikimori is
  `target_id ?? shikiAnime.id`, the fallback it applied itself before.
- **Missing clocks.** Continue-watching treats a `null` or `0` `updatedAt` as
  missing, as 6.x's truthiness checks did.

### The Shikimori adapter

`src/main/trackers/shikimori.provider.ts` (`createShikimoriProvider({ store,
lookupByMalIds?, refreshDetails? })`) wraps `src/main/shikimori.ts` and adds no
behaviour. Its one capability member, `getAiringInfo` (#706), is the
auto-downloader's cache-first details read, moved here unchanged. Every
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
  against the fixtures under `test/fixtures/anilist/`). A 200 can still carry
  `errors`, so the body is always checked and `errors[0].status` decides when
  it is there.
  - `network`: the fetch threw, timed out, or `OfflineError`.
  - `auth`: HTTP 401, any `errors[].status` 401, or an `Invalid token` message
    **whatever its status** (a revoked token answers HTTP 400 with
    `errors[0].status` 400, so a status-only read would drop every queued entry
    one at a time; the truncated-paste shape is unverified). Also `auth()`'s
    session-gone error and the limiter's dead-token rejection.
  - `rate-limit`: 403 (AniList answers 403 when the API is down, so every
    request fails; under `server` the drain would keep sending and drop the
    whole queue after 24 h) and a 429 after the limiter's retries.
  - `server`: 5xx. `item`: any other 4xx, a 404 on a write, and a successful
    id-map lookup that omitted the title. Two 404s aren't errors: `MediaList`'s
    (`getEntry` → null) and `DeleteMediaListEntry`'s (already gone).
  - AniList never produces `config`: the client ID is embedded, and the
    implicit grant has no client check at use time.
- **MyAnimeList** (`src/main/trackers/mal/classify.ts`; #702, T6, extended it):
  - `network`: as above, plus `MalSessionChangedError` (a login or logout
    landed while `auth()` read the vault: not the account's failure).
  - `auth`: `MalSessionGoneError` (the refresh's `invalid_grant`, nothing
    stored, or a locked blob), any body with `invalid_grant` (a reused code on
    the exchange is an attempt error, never "Session expired"), and 401
    (`invalid_token`, after the one refresh-and-retry).
  - `config`: `MalConfigError` (no client ID saved, a locked client secret),
    `invalid_client` on refresh, and 400 "Invalid client id".
  - 403: a body containing "DoS detected" (Akamai throttling) is transient,
    `rate-limit`; any other 403 (`forbidden`, a missing or blocked client
    header, or a body it doesn't recognise) is `config`.
  - `rate-limit`: 429 too (MAL sends no rate-limit headers; before #702 a 429
    fell through to `item` and dropped the entry).
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
  null. Connected means `<provider>User` is set. This is #696's read rule
  ([Primary, mirrors and feature sources](#primary-mirrors-and-feature-sources)),
  `resolvePrimary` in `trackers/primary.ts`; `index.ts` passes the fan-out
  `trackerLifecycle.primary()` as its `primary` getter.
- **A user change to the primary** runs that tracker's own primary branch,
  unchanged. Shikimori's is `services/trackers/shikimori-primary.ts`: 6.x's
  `sendRate` / `queueRate` and the two handler bodies, moved verbatim, with the
  router's refresh and recommendations invalidation injected
  (`setPrimaryWriter`). It throws or returns null on a refusal, exactly as
  before; otherwise it returns its result, the rate the change was made against
  (the live rate when sent, the cached entry when queued) and the rate it wrote.
  AniList's is `services/trackers/anilist-primary.ts` (#703), queue-first
  ([below](#the-primary-branch)). A primary with no writer throws `<Tracker>
  has no primary write path`.
- **Mirrors fan out only after the primary wrote**, live or queued (parked
  included). On a throw or a null no mirror gets an entry and no mirror clock
  is stamped. The fan-out then reads each other connected tracker's mirror
  toggle (`trackerMirror[id]`, missing means on) in the same synchronous step
  as its append, after every await, and skips a title the provider's optional
  `hasTitle(malId)` says isn't there. That read position is a contract #696's
  mirror-off relies on: a user change still waiting on the primary's request
  when the mirror is switched off appends nothing once it resumes. Reading the
  toggle before the primary's `await` would let it append after the discard.
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

Called by `tracker:set-mirror` (#696) after the user confirms switching a
mirror off. Under that tracker's `withQueueLock`, in one synchronous step, it
removes every live `via: 'mirror'` entry (owner-leg entries, copies, reconcile
winners and parked buckets stay), rebases the later `via` survivors, reverts
the dropped fields in the cache locally (no refresh), broadcasts the queue and
returns the count. `mirrorQueueCount(trackerId)` counts those entries for the
setter's "N changes won't be sent".

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

## The IPC surface

#694 (T3a) adds the tracker-generic rate, sync-status and queue channels
(`tracker:*`, each naming its `trackerId`); [IPC](./ipc.md) lists them. Their
handlers live in `src/main/ipc/trackers.ipc.ts`, and the work behind each one
is a shared function in `src/main/services/trackers/rates.ts`
(`createTrackerRates({ store, trackers, isOffline })`, `AppDeps.trackerRates`).

- **An instance's lifetime isn't tied to sign-in.** An instance exists for
  every tracker whose provider has landed, whatever its user and credentials
  hold. A signed-out or expired tracker answers through its instance's own
  checks: an expired session still queues `update-rate` and
  `mark-episode-watched`, serves `get-rate` from the cache and reports
  `sessionExpired: true`. "No instance" means only a provider that hasn't
  landed; every tracker has one since #703 (AniList) and #702 (MAL).
- **With no instance**, `get-rate` answers `null`, `get-rates` an empty
  snapshot, `trigger-sync` does nothing, and `update-rate` throws
  `Not logged in to <Tracker>`. `get-sync-status` returns a default idle status
  whose `queueLength` and `sessionExpired` come from the tracker's store keys,
  and `get-offline-queue-length` reads the same queue key, so the two agree.
- **Parked queues never go through an instance.** `get-parked-queues` and
  `discard-parked-queue` read and edit the tracker's parked-queue key, signed in
  or not: logout is what fills it. The generic summary keeps the bucket key as a
  string `ownerId` (`null` for the unknown-account bucket).
- **Writes.** `update-rate` calls `applyChange` with `cause: 'user'` on the
  primary, and the fan-out reaches the mirrors. With `only` it writes that one
  tracker with no fan-out (`applyChange`'s `mirrors: false`; a non-primary
  tracker takes the § 3a copy). It replies with the values written or queued.
  `mark-episode-watched` goes to the primary and resolves `null`, calling no
  provider, when no tracker is connected.
- **`get-rate`'s per-title fields.** The result is `{ values, stale, mediaId? }`,
  with `values` null when a connected tracker has no row for the title.
  `mediaId` is the tracker's own media id where it isn't the MAL id (T7 fills
  it for AniList). T8b (#705) adds `queued`, `unmapped` and `differs`. A
  queued-only change emits `tracker:offline-queue-changed` and no
  `tracker:rate-updated`, so the renderer refetches the result on both events.
- **The `shikimori:*` aliases** (get-rate, update-rate, mark-episode-watched,
  get-anime-rates, the queue length, the sync status, trigger-sync and the two
  parked-queue channels) call the same functions with `'shikimori'` and reply
  in 6.x's shape, signed out included: `shikimori:get-rate` still rejects with
  the not-connected error, and `shikimori:mark-episode-watched` resolves `null`.
  #717 (T14) removes them.

**The double-emit.** `src/main/trackers/events.ts`
(`createShikimoriEventBridge`) wraps the `broadcast` that `index.ts` hands to
every Shikimori emitter: the sync service, the sync-runner, the runner's
wholesale refresh (`services/sync-runner/rate-refresh.ts`) and
`AppDeps.broadcast`. For the four Shikimori rate, queue and status broadcasts
it sends the `shikimori:*` event with today's payload, then its `tracker:*`
twin with `trackerId: 'shikimori'`; every other channel passes through,
`shikimori:anime-details-updated` included. The legacy event goes first, so a
view still on `shikimori:*` sees 6.x's sequence. A twin's payload:

- `tracker:rate-updated` and `tracker:rates-refreshed` carry the normalized
  read-side entries (the codec's `entryOf`, `smotretAnime` included; never
  written to the cache) and `raw`, the persisted `CachedRateEntry` row or rows,
  the same objects the legacy event carries. `raw` is Shikimori's alone, for the
  views that read `shikiAnime.*` until T9, and goes away with the aliases.
- `tracker:offline-queue-changed` carries `{ trackerId, length, queuedAfter }`.
  `queuedAfter` is read from the live queue at emit time, never from the
  caller, so no emitter can send a stale overlay.
- `tracker:sync-status` carries the status with `needsSetup` from a getter on
  the Shikimori instance, which the legacy payload doesn't carry.

The `tracker:*` event channels are config on the bridge in `index.ts`, and
`trackers.ipc.ts` names none of them, so the emitter scan in
`test/ipc-channels.test.ts` finds them only there. The AniList instance (#703)
emits `tracker:*` only, through its own bridge (`createAniListEventBridge`,
`trackers/anilist/events.ts`), which shapes the generic service's raw
payloads into the same four `tracker:*` payloads, with no `raw`; the MAL
instance (T6) does too.

## Accounts and sign-in

#695 (T3b) adds the account channels (`tracker:list-accounts`,
`tracker:begin-auth`, `tracker:complete-auth`, `tracker:cancel-auth`,
`tracker:logout`, `tracker:get-client-config`, `tracker:set-client-config`;
[IPC](./ipc.md) has the payloads). Two modules sit behind them:
`src/main/trackers/lifecycle.ts` (`AppDeps.trackerLifecycle`), and the sign-in
attempts in `src/main/trackers/auth-session.ts` (`AppDeps.trackerAuth`).
`index.ts` builds both, and each calls the other only at call time.

**`authFlow` beside `auth`.** A provider's sign-in is its optional `authFlow`
member (`TrackerAuthFlow` in `trackers/types.ts`): what a paste is (`'url'`,
`'token'` or `'code'`), `needsSetup()` (MAL with no client ID), `begin()` (the
authorize URL and, for a `'url'` flow, the `state` and verifier), `loopback()`
(MAL's port and callback path) and `exchange(input, attempt)`, which runs the
code or token exchange and the user read and writes nothing. `auth` stays the
session getter every drain tick calls. Shikimori's `authFlow`
(`shikimoriAuthFlow` in `shikimori.provider.ts`) wraps `getAuthUrl`, then
`exchangeCode` and `getUser`, in `SHIKIMORI_EXCHANGE_CODE`'s order.

**The attempt state machine.** `idle → binding → waiting → exchanging →
connected | cancelled | error`, one attempt per tracker, in memory only: a
restart or a lost window loses it, and the user presses Connect again. No
pending-verifier key exists.

- `BEGIN` refuses while offline (`offline`, with no bind and no browser) and
  with nothing to set up from (`needs-setup`). A second `BEGIN` cancels the
  first, which resolves `cancelled`; that is also how a reloaded window's old
  `BEGIN` is released.
- **Bind, then open.** A loopback flow binds `127.0.0.1` and then `::1` on the
  same port before `shell.openExternal`: with PKCE `plain` the verifier is in
  the authorize URL, so whoever holds the port receives the code.
  `EADDRNOTAVAIL` or `EAFNOSUPPORT` on `::1` means the host has no IPv6
  loopback, and the flow continues on `127.0.0.1`. Any other bind failure
  (`EADDRINUSE` on either address included) is `port-busy`: the browser is
  never opened automatically, the `127.0.0.1` listener is closed, and the
  attempt stays held with `authorizeUrl` for T6's "Open anyway", Copy link and
  paste field. A failed `openExternal` is `open-failed`, also with the URL and
  the attempt held.
- **Completing.** The loopback callback and a `'url'` paste must carry the
  held `state` and a `code`; otherwise the callback gets a static refusal page,
  the paste an `error` / `auth` result, and the attempt keeps waiting. A
  callback or paste that arrives while the attempt is `exchanging` runs no
  second exchange: it resolves that one exchange's result, and the loopback
  answers with the static page.
- **After it connected.** Only a replay, the same code or token again while
  its credential is still stored, gets the connected result back with no
  exchange (a double submit, or a late paste of the URL the loopback took).
  Anything else drops the attempt and is a new sign-in: a different token is
  an account switch, and any paste after an expiry cleared the credential runs
  a fresh exchange. For MAL that means a URL from another attempt is refused
  as expired, like a paste with no attempt held.
- **No attempt held.** A `'token'` or `'code'` completion (AniList, Shikimori)
  registers an implicit attempt that starts in `exchanging`, so cancel, logout
  and a new `BEGIN` stop it like any other. A `'url'` completion (MAL) returns
  `error` / `auth` and writes nothing: the verifier went with the attempt.
- **Results.** An error from the exchange or the user read takes its `kind`
  from the provider's `classifyError` (`config` is the card's "Needs setup").
  `CANCEL` closes the loopback, drops the attempt and resolves the pending
  `BEGIN` `cancelled`.

**The account lifecycle.** `completeLogin(trackerId, load, { attempt })` and
`logout(trackerId, opts)` generalize 6.x's `SHIKIMORI_EXCHANGE_CODE` /
`SHIKIMORI_LOGOUT` with #588's rules, keyed by `TRACKER_KEYS[trackerId]`:

- **Login.** Nothing is written until `load` (the exchange and the user read)
  resolves and, for AniList and MAL, until `vault.encrypt(credentials)`
  resolves. Then one synchronous block runs, with no `await` in it: the head
  checks; the park and reset on a switch; the credential (`vault.commit` for
  AniList and MAL, a plain `store.set` for Shikimori), the user,
  `<provider>SessionExpired = false` and the generation bump; then the restore.
  The login never calls `vault.write`, whose store would land a step before
  the user.
- **The head of the block.** The stale-attempt check: the attempt's identity
  and `generation(trackerId)`, both captured before `completeLogin`'s first
  `await`, must be unchanged, or the login writes nothing, bumps nothing and
  resolves `cancelled`. That stops a sign-in the user cancelled, logged out of
  or restarted while it was exchanging, reading the user or encrypting. #701
  (T5b)'s second-tracker check goes beside it, and #696's second-connect
  primary write goes with the commit after both, so a refused login writes no
  primary. The `SHIKIMORI_EXCHANGE_CODE` alias passes no attempt and stays
  unguarded, as in 6.x.
- **A switch.** A different user is an account switch for every tracker: the
  live queue is parked under the previous owner (`parkEntries`), or under
  `UNKNOWN_OWNER` when there was no user, and the tracker's user-scoped state
  is reset. A same-user reconnect parks nothing and keeps the caches.
- **The restore.** `takeParked` for the new user, merged into the live queue
  (`mergeQueues`), the queue broadcast, a background rate refresh after a
  switch or a restore, then the timer, a drain and the status broadcast.
  Shikimori's router sets its own steps (`setSteps('shikimori', …)`: 6.x's
  `sync.*` calls, the prefetch abort and snapshots in the reset, and the Shared
  Library login run). Any other tracker uses its sync instance, looked up
  through `services/trackers` at call time; with no instance every step is
  skipped, never thrown. Steps that set no `afterLogin`, registered or not,
  get the lifecycle's `afterLogin` dep, which `index.ts` sets to the same
  Shared Library login run (#714), so an AniList or MAL login drops a claim
  and merges that account's libraries too, also once their routers register
  steps; a registered `afterLogin` (Shikimori's) wins.
- **Logout** cancels any attempt held for the tracker, parks the live queue
  under the user (`pending: 'keep'`, the default) or drops it (`'discard'`),
  clears the credentials (`vault.commit(key, null)` for AniList and MAL: no
  decrypt), the user, the live queue and the user-scoped state, sets
  `<provider>SessionExpired` to false, bumps the generation, stops the timer
  and broadcasts the queue and the status. A tracker never connected
  (credentials and user both null) is a no-op: no vault, no bump, but its held
  attempt is still cancelled. The `SHIKIMORI_LOGOUT` alias clears even then,
  as 6.x does. Logging out the primary also reassigns `trackerPrimary` in the
  same synchronous block that clears the user (#696, below), and
  `tracker:logout` resolves `{ needsPrimaryChoice? }`.
- **The session generation** is per tracker and in memory: bumped by every
  committed login and every logout that had something to clear, never by a
  refused or failed login, and never by another tracker's. #702 (T6)'s refresh
  captures `generation(trackerId)` when it starts and stores its tokens only if
  it is unchanged.
- **User-scoped state** (`USER_SCOPED_STATE`): Shikimori's `shikimoriUserRates`,
  `shikimoriAnimeDetails`, `shikimoriProfile`, `shikimoriFriends`,
  `shikimoriRecommendations`; AniList's `anilistUserRates`,
  `anilistAnimeDetails`; MAL's `myanimelistUserRates`,
  `myanimelistAnimeDetails`. T11b, T11d and T12 add theirs.
- **What survives a logout:** `anilistIdMap`, the rate clocks in
  `syncMeta.rates`, the parked queues, and MAL's client config and secret
  (they describe the user's MAL app registration, not the session).

**The accounts state.** One builder, `accountsState()`, answers
`tracker:list-accounts` and builds `tracker:accounts-changed` (#696). It reads
the store only: `hasCredentials` is whether the credential key is non-null,
`credentialState` is `'locked'` only when the vault's `isLocked(key)` says the
last read failed on the blob still stored (asked only when one is stored), and
`needsSetup` is MAL's missing client ID or the instance's `needsSetup()`. On a
Shikimori-only profile, listing, a Shikimori login and a logout never call the
vault.

**The MAL client config.** `tracker:get-client-config` and
`tracker:set-client-config` are the only reader and writer of
`myanimelistClientConfig` and `myanimelistClientSecret` for the renderer
(`setClientConfig`, [Storage](./storage.md)). The secret is never returned.

### The second-tracker flag

#701 (T5b) gates connecting a second tracker until #708 (T10) removes the
flag. `secondTrackerEnabled(isPackaged)` (`src/main/trackers/flags.ts`) is
true unpackaged and false packaged. `index.ts` computes it once and passes the
one value through `AppDeps.secondTrackerEnabled` and the lifecycle's deps, so a
test flips it by building deps. It is separate from the AniList and MyAnimeList
cards' flag (`newTrackerCardsEnabled`, #703), which lifts earlier; the card
flag must not lift before this one is in.

- **The rule.** While the flag is off, a sign-in for tracker X is refused when
  another tracker Y ≠ X has a user (an expired session counts). A reconnect of
  the same tracker isn't a second tracker, so Shikimori's "Sign in again"
  keeps working. One function, `assertMayConnect`, applies it everywhere; the
  reason is "Connecting a second tracker isn't available yet".
- **At begin.** `tracker:begin-auth` and `shikimori:get-auth-url` reject before
  any attempt starts: no browser opens and no port is bound.
- **At commit.** An attempt stays open after its `BEGIN` resolves, so a later
  paste or loopback callback could otherwise commit a second tracker (begin
  AniList; connect Shikimori; paste the AniList token). `completeLogin` checks
  again at the head of its synchronous block, after the user read and, for
  AniList and MAL, after `vault.encrypt` resolves, so a Shikimori commit that
  landed during the encrypt is seen. The check runs after the stale-attempt
  check and before the park, the credential commit and #696's second-connect
  primary write, so a refused login writes nothing: no credentials, no user,
  no `<provider>SessionExpired`, no park, no `trackerPrimary`. It rejects with
  `SecondTrackerRefusedError`; the attempt ends in `error` with `kind: 'auth'`,
  and `shikimori:exchange-code` rejects with the same message.
- **The renderer.** The accounts state carries the flag as
  `secondTrackerEnabled`. A card for a tracker that isn't connected hides its
  Connect action, and says why, while another tracker is connected and the
  flag is off (the Shikimori card too, for an AniList-only user).

## Primary, mirrors and feature sources

#696 (T3c) adds the three setters (`tracker:set-primary`, `tracker:set-mirror`,
`tracker:set-feature-source`), the primary's reassignment on a disconnect and
on a second connect, and `tracker:accounts-changed`; [IPC](./ipc.md) has the
payloads. The setters live in `src/main/services/trackers/choices.ts`
(`AppDeps.trackerChoices`); the reassignments and the broadcast live in
`trackers/lifecycle.ts`. `set-setting` refuses `trackerPrimary`,
`trackerMirror` and `trackerFeatureSource`, naming these channels, so a setter
is the only writer and its side effects always run.

**How the stored primary is read.** The stored `trackerPrimary` if that tracker
is connected (`<provider>User` set); otherwise the first connected tracker in
`TrackerId` order (`shikimori`, `anilist`, `mal`, the order #706's resolver
uses); `null` when none is connected. With one connected tracker this is #690's
"the only connected tracker" rule. It lives in one function, `resolvePrimary`
(`src/main/trackers/primary.ts`): `trackerLifecycle.primary()` and the
accounts state's `primary` answer with it, and `index.ts` hands the fan-out
`() => trackerLifecycle.primary()`, read at call time, so the writes and the
accounts state can't disagree. Connected never depends on a sync instance.

**The invariant: 2 or more connected means `trackerPrimary` is non-null.** The
two reassignments below maintain it, so with 2 or more trackers connected the
fallback order never picks the primary. A Shikimori-only profile never has 2
connected, so its login, switch and logout leave all three keys at their
defaults and its `config.json` doesn't change.

- **A disconnect of the primary** (the resolved one) writes the new
  `trackerPrimary` in the same synchronous block that clears its
  `<provider>User`, with no `await` between them, so a fan-out or a resolver
  tick never sees it naming a disconnected tracker. With 2 or more left it
  writes the first of them in `TrackerId` order at once and `tracker:logout`
  resolves `{ needsPrimaryChoice: { candidates } }` (every remaining connected
  tracker, in that order); #701 (T5b) asks which becomes primary, defaulting to
  that one, and dismissing the dialog keeps it. With exactly one left that one
  is written. With none left `trackerPrimary` goes back to `null`, written only
  if it isn't already. A disconnect of any other tracker leaves it alone.
- **A second connect keeps the existing primary.** When a login connects a
  tracker that had no user while another is connected and `trackerPrimary` is
  still `null`, the already-connected primary (the first connected in
  `TrackerId` order) is written, so an AniList-only user who connects
  Shikimori keeps AniList. The write sits with the credential commit, after the
  head checks (the stale-attempt check, and #701's second-tracker check beside
  it), so a refused or overtaken login writes no primary.

**`setPrimary(trackerId)`** rejects a tracker that isn't connected and accepts
one whose session expired or that needs setup: connected means the user is
set, and writes to it queue until it can drain. It writes `trackerPrimary` and
broadcasts. The current (resolved) primary again is a no-op: no write, no
broadcast. No queue moves: each tracker keeps its own, and every reader takes
the primary at call or tick time. The old primary becomes a mirror under its
stored toggle.

**`setMirror(trackerId, enabled, { confirm })`** rejects a tracker that isn't
connected, and the current primary in both directions, leaving its stored
toggle for when it stops being primary. A missing toggle reads as on. A call
that matches the stored toggle is a no-op (`{ applied: false }`: no write, no
broadcast and no `offerReconcile`).

- **Off without `confirm`** writes nothing and returns `pendingMirrorChanges`,
  that tracker's live `via: 'mirror'` count (`mirrorQueueCount`).
- **Off with `confirm`** writes `trackerMirror[id] = false` first, broadcasts,
  then runs `discardQueue(trackerId)`, which takes the tracker's
  `withQueueLock` itself, and returns `discarded`, the count it removed. The
  flag is written before the lock is even awaited, so a drain in flight
  finishes its item (sent, not discarded) and no new mirror entry can be
  appended once the flag is down: the fan-out reads the toggle in the step
  that appends, after the primary's `await`. `discarded` can be smaller or
  larger than the `pendingMirrorChanges` shown earlier: the drain can send some
  while the dialog is open, and the user's changes keep adding them until the
  confirm. #701 reports `discarded`. A discard that rejects is logged and
  returns `{ applied: true, discarded: 0 }`: the toggle is already off and
  broadcast, so an error would read as a revert that never happened, and the
  entries it didn't remove stay queued.
- **On** writes `trackerMirror[id] = true`, broadcasts and returns
  `offerReconcile: true` for #708 (T10)'s reconcile review.

**`setFeatureSource(feature, trackerId | null)`** takes a feature in
`calendar`, `chronology`, `forYou`, `details`, `airing` and a connected,
capable tracker, or `null` to clear the override. Capable reads the tracker
provider's `TrackerCapabilities`: `calendar` → `getCalendar`, `chronology` →
`getRelated`, `forYou` → `getRecommendations`, `details` → `getDetails`,
`airing` → `getAiringInfo`. Since #706 the check reads the static matrix in
`src/shared/trackers/feature-source.ts` (`isCapable`), the one the renderer's
dropdowns read, not each provider's `TrackerCapabilities`. It writes
`trackerFeatureSource` and broadcasts; the stored value again is a no-op. An
override naming a tracker that later disconnects is kept, and the resolver
skips it, so a reconnect restores it.

### Feature sources

#706 (T11a) resolves each feature's tracker. `src/shared/trackers/feature-source.ts`
holds one pure resolver and one static capability matrix, shared by main and
the renderer so the two can't disagree:

- **`resolveFeatureSource(feature, { connected, primary, overrides, capabilities? })`**,
  for a `FeatureKey` in `calendar | chronology | forYou | details | airing`
  (the ambient `TrackerFeature`), picks the override if it is connected and
  capable, else the primary if it is, else the first connected capable tracker
  in `TRACKER_ORDER` (`shikimori`, `anilist`, `mal`), else null. `capabilities`
  defaults to `CAPABILITY_MATRIX`; only `test/shared/feature-source.test.ts`
  passes another.
- **"Connected" means an account is present** (`<provider>User` set), never
  "credentials are present", so an expired session keeps its source rather
  than handing the feature to another tracker.
- **`CAPABILITY_MATRIX`**, keyed by capability:

  | Feature | Capability | Shikimori | AniList | MyAnimeList |
  |---|---|---|---|---|
  | `calendar` | `getCalendar` | ✅ | ✅ | ❌ |
  | `chronology` | `getRelated` | ✅ | ✅ | ✅ |
  | `forYou` | `getRecommendations` | ✅ | ✅ | ✅ |
  | `details` | `getDetails` | ✅ | ✅ | ✅ |
  | `airing` | `getAiringInfo` | ✅ | ✅ | ❌ |
  | *(no feature key)* | `getFriends` | ✅ | ✅ | ❌ |

  The `getFriends` row isn't a `FeatureKey`: the sidebar's Friends gate (T9)
  and the friends fan-out (T12) read it, and the resolver never does. A
  provider's `TrackerCapabilities` says which members it implements today; it
  never claims one the matrix lacks (the matrix test checks every real
  provider).
- **Main** calls it through `src/main/trackers/feature-source.ts`:
  `storedFeatureSource(store, feature)` reads `trackerFeatureSource`, the
  primary as `resolvePrimary` answers it and each `<provider>User`. **The
  renderer** calls it through `useTrackersStore().featureSource(feature)` over
  the accounts state. Neither passes `capabilities`.
- **With no tracker connected every feature is null.** A caller with an
  account-less path (Shikimori's public franchise endpoint for chronology)
  falls back to it, not to "hide the feature".

**The `airing` source and auto-download.** The auto-downloader's one `airing`
dep is `createAiringDep({ store, providers })`: `source()` (the resolved
`airing` source at call time), `hasCredentials(id)` (`<provider>Credentials`
stored; for Shikimori, the tick's gate before #706, unchanged) and
`getAiringInfo(id, malId)`, that provider's member or null. The tick runs only
while the resolved source has credentials, never "any tracker has": an active
AniList session doesn't open it while an expired Shikimori is the source.
MyAnimeList can't be the source, so a MyAnimeList-only user's tick returns at
the gate with the same empty result as a signed-out one.

**`getAiringInfo` is cache-first for every provider** (`AiringInfo`'s doc
comment in `src/main/trackers/types.ts`, the contract #703 meets). It answers
from the tracker's own cached data (its list cache, then its details cache)
when that is no older than `AIRING_FRESHNESS_MS` (6 h), and makes a network
call only when there is none that fresh. AniList answers an on-list title from
`anilistUserRates`, with no request. It returns `{ episodesAired, episodes }`,
`episodes` null meaning "no cap", or null when the tracker has no data for the
title (the tick's `no-episodes-aired`). A read that throws (AniList's client on a
429, a 5xx or a dropped network) is that subscription's `error` outcome: the
tick goes on to the next one, saves `lastCheckedAt` and broadcasts its result,
and `setSubscription` refuses (null). Shikimori's is the auto-downloader's
read before #706, moved into the adapter: the `shikimoriAnimeDetails` entry,
refreshed through `refreshDetails` (`refreshShikimoriDetailsForMalId`) when it
is missing or older than 6 h.

**The `'rates-refreshed'` trigger.** Shikimori keeps its call in
`ipc/shikimori.ipc.ts` (`afterBackgroundRefresh`), so a Shikimori refresh
ticks once. For AniList, `createTickIfAiringSource({ store, runTick })` returns
`tickIfAiringSource(id)`, which runs one `'rates-refreshed'` tick only while
`id` is the resolved `airing` source; the AniList construction in `index.ts`
passes it as its instance's `onRatesRefreshed` (T2a's hook), which
`createAniListSyncService` chains after stamping `ratesFetchedAt`. MyAnimeList's
doesn't get it.

**Details.** `tracker:get-details(malId, trackerId?)` reads AniList's or
MyAnimeList's details cache (`anilistAnimeDetails`, `myanimelistAnimeDetails`)
and never calls the network. Each provider keeps that cache in its own shape
and normalizes an entry to the ambient `TrackerDetails` in its
`cachedDetails(malId)` member: plain-text `description`, `genres`, `status` in
Shikimori's words (`anons` / `ongoing` / `released`, null when unknown),
`episodes`, `episodesAired` and `kind`. `trackerId` defaults to the `details`
source; for Shikimori it is null, since Shikimori's details stay on
`shikimori:get-anime-details`. A miss kicks that instance's `prefetchDetails`
(except offline), and the write arrives as `tracker:details-updated`. The
generic sync service carries both halves:

- `cachedDetails(malId)` (the provider's member) and `requestDetails(malId)`
  behind the handler;
- `broadcastDetails(malId, details)`: the `{ trackerId, malId, details }`
  broadcast on `detailsUpdatedChannel`, which a provider's details writer
  calls after its `store.set`. AniList's provider takes it as
  `onDetailsWritten`, called for each entry the prefetch or an on-list
  `getDetails` writes;
- the deps `detailsUpdatedChannel` and `prefetchDetails`, which the AniList
  construction in `index.ts` passes (`requestPrefetch(malId)`: nothing for a
  title off the list, which the list prefetch never fetches; the running
  prefetch if there is one, so a miss never restarts the one Prepare for
  offline awaits; else a new one). MyAnimeList's construction passes them
  when #702 wires its provider, and its `getDetails` write calls
  `broadcastDetails`. The Shikimori construction doesn't get the channel, so
  its details are never double-emitted.

**`tracker:accounts-changed`** carries the same `TrackerAccountsState` as
`tracker:list-accounts`, built by the same `accountsState()`, so a field added
to the builder (#701's `secondTrackerEnabled` and `primaryCapable`, #702 and #703's
`newTrackerCardsEnabled`) reaches both. Every emit goes through one seam,
`trackerLifecycle.notifyAccountsChanged()`; `index.ts` passes the lifecycle
`broadcast` and the channel. It fires once after:

- a committed login (a switch included) and every logout but the
  never-connected no-op, an automatic primary reassignment included;
- each applied setter;
- a Shikimori session expiry (credentials cleared, user kept), from the
  `setOnSessionExpired` hook beside `broadcastSyncStatus`;
- an AniList session expiry (a 401 cleared the token, user kept), from the
  provider's `onSessionExpired` (#703), and each AniList "Needs setup"
  transition, from its instance's `onNeedsSetupChanged`;
- a vault read that finds a blob it can't decrypt (`credentialState:
  'locked'`), from the vault's `onLocked`;
- a `tracker:set-client-config` that changes MAL's "Needs setup".

Shikimori's classifier never returns `config`, so its "Needs setup" never
changes. #703 (T7) passes `notifyAccountsChanged()` as AniList's instance's
`onNeedsSetupChanged` (AniList never produces `config` either, so it stays
quiet) and calls it from its expiry handling; #702 (T6) does the same for MAL.

## The renderer store

#697 (T4a) adds `useTrackersStore` (`src/renderer/src/stores/trackers.ts`),
the one place in the renderer that holds the `tracker:*` state. The one
component that calls the surface itself is the Settings → Trackers card
(below); [Renderer](./renderer.md) lists the store's state.
`useShikimoriStore` stays as a facade for the views not moved yet: it takes
rates, the queue length and the sync status from the `tracker:*` twins
filtered to `trackerId: 'shikimori'`, never also from the `shikimori:*`
events, so a double-emitted change is applied once. Home and Library read
`primaryRates` and load through `refreshRates(primary)` (#698; [Renderer](./renderer.md)
has the details).

- **Connected** means the account's `user` is set. An expired session keeps
  its user, so it stays connected and in `aggregateSyncState`. A changed
  `user.id` on a tracker that stays connected (an account switch) is a drop
  followed by a reload.
- **The queued overlay.** `rateFor(id, malId)` and `primaryRates` read the
  tracker's cache with its last queued `after` laid over it, as `projectRate`
  does in main. A title only in the queue reaches `rateFor` but isn't a row of
  `primaryRates`, since it has no `anime` block.
- **Loads.** `refreshRates(trackerId)` asks for the whole list (no `status`),
  applies the snapshot itself (a cold cache answers without broadcasting) and
  reuses a pending load. A drop moves the tracker's epoch, so a reply sent
  before it changes nothing; a queue event during the load keeps its
  `queuedAfter` over the snapshot's.
- **Held titles.** `holdTitle(malId)` keeps a `tracker:get-rate` result per
  connected tracker for that title, refetched for every connected tracker on
  a rate update for it, a queue change that adds, changes or removes its
  entry, any `tracker:rates-refreshed`, and a primary change.
- **Feature sources (#706).** `featureSource(feature)` is the shared resolver
  over the store's `connected`, `primary` and `featureSources`. `canAutoDl`
  is the account half of the detail page's Auto-download gate: the `airing`
  source resolves (so that tracker has a user). `detailsFor(trackerId, malId)`
  reads `detailsByTracker`, which the eager `tracker:details-updated`
  subscriber upserts per tracker. `defaultFeatureSource(feature)` is the same
  call with that feature's override left out, the "Default (‹tracker›)" label
  of Settings → Trackers (#701).
- **The multi-account controls (#701)** read `multiAccount`,
  `secondTrackerEnabled`, `primaryCapable` and `mirrorOn(id)`, and call
  `setPrimary`, `setMirror` and `setFeatureSource`, which go through #696's
  setters and leave the state to the broadcast. `openReconcile` is null until
  #708 sets it.
- **`accountsLoaded`** (#704) goes true in the same step that applies the
  first accounts payload (the init read, or a broadcast that beat it), or when
  that read fails, and never goes back. The detail page gates its rate panel
  on `anyAccount || !accountsLoaded`, so the flag, `accounts` and `primary`
  settle together and the panel never pops in late.

**The detail page's rate panel** (#704, `TrackerPanel.vue` with
`useTrackerRate`) edits the primary: it loads through `tracker:get-rate` once
`accountsLoaded` is true, saves through `tracker:update-rate` (the primary,
then the mirrors), follows `rateFor(primary, malId)`, and takes its offline
queue length, `sessionExpired` and sync state from the primary's entry. Its
`loading` is per mount, so from the second detail page on Continue still waits
for the primary's rate. A response is applied, and clears `loading`, only while
its tracker and MAL id are still current, so a late reply from the old primary
after a switch is dropped. `tracker:get-rate` answers the remote or cached row
without the queue on top, so the panel lays the primary's queued `after` over
the reply, as `projectRate` does: a switch or a mount with a change still queued
shows that change, and a Save can't write the remote value back over it. The
AniList "Open ↗" link needs the result's `mediaId` and is hidden without it.

**The sidebar, the player and Watch Together** (#699). The sidebar's footer
chip shows when `anyAccount`, with the primary account's nickname and avatar,
and reads `aggregateSyncState`. With one tracker it is the chip it always was;
with two or more it opens a per-tracker popover (`TRACKER_LABELS` names). The
player calls `tracker:mark-episode-watched` and reads no tracker state: main
decides who to mark, and with nothing connected the call resolves `null`. The
Watch Together nickname is the primary's, seeded only into an empty username:
the Settings tab reads the store, while the view and `useSyncplayClient` read
`tracker:list-accounts` once at connect. The cleanup prompt stays in each
tracker's primary branch, so its smotret title is the primary's own cache row
(Shikimori's today; AniList's and MAL's primary branches must pass theirs).

**Emit order is a contract.** A drain broadcasts the cache update
(`tracker:rate-updated`) before the queue change
(`tracker:offline-queue-changed`). The two are separate IPC messages, and the
overlay goes when the queue change lands, so the opposite order would let Vue
render the stale cache value in between. Shikimori's drain follows it; T6/T7's
drains (#702, #703) must too.

**A queue-only title reads `null` after its create settles.** The create
branch of a drain has no cache row to reconcile, so it emits no
`tracker:rate-updated`, only the queue change. `rateFor` goes from the queued
values to `null` and stays there until the next `tracker:rates-refreshed`
carries the row. Nothing in the drain triggers one; this is accepted for now.

## Settings → Trackers

#700 (T5a) moves the Shikimori account out of Settings → Connectors (which
keeps the Anime 365 token) into a Trackers tab right after it
(`TrackersTab.vue`), as a generic `TrackerAccountCard` keyed by `trackerId`.
#703 (T7) adds the AniList card (`AniListConnectForm.vue`) and #702 (T6) the
MyAnimeList card ([below](#the-mal-card)), in that order under Shikimori's,
both shown only while the accounts state's `newTrackerCardsEnabled` is true,
so a Shikimori-only user of a packaged build sees the one card. #701 (T5b)
adds the multi-account controls below.

- **States** come from `useTrackersStore` for the card's tracker: the
  account's `user` (Connected, or not connected), and from its
  `aggregateSyncState` row or the account, Session expired and Needs setup.
  The expired card's pending count is the row's `queueLength`.
- **Channels.** Logout (`{ pending }`) and the kept-changes rows use
  `tracker:logout`, `tracker:get-parked-queues` and
  `tracker:discard-parked-queue` with the card's `trackerId`; a bucket's
  `ownerId` is a string, so the card compares `String(user.id)`. The rows
  reload on `tracker:offline-queue-changed` for that tracker, the card's one
  subscription (Shikimori's legacy twin is never also subscribed).
- **The connect body** is the tracker's own component, passed to the card
  (`tracker-connect-form.ts`: the card's `complete(signIn)` reads the previous
  account before the sign-in, for the switch prompt). Shikimori's,
  `ShikimoriConnectForm.vue`, stays on `shikimori:get-auth-url` /
  `shikimori:exchange-code` for good: `tracker:begin-auth` refuses while
  offline, and the code paste must behave as in 6.x.
- **The facade's `user`.** Nothing derives `useShikimoriStore().user` from the
  accounts broadcast, so the Shikimori card calls `refreshUser()` after a
  connect, after every logout and on mount when it is unset.
- **Copy.** `TRACKER_LABELS` (`src/shared/trackers/labels.ts`) names a
  tracker in UI copy: the card and `TrackerPendingDialog` take the card's
  tracker, and the Work offline note and the cleanup prompt take the primary
  (`usePrimaryTrackerLabel`, Shikimori's while there is none). Main's
  `SESSION_EXPIRED_MESSAGE` and `NOT_CONNECTED_MESSAGE` point at
  Settings → Trackers.

### Multi-account controls

#701 (T5b) adds the controls for two or more connected accounts (an expired
one counts, as `anyAccount` does). With one account or none the tab is
exactly T5a's. None of them uses `autoSave`, since `set-setting` refuses
these keys: each calls a `useTrackersStore` action (`setPrimary`,
`setMirror`, `setFeatureSource`) that calls #696's setter, the store follows
the `tracker:accounts-changed` it emits, and the "Saved" toast flashes when
the setter resolves.

- **The primary.** Each connected card shows a "Primary tracker" radio and the
  primary a "Primary" badge. The radio is offered only for a tracker in the
  accounts state's `primaryCapable`: the trackers whose primary writer the
  fan-out has registered (`TrackerFanOut.hasPrimaryWriter`). `applyChange`
  throws for a primary with no writer, so a tracker without one is never
  offered. Today all three register one (Shikimori's router, `index.ts` for
  AniList, `createMalTracker` for MAL).
- **Disconnecting the primary.** When the logout resolves with
  `needsPrimaryChoice`, `TrackersTab` opens `TrackerPrimaryDialog` ("Which
  tracker becomes primary?") over the remaining trackers that can be primary,
  with the interim primary main already wrote (the first of them in
  `TrackerId` order) pre-selected. It has no Cancel: closing it, or Confirm on
  the interim, keeps that tracker and calls nothing; Confirm on another calls
  `tracker:set-primary`. A rejected logout, or one that left fewer than two
  candidates, opens nothing. A non-empty queue still asks through
  `TrackerPendingDialog` first.
- **The mirror toggle**, on every connected card but the primary's: "Mirror
  changes to this tracker", on unless `trackerMirror` says false. Switching it
  off asks for the count (`tracker:set-mirror(id, false)`) and opens
  `TrackerPendingDialog`'s `mirror-off` mode, even at 0: "Stop mirroring to
  ‹tracker›?", naming the changes mirrored from the primary, with Cancel and
  Stop mirroring. Cancel calls nothing more. Stop mirroring sends
  `{ confirm: true }`; main writes the flag off, then discards the mirror
  queue under the tracker's lock. The card then reports the result's
  `discarded` ("4 changes discarded", nothing at 0), never the dialog's count.
- **Switching it back on** returns `offerReconcile`. The card shows "Review
  differences with ‹primary›?" (Review, Not now) only while the store's
  `openReconcile` is set; #708 (T10) sets it, so until then the offer stays
  hidden rather than a dead button.
- **Feature sources**, a group below the cards: one row per feature key
  (Calendar, Chronology, For You, Details, Auto-download episode counts for
  `airing`), listing the connected trackers `isCapable` allows. One is plain
  text and none hides the row. Otherwise a select: "Default (‹tracker›)" first,
  which clears the override, labelled from the store's `defaultFeatureSource`
  (`resolveFeatureSource` with that feature's override left out), then each
  tracker. An override naming a disconnected tracker stays stored; the select
  shows Default.

## Boot, the online edge and Prepare

`src/main/services/trackers/edges.ts` (#693, T2c) decides which trackers take
part in the three places that used to know only Shikimori's queue. Connected
means the tracker's `<provider>User` key is set (`isTrackerConnected`).

- **Shikimori takes part signed in or not**, as in 6.0.21: its drain returns at
  its own guard when signed out. Every other tracker takes part only while
  connected (`edgeTrackers`). A Shikimori-only profile behaves exactly as
  before.
- **The list is read when each edge fires**, not when it is built, so a
  tracker connected later joins the next boot or online edge.
- **Boot** (`bootDrain`): each tracker with a non-empty queue starts its timer
  and kicks one drain. Each iteration has its own `try/catch`, so a
  synchronous throw from one tracker's `getQueueLength()` or
  `startSyncTimer()` logs `[trackers] <Name> boot drain failed:` and the next
  tracker still drains.
- **The online edge** (`kickoffTrackers`, `kickoffEntry`): one
  `KickoffTracker` per tracker, `{ drainLabel, drain, prefetchLabel,
  prefetch? }`. Each drain runs in its own `run()`, so a synchronous throw
  never skips the next tracker. An expired session or a 401 rejects inside the
  drain's promise and is contained by the drain's own guards either way. Every
  `prefetch` fires at the same `PREFETCH_STAGGER_MS` mark, 10 s after the
  edge, not one after another; an entry without one schedules no timer, and
  `onOffline` clears every pending one. Shikimori keeps its labels
  (`'Shikimori queue drain'`, `'details prefetch'`); every other tracker is
  `'<Name> queue drain'` / `'<Name> details prefetch'`. Shikimori's and
  AniList's entries have a prefetch: `kickoffTrackers` takes AniList's as
  `{ anilist: () => anilistProvider.prefetchDetails() }` (#703; list titles
  only, per the AniList terms of use). The generic instance has none, so MAL's
  entry has none.
- **Prepare for offline** is the exception to "read at the edge": steps are
  registered once at module load and `registerStep` rejects a duplicate id.
  So `registerTrackerRatesSteps` (`prepare-offline/wiring.ts`) registers one
  `createTrackerRatesStep` (`steps/tracker-rates.ts`) per known tracker but
  Shikimori, connected or not, right after `shikimori-rates`, and the step's
  `joinsRun()` (its tracker is connected when the run starts) is the only gate.
  The ids are `anilist-rates` / `mal-rates`, the labels `AniList rates` /
  `MyAnimeList rates`; `prefetch` and `abortPrefetch` are optional deps, and
  without them the step runs two phases (`total: 2`). AniList's step gets
  both from the wiring's `prefetch` map (#703), so it runs three phases;
  aborting the run aborts the prefetch, and its queued `prefetch`-class
  requests leave the limiter. A tracker that disconnects mid-run has already
  joined, and its step reports "Not logged in". `shikimori-rates` is unchanged
  and always joins.

The fan-out's `syncServices()` holds Shikimori's, AniList's (#703) and MAL's
(#702) instances, so `anilist-rates` and `mal-rates` register and their
queues take part in the boot drain and the online edge, each only while its
tracker is connected. A Shikimori-only profile never joins either.

## AniList

#703 (T7) adds AniList as a `TrackerProvider`, with its own sync instance and
queue, one host-wide rate limiter, the MAL → AniList id map, the capabilities
later slices consume, and a Settings card. The code is in
`src/main/trackers/anilist/`: `client.ts` (the GraphQL transport), `limiter.ts`
(the host limiter), `id-map.ts`, `provider.ts`, `queries.ts`, `classify.ts`,
`errors.ts`, `sync.ts` (the instance) and `events.ts` (its broadcast bridge).
The primary branch is `services/trackers/anilist-primary.ts`.

### Sign-in and the session

- **The implicit grant.** The client ID `57991` ("anime-dl") is a constant in
  `client.ts`; there is no secret. `tracker:begin-auth('anilist')` opens
  `https://anilist.co/api/v2/oauth/authorize?client_id=57991&response_type=token`,
  and AniList's pin page shows the token to copy. `tracker:complete-auth`
  takes the pasted token, trimmed, and checks it with `Viewer` before anything
  is stored.
- **What is stored.** `anilistCredentials` (vault) is `{ accessToken,
  expiresAt }`, with `expiresAt` the JWT's `exp` in ms, decoded from the
  payload segment and not verified (the token only ever goes back to AniList).
  A token whose payload doesn't decode is still accepted, with `expiresAt:
  null` and no expiry warning. `anilistUser` is the `TrackerUser` plus the
  `Viewer`'s `scoreFormat` and `displayAdultContent`, and `tokenExpiresAt`, the
  same `exp` in plain text: the accounts state reports it as the account's
  `sessionExpiresAt` without decrypting the vault.
- **A rejected token.** Any `Viewer` failure but `network`, `server` and
  `rate-limit` (a 403 while the API is down included) is "That token wasn't
  accepted", class `auth`; a transient failure keeps its class, so the user
  retries rather than re-pasting. Nothing is stored either way, and a rejected
  paste never reaches the session-expiry path.
- **The 1-year token** has no refresh and no scopes, so it is full account
  access. The card warns from `expiresAt − 14 days`: an amber "Expires ‹date›"
  chip, "Your AniList sign-in expires on ‹date›. Sign in again to keep
  syncing.", and Sign in again, which runs the same flow.
- **401 → Session expired, the token cleared.** A request whose token AniList
  refuses (HTTP 401, any `errors[].status` 401, or an `Invalid token` message)
  sets `anilistSessionExpired`, clears `anilistCredentials`, keeps
  `anilistUser` and the queue, and calls the provider's `onSessionExpired`
  (`index.ts`: the sync status, then `notifyAccountsChanged()`). The limiter
  rejects every queued request carrying that token unsent. The clear runs only
  when the refused token is still the stored one (a vault read and a blob
  compare), so a 401 for an account switched away from, or a refused paste,
  clears nothing.
- **The session** is `AniListSession = { token, userId }`. `auth()` reads
  `anilistUser` before its first `await` (the vault read), so `userId` is the
  owner the drain read at its presence check; a null user throws `Not logged
  in to AniList`, and an empty or locked credential throws the session-gone
  error (`isSessionGone`, class `auth`). Every data member takes the session
  first and never re-reads the credential or the user.
- **The card flag.** `newTrackerCardsEnabled(isPackaged)`
  (`src/main/trackers/flags.ts`) is true unpackaged and false packaged until
  #698 (T4b), #699 (T4c) and #704 (T8a) have landed. `index.ts` computes it
  once and passes it through `AppDeps` and the lifecycle; the accounts state
  carries it, the renderer shows the AniList card only while it is true, and
  `tracker:begin-auth` / `tracker:complete-auth` refuse AniList and MAL while
  it is false.

### The GraphQL client and the host limiter

- **Every request** is a POST of `{ query, variables }` to `anilistOrigin()`
  (`https://graphql.anilist.co`, or `ANIME_DL_ANILIST_ORIGIN` unpackaged)
  through `fetchWithTimeout`, so the offline refusal, the timeouts and the
  network observer apply. A user call carries `Authorization: Bearer`; the id
  map, airing, details, calendar, relations and recommendations reads send no
  token. Any `errors[]` entry fails the call, a 200 included, with an
  `AniListApiError` (a `TrackerApiError`, so `isNetworkError` excludes it)
  carrying the HTTP status, `errors[0].status` and the scrubbed, truncated body.
- **One limiter for the host** (`anilistLimiter` in `client.ts`): every call
  goes through it, whichever instance, capability or prefetch makes it. One
  request is in flight at a time, spaced at least `60 s / limit` apart, with
  the limit seeded at 30 a minute and re-seeded from `X-RateLimit-Limit`.
- **Priority classes**: `interactive` (user reads and writes, the drain,
  `Viewer`, the list refresh) > `reconcile` (T10's paging) > `prefetch`
  (details, id-map warmup). A lower-class request never runs while a higher
  one waits; within a class, FIFO. An id-map lookup takes its caller's class.
- **The window.** `X-RateLimit-Remaining: 0` holds the whole queue until
  `X-RateLimit-Reset`. A 429 is host-wide too: every class waits for
  `Retry-After`, else until `X-RateLimit-Reset`, else a 10 s backoff, and the
  rate-limited request goes back to the front of its class. After 3 retries
  the 429 is the answer (`rate-limit`). Every wait is clamped to 60 s, so a
  skewed clock can't park the queue for hours.
- **A 403 is not a 429**: it carries no rate-limit headers, so it is answered
  at once, with no retry and no pause, and classifies as `rate-limit`; the
  drain aborts and the next tick tries again.
- **Abortable.** A queued request whose signal aborts leaves the queue, so
  Prepare's Cancel and an abort of the details prefetch leave no work behind.

### The id map

- **MAL → AniList** through `Media.idMal`: `Page(page: 1, perPage: 50) {
  media(idMal_in: $ids, type: ANIME) { id idMal } }`, chunked by 50 (`perPage`
  is capped there), matched on `idMal` because results come out of order and
  unknown ids are omitted.
- **Duplicate `idMal`.** Nothing makes `idMal` unique. Of two media for one MAL
  id the map keeps the one on the user's list, otherwise the lowest `id`; the
  list read applies the same rule to two entries with different `mediaId`s.
- **`anilistIdMap`** is `{ [malId]: { anilistId, at } }`. Only a successful
  lookup that omits an id records a negative entry (`anilistId: null`), which
  expires after 7 days; a lookup that fails records nothing, and the drain
  applies that failure's class. Every list read seeds it, and it survives a
  logout.
- **Never filtered by `isAdult`**: no document carries it, so adult titles on a
  Shikimori list map. `displayAdultContent` applies only to For You, Calendar
  and activity, client-side.
- **"Not on AniList"**: `hasTitle(malId)` is false for a fresh negative entry,
  so the fan-out queues no mirror for it; `getEntry` throws an `item`-class
  error for it (the drain drops the item), and `tracker:get-rate` answers
  `{ values: null, stale: false }` with no `mediaId`. A cold map offline queues
  by MAL id, and the drain resolves it at `interactive`.

### The list

- **Read**: `MediaListCollection(userId, type: ANIME, forceSingleCompletedList:
  true, perChunk: 500, chunk)`, following `hasNextChunk`, scores as
  `score(format: POINT_100)`. Custom lists are skipped and entries deduped by
  `mediaId`. An entry with no `idMal`, and the higher media id of two sharing
  one, are left out and counted in the refresh log line (`[anilist] list
  refresh: …`).
- **Known gap of the MAL-keyed model: entries with no `idMal`** (AniList-only
  titles) never reach the normalized list, so an AniList-only user doesn't see
  them in the Home rail, the Library tabs or the list view. An AniList-native
  key would change every store key #690 defines; it is a follow-up.
- **Normalized**: `malId` = `media.idMal`, `remoteId` = the list-entry `id`,
  `updatedAt` = `updatedAt × 1000`; `anime.title` is English, else romaji;
  `poster` is `coverImage.large`, an absolute URL; `kind` the `format`;
  `episodesAired` as `getAiringInfo` counts it. `native` is the `MediaList`
  row, untouched, and the cache row is `{ entry: native, smotretAnime }`.
- **`getEntry`** reads `MediaList(userId, mediaId) { id status
  score(format: POINT_100) progress repeat updatedAt }`; its "not found"
  (`errors[].status` 404) is null, the drain's create branch. An `auth`-class
  refusal (the revoke's 400, a 401, the dead-token rejection) is rethrown as the
  session-gone error with the refusal as its `cause` (#740), so the read that
  finds the token refused answers as every later one does once the credential
  is cleared: `tracker:get-rate` from the cache, stale, and the primary
  branch's cold-cache read with the create rule, queued. It doesn't wait for
  the clear (`onTokenRejected` runs it on its own), and `isSessionGone` and
  the sync service's `isQueueableError` are unchanged. The drain still aborts
  on it as `auth`, but its `lastSyncError` is now the session-expired message
  ("AniList session expired — sign in again in Settings → Trackers"), no
  longer `AniList API error: 400 — Invalid token`; the raw refusal still
  reaches the drain's `console.warn` as the error's `cause`.
- **`upsertEntry`** sends `SaveMediaListEntry(mediaId, …)` with only the
  changed fields: `status`, `progress` for `episodes`, `scoreRaw = appScore ×
  10` for `score` (never `score`), and `repeat` for `rewatches`. With nothing
  changed it writes nothing and reads the entry back. It returns the entry with
  `getEntry`'s selection, which the drain adopts: the stored POINT_100 score
  and the list-entry `id` (the `remoteId` T10's `deleteEntry` needs).
- **`deleteEntry`** sends `DeleteMediaListEntry(id)` with the list-entry id; a
  404 means already gone and counts as success.
- **The rewatch count** is translated on every read and write, so the cache,
  the mirrors and T10 all see the app's count-at-start (`nextWatchedRate`).
  `ANILIST_REPEAT_SHIFT` is the shift on a `REPEATING` entry: 0 (the identity)
  until the verify task below decides it. Under a shift of 1, a status write
  into or out of `rewatching` also sends `repeat`.

### Statuses, scores and lossy scales

The status table is [below](#statuses-and-scores). Every read is POINT_100 and
the user's `scoreFormat` only gives the scale's precision, so an untouched
POINT_100 85 (app 9) is never part of `changedFields` and is never rewritten
by an episode bump. **On a lossy scale** (`POINT_5`, `POINT_3`) a written
`scoreRaw: 70` is stored at the scale's step (80, 85) and reads back as a
different app score (8, 9). The cache adopts what the server returns, so the
app's 7 becomes the read-back value and a second drain sends nothing. T10 must
treat that read-back as no diff. The cache codec keeps a stored raw while it
still reads as the app score, else stores the app score on the format's step.

### The primary branch

`createAniListPrimary` is AniList's writer for `applyChange` (#692),
registered as the AniList fan-out entry's `writePrimary`. It is queue-first:
every user change to an AniList primary is queued through the instance's
`enqueue` (the append, the cache patch and the broadcasts in one step) and the
drain sends it, where Shikimori's branch sends live. AniList allows 30 requests
a minute, and a live send would spend two on every edit (the `MediaList` read
and the write); the drain sends only the changed fields through the limiter.
The entry is field-scoped (`fields`, no `via`): the fields that differ from
AniList's projection. So the drain's drift check keeps a progress the server
has moved past, and a mark-watched never lowers it. With no row, cached or
queued, the branch reads the live entry once (a cold cache can't tell a title
off the list from a list not loaded yet, and a create-rule entry against a
row the server has would drain as drift and send nothing); with no live entry
either, or offline, it takes the create rule, all four fields. A switch
during that read parks the change for the account it was made on. It stamps
`anilist:<userId>:<malId>`, calls `maybeBroadcastCleanupPrompt` with the
AniList row's own `smotretAnime`, and returns its `basis` and `after` (the
values are its `result`), which feed the mirrors as Shikimori's do. A set for
a title not on AniList throws; a mark-watched for one is null.

### Capabilities

- **`getAiringInfo(malId)`** (T11a's `airing`) is cache-first: an on-list
  title answers from `anilistUserRates` while the list cache is younger than
  6 h, an `anilistAnimeDetails` entry younger than 6 h answers next, and only
  then one `Page.media(idMal_in)` read at `interactive`. The cache's age is
  `ratesFetchedAt`, in memory on the provider, stamped when `refreshRates`
  writes the list (the instance's `onRatesRefreshed`, before any caller's), 0
  at boot. Aired is `nextAiringEpisode − 1`, else a `FINISHED` title's total,
  else 0; `episodes` can be null. An off-list answer is kept in memory only.
- **`getDetails` and the prefetch.** `prefetchDetails` fetches the list
  titles' description and genres in batches of 50 at `prefetch`, never beyond
  the list (ToU clauses 2 and 3), returns early offline, and is abortable
  (`abortPrefetch`). It is the AniList entry's `prefetch` on the online edge
  and the third phase of the `anilist-rates` step, and a logout or a switch
  aborts it. A `tracker:get-details` miss goes through `requestPrefetch`,
  which joins a running prefetch rather than restarting it. Each entry it
  writes, and an on-list `getDetails` write, is broadcast as
  `tracker:details-updated` through `onDetailsWritten` (#706);
  `cachedDetails(malId)` maps an entry's AniList status (`FINISHED` →
  `released`, `RELEASING` / `HIATUS` → `ongoing`, `NOT_YET_RELEASED` →
  `anons`, `CANCELLED` → unknown) and strips the description's markup.
- **`getCalendar`**: `Page.media(id_in)` with `nextAiringEpisode`, chunked by
  50, matched on `id`, adult titles filtered by `displayAdultContent`.
- **`getRelated(ref)`** returns `Media.relations` edges with MANGA dropped,
  raw-typed; **`getRelatedBatch(anilistIds, { priority })`** (T11c's walk) the
  same per media, matched on `id`, a node with no `idMal` kept.
- **`getRecommendations(seedMalIds)`**: `Media.recommendations` per mapped
  seed, adult ones filtered by `displayAdultContent`.
- **`getFriendsRates(session, malId)`**: `Page.mediaList(mediaId,
  isFollowing: true)` with the AniList id. **`getFriendsActivity(session)`**:
  `Page.activities(isFollowing: true, type_in: [ANIME_LIST])`, adult media
  filtered. `getFriends` (`Page.following`) is T12's.

### Terms of use

The background details prefetch never goes beyond the user's own list. Copy
says "Connect AniList" / "Open AniList", never "AniList" in the app's own
name. The token is in the vault and in `FORBIDDEN_FIELDS`, and never reaches a
log line: an error carries only the scrubbed response body.

### Verify tasks still open

None of these could be run in #703 (no real AniList account, and no live
requests). Until a real-account check answers them, the code takes the
conservative default named in each:

- **The token-rejection shape for a truncated paste.** An expired or missing
  token answers HTTP 401 with `errors[0].status` 401 (the epic's probe), and a
  revoked one HTTP 400 with `errors[0] = {status: 400, message: "Invalid
  token"}` (settled below). Default: an `Invalid token` message is `auth`
  whatever its status.
- **Whether `repeat` counts a rewatch at its start.** Default:
  `ANILIST_REPEAT_SHIFT = 0`. The round-trip test runs both shifts.
- **Whether `Page.media` filters adult titles implicitly** for a viewer with
  `displayAdultContent: false` and unauthenticated. Default: no `isAdult`
  argument anywhere; if the probe finds a filter, the disabling argument goes
  into `ID_MAP_LOOKUP`.

### Verify tasks settled

- **The token-rejection shape for a revoked token** (observed 2026-11-27 on
  #734's real-account check): HTTP 400, `errors[0] = {status: 400, message:
  "Invalid token"}`. The classifier files it as `auth` by its message, as the
  default above assumed, and `test/fixtures/anilist/invalid-token-400.json` has
  that shape. The same check found the read that discovered the revoke
  rejecting to the renderer instead of answering from the cache; `getEntry`'s
  rethrow fixes that (#740).

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

## MyAnimeList

#702 (T6) adds MyAnimeList as a provider, under `src/main/trackers/mal/`:
`client.ts` (every request), `auth.ts` (sign-in and tokens), `provider.ts`
(the `TrackerProvider`, its codec and capabilities), `classify.ts`,
`events.ts` (the broadcasts), `setup.ts` (the card's Test) and `index.ts`
(`createMalTracker`, the construction `index.ts` and the tests share). The app
ships no MAL credentials (MAL's API agreement §2(a)): each user registers their
own app, and `myanimelistClientConfig` holds its client ID in plain text.

### Requests

- **Two hosts, two overrides.** REST is `api.myanimelist.net/v2`
  (`malApiBase()`, `ANIME_DL_MAL_API_BASE`), the authorize and token endpoints
  `myanimelist.net/v1/oauth2` (`malOauthBase()`, `ANIME_DL_MAL_OAUTH_BASE`).
  Packaged builds ignore both, like the other API base overrides.
- **One client.** Every MAL request goes through `client.ts`, so through
  `fetchWithTimeout` (offline refusal, timeouts, the network observer) and one
  limiter: request starts at least 1 s apart, and on a transient answer (429,
  5xx, a 403 "DoS detected") an exponential backoff from 2 s, at most 3
  retries and 60 s, which every later request waits out too. MAL sends no
  rate-limit headers. The drain's own item delay applies on top. Bodies are
  `x-www-form-urlencoded`.
- **Headers.** User calls send `Authorization: Bearer <token>`. The public
  reads by id (`getRelated`, `getRecommendations`, `getDetails`) and the card's
  Test send `X-MAL-CLIENT-ID` and no token.

### Sign-in

PKCE `plain` (MAL's only method) over a loopback redirect, inside
`auth-session.ts`'s state machine ([above](#accounts-and-sign-in)):

- **The verifier** is 96 random bytes in base64url, exactly 128 characters of
  RFC 7636's unreserved set, and the challenge *is* the verifier. A random
  `state` is checked on the callback and on a paste.
- **The fixed port is 41753 (`MAL_LOOPBACK_PORT`). Never change it.** Every
  user registers `http://localhost:41753/callback` as the one redirect URL of
  their MAL app, and MAL matches `redirect_uri` exactly, so a new value would
  silently break every existing registration. A test pins it. Unpackaged,
  `ANIME_DL_MAL_LOOPBACK_PORT` overrides it (tests pass `0`), and the authorize
  URL is built after the bind, with the port the loopback got.
- **The loopback** binds `127.0.0.1` and `::1` before the browser opens; only
  `EADDRNOTAVAIL` / `EAFNOSUPPORT` on `::1` are skipped, and any other bind
  failure is `port-busy`, which never opens the browser (the card offers Open
  anyway, Copy link and the paste field). It answers `GET /callback` only
  (any other path or method is a 404), every answer carries
  `Connection: close`, and teardown calls `closeAllConnections()` as well as
  `close()`, so no kept-alive browser socket outlives the attempt. A waiting
  attempt is dropped after 10 minutes (`MAL_AUTH_TIMEOUT_MS`), and `BEGIN`
  resolves `error` saying so.
- **The paste** takes only the full redirect URL, so `state` can be checked;
  a bare code is refused.
- **The exchange** posts `authorization_code` with the code, the verifier and
  the attempt's `redirect_uri`, and `client_secret` only when the user saved
  one (never empty). A failed exchange (a reused code's `invalid_grant`
  included) is an attempt `error`: it never sets `myanimelistSessionExpired`
  or touches stored credentials. Then `GET /users/@me` gives the
  `TrackerUser` (`{ id, nickname: name, avatar: picture }`).
- **Credentials** in the vault: `{ access_token, refresh_token, expires_in,
  obtainedAt }`, `obtainedAt` stamped locally (MAL's token response has no
  `created_at`). An attempt lives in memory only: a restart means Connect again.

### The session and the four refresh rules

`auth()` returns `MalSession` `{ token, userId, generation }`. It reads
`myanimelistUser` and the lifecycle's MAL generation before its first await,
so `userId` is the owner the drain read; with no user it throws `Not logged
in to MyAnimeList`. Every data member takes the session first and sends
`session.token`; none re-reads the user or the credentials, except rule 1's
one retry. A login or logout landing during the vault read throws
`MalSessionChangedError` (`network`: the drain sees the owner change or tries
again next tick).

1. **A 401 retries once.** A refresh revokes the old token, so on a 401 a data
   member reads the stored token: if it differs from the one it sent, it
   retries with that; otherwise it joins one single-flight refresh and retries
   with its token. Only while the session's `generation` is still current:
   after a logout or a switch the 401 is thrown as is (`auth`) and the drain's
   owner guard ends the run, so A's item never goes out with B's token.
2. **Refresh past half-life:** `now ≥ obtainedAt + expires_in × 1000 / 2`, not
   at expiry (the refresh token's month and the observed ~28-day
   `expires_in` are too close for a lazy refresh).
3. **`obtainedAt` is the clock at store time.**
4. **`invalid_client` on refresh is setup, not expiry.** It is thrown as is,
   classifies `config`, and the token step sets "Needs setup"; the credentials
   and the expired flag stay. **`invalid_grant`** is the expiry: the
   credentials are cleared, `myanimelistSessionExpired` set, the user and the
   queue kept, then the sync status and `notifyAccountsChanged()` go out
   (`createMalTracker`'s `onSessionExpired`), and the refresh throws
   `MalSessionGoneError` (`isSessionGone`: the timer stops).

**The logout race.** The refresh captures the generation when it starts, and
stores the new tokens through the vault's conditional write
(`write(key, value, { if: () => generation unchanged })`), whose guard runs in
the same synchronous step as the commit, after the encrypt. A logout (or a
logout and a login) during the encrypt wins. The single-flight promise is held
until that store lands, so a caller arriving between the POST and the store
joins it instead of re-posting the rotated refresh token. An `invalid_grant`
clears the credentials only while the generation is unchanged too.

### The list

- **Reads.** `listEntries` reads `/users/@me/animelist` with the
  `list_status{…}` fields named (`num_times_rewatched` reportedly only comes
  back when named), `num_episodes,status,media_type,main_picture`,
  `limit=1000` (the maximum) and `nsfw=true`, following `paging.next`; a next
  link off the configured base is rebuilt from its `offset`, so a stubbed run
  never leaves the stub. A status filter is applied locally. `getEntry` reads
  `/anime/{id}?fields=my_list_status{…},num_episodes,status&nsfw=true`; no
  `my_list_status` is `null` (not on the list: the drain's create branch).
  `nsfw=true` on every list and title read, so a gray or black title never
  looks "not on list".
- **Normalization.** `malId` and `remoteId` are the node id (MAL needs no id
  map); `updatedAt` is `list_status.updated_at` in ms; `anime` is `title`,
  `poster` (`main_picture.large`, else `medium`: absolute URLs), `kind`
  (`media_type`), `episodes` (`num_episodes`, 0 read as `null`, MAL's
  "unknown"), `episodesAired` (`num_episodes` when `finished_airing`, else
  `null`: MAL has no aired count for an airing title) and `status`.
  `smotretAnime` is the `lookupByMalIds` join. `native` is the `data[]`
  element as read, `{ node, list_status }`.
- **The cache.** `myanimelistUserRates` rows are `native` plus its
  `smotretAnime` (`malRateCache.fromEntries`); a patch writes the values back
  in MAL's own form (`status` + `is_rewatching`, `num_episodes_watched`,
  `score`, `num_times_rewatched`). `entryOf` gives the `tracker:*` payload.
- **Writes.** `upsertEntry` PATCHes `/anime/{id}/my_list_status` (the same
  call creates a missing entry) with `changedFields` only: `episodes` →
  `num_watched_episodes` (the write key; the read key is
  `num_episodes_watched`), `status` → `status` + `is_rewatching` (and
  `num_times_rewatched`, below), `score` → `score` (MAL's 0–10 integers are
  the app's), `rewatches` → `num_times_rewatched`. No changed field makes no
  request. `deleteEntry` DELETEs it; a 404 is already gone.

| Canonical | MAL read | MAL write |
|---|---|---|
| `planned` | `plan_to_watch` | `status=plan_to_watch&is_rewatching=false` |
| `watching` | `watching` | `status=watching&is_rewatching=false` |
| `rewatching` | any status with `is_rewatching=true` | `status=watching&is_rewatching=true` |
| `completed` | `completed` | `status=completed&is_rewatching=false` |
| `on_hold` | `on_hold` | `status=on_hold&is_rewatching=false` |
| `dropped` | `dropped` | `status=dropped&is_rewatching=false` |

**The rewatch shift (`MAL_REWATCH_SHIFT = 1`).** The app counts a rewatch when
it starts (`nextWatchedRate`); MAL, by community reports, counts one when it is
completed. So on a `rewatching` entry a read adds one (`app = native + 1`) and
a write takes one off (`native = max(0, app − 1)`), keyed on the canonical
status after the write; other statuses pass through. A status write entering
or leaving `rewatching` moves MAL's count even when the app's `rewatches`
doesn't change, so every status write also sends `num_times_rewatched`, as
part of the one changed field. **Not verified against a real account** (see
the verify list below); if MAL counts at the start, the shift becomes 0 and
the translation the identity.

**Capabilities.** `getRelated(ref)` reads the title's own `media_type` and
`start_date` beside its raw `related_anime` (T11c's walk calls it per node);
`getRecommendations(seeds)` reads each seed's `recommendations`;
`getDetails(malId)` reads synopsis, genres and the rest on demand and writes
`myanimelistAnimeDetails[malId] = { details, fetchedAt }` (the shape of
`shikimoriAnimeDetails`), keeping the 300 most recently fetched titles
(`MAL_DETAILS_CACHE_MAX`): every write rewrites the store file, so the cache
is capped, and the oldest fetch is evicted first. In T11a's details read
(#706), `cachedDetails(malId)` normalizes that entry to `TrackerDetails`
(synopsis, genre names, the airing status in Shikimori's words, the total,
the aired count when finished, `media_type`); a `tracker:get-details` miss
kicks `requestPrefetch(malId)`, which fetches only a title on the user's list
(the API agreement isn't settled for caching beyond it) and joins a fetch for
that title already in flight; each write is broadcast on
`tracker:details-updated` (`sync.broadcastDetails`). `createMalTracker` passes
`detailsUpdatedChannel` and `prefetchDetails`, and no `onRatesRefreshed`.
T11c and T11d consume the relations and recommendations reads. No
`getAiringInfo` or `getCalendar` (MAL has a total and a status only, so it is
never the `airing` source and MAL-only users get no auto-download) and no
friends.

### The sync instance and the primary

- **One instance** (`createTrackerSyncService` with `MYANIMELIST_KEYS`) in
  the fan-out beside Shikimori's. Its broadcasts are `tracker:*` only, with
  `trackerId: 'mal'` (`events.ts` reshapes the instance's payloads: the rate
  rows through `entryOf`, the status with `needsSetup`, the queue with
  `queuedAfter`). The emit order holds: rate, then queue.
- **"Needs setup"** is set by a `config` result (item step or token step) and
  by a missing client ID (the accounts state reads that from the config). No
  drain runs while it is set. `tracker:set-client-config` clears it after a
  save and `tracker:test-client-config` on `{ ok: true }`, through
  `clearNeedsSetup()`, which kicks one drain. Each transition broadcasts the
  sync status and `notifyAccountsChanged()` (`onNeedsSetupChanged`).
- **The primary branch** (`services/trackers/mal-primary.ts`, set by
  `registerPrimary` with `setPrimaryWriter('mal', …)`), shaped after
  Shikimori's: a user change to MAL as the primary (update-rate, the player's
  mark-watched) is sent live with one session (the live entry, then
  `upsertEntry` with the fields that differ from it), stamps the clock and
  patches the cache; a title new to the list refreshes the list in the
  background. A failure the queue would survive (any class whose policy keeps
  the entry: `network`, `auth`, `rate-limit`, `server`, `config`) queues the
  whole rate against the cached row instead, parked for its owner after a
  switch; an `item` failure throws. A change that reaches `completed` runs the
  cleanup prompt with the MAL row's own `smotretAnime`. The body of #702 named
  no primary writer; it was added because without one a MAL-only user's
  update-rate and mark-watched throw `MyAnimeList has no primary write path`.

### The MAL card

`MalConnectForm.vue`, the MAL body of a `TrackerAccountCard`, shown while
`TrackerAccountsState.newTrackerCardsEnabled` is true:
`newTrackerCardsEnabled(app.isPackaged)` (`trackers/flags.ts`), off in packaged
builds until #698, #699 and #704 have landed (the same flag as AniList's
card). Main refuses `tracker:begin-auth` and `tracker:complete-auth` for MAL
while it is off, with no bind and no browser. The body:

1. The setup steps, expanded until a client ID is saved and again on "Needs
   setup": a link to `myanimelist.net/apiconfig/create` and a copy button per
   value (App Name `anime-dl personal sync`, App Type **other**, a 50–500
   character description, **exactly one** redirect URL line,
   `http://localhost:<port>/callback` with main's port from
   `tracker:get-client-config`'s `redirectUri`, the repo as homepage,
   non-commercial, hobbyist), then "Return to list → Edit" for the Client ID. It
   says to reuse an existing client ID (MAL allows 5 per account).
2. The Client ID (plain, `tracker:set-client-config`) and an optional secret:
   a password field with no reveal, write-only (the renderer only ever sees
   `hasSecret`: "A secret is saved", Remove).
3. Test (`tracker:test-client-config`): "Client ID works", the `config`
   message, or the network message.
4. Connect, disabled until a client ID is saved; then "Waiting for
   MyAnimeList in your browser…" with Cancel and the paste field, or on
   `port-busy` the warning naming the port, Open anyway (the only place the
   authorize URL is opened from) and Copy link. Leaving the tab doesn't cancel.

The card shows its body while "Needs setup" too, so a connected account can fix
its client ID. #701 (T5b)'s second-tracker gate isn't in the card yet: the
flag doesn't exist on main; T5b adds it.

### Verify list (open)

Nothing below was verified: there was no real MAL account, and
`myanimelist.net` reset the connection when the API agreement was fetched. The
fixtures are written from documented and community-reported shapes
([Testing](./testing.md)). Each item stays open until a manual run with a
self-registered client captures it:

- the real `expires_in` and refresh-token lifetime (the half-life rule assumes
  the ~28-day sample);
- the refresh error bodies (`invalid_grant`, `invalid_client`), the 400
  "Invalid client id" and 403 bodies;
- PATCH vs PUT on `my_list_status` (PATCH, per the docs);
- whether `num_times_rewatched` counts at the start or at completion (the
  shift above assumes completion) and which status a rewatch reads as;
- whether the list hides gray/black titles without `nsfw=true`;
- the API agreement: attribution, caching candidate details (#711), and
  whether §4(b) and §4(f) fall on each user as the registrant (a legal call,
  not made here);
- that a `localhost` redirect registers and a second redirect line errors.

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
