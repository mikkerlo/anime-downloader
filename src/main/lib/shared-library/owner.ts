// Who owns a Shared Library, across layout majors (#713). Every owner
// comparison goes through here.
//
// A v1 owner (`{ shikimoriId }`) is matched by this PC's Shikimori user. A v2
// owner (`{ provider, userId }`) is matched only by a tracker account the actor
// carries, never by `shikimoriUserId`, even when its `provider` is
// `'shikimori'`. Since #714 a PC presents every connected account
// (`ownerAccountsOf`), Shikimori's included, so a hand-written v2
// `provider: 'shikimori'` owner matches the same Shikimori account.

/** An owner as `(provider, userId)`, whatever its layout. */
export interface NormalizedOwner {
  provider: string
  userId: string
  nickname?: string
}

/** The accounts a PC presents: `SharedLibraryActor` is one. */
export interface OwnerAccounts {
  shikimoriUserId: number | null
  trackerAccounts: readonly { provider: string; userId: string }[]
}

type AnyOwner = SharedLibraryOwner | SharedLibraryTrackerOwner | null | undefined

/**
 * What a PC with these connected accounts presents (#714): its Shikimori
 * account's id for a v1 owner, and every account for a v2 one.
 */
export function ownerAccountsOf(
  accounts: readonly { provider: string; userId: string }[]
): Pick<SharedLibraryActor, 'shikimoriUserId' | 'trackerAccounts'> {
  const shikimori = accounts.find((a) => a.provider === 'shikimori')
  return {
    shikimoriUserId: shikimori ? Number(shikimori.userId) : null,
    trackerAccounts: accounts.map(({ provider, userId }) => ({ provider, userId }))
  }
}

export function isTrackerOwner(owner: AnyOwner): owner is SharedLibraryTrackerOwner {
  return owner != null && 'provider' in owner
}

/** Both majors' owners as `(provider, userId)`; a v1 owner is `'shikimori'`. */
export function ownerOf(owner: AnyOwner): NormalizedOwner | null {
  if (owner == null) return null
  const nickname = owner.nickname !== undefined ? { nickname: owner.nickname } : {}
  if (isTrackerOwner(owner)) return { provider: owner.provider, userId: owner.userId, ...nickname }
  return { provider: 'shikimori', userId: String(owner.shikimoriId), ...nickname }
}

/** The Shikimori id a v1 owner names; `null` for no owner and for every v2 owner. */
export function shikimoriOwnerId(owner: AnyOwner): number | null {
  return owner == null || isTrackerOwner(owner) ? null : owner.shikimoriId
}

/**
 * A Shikimori `userId` that names one numeric account (#715): a v2
 * `provider: 'shikimori'` owner with `'05'` or `'abc'` would give one owner two
 * ids on a claim PC (`shikimori:05` beside `sync-pending/5.json`).
 */
const CANONICAL_SHIKIMORI_ID = /^[1-9]\d*$/

/**
 * The owner key (#715): `'<provider>:<userId>'` across majors, so a v1 owner
 * and a hand-written v2 `provider: 'shikimori'` owner of the same account
 * share one. Null for no owner, and for a v2 Shikimori owner whose `userId`
 * isn't canonical decimal: that owner is foreign on every PC.
 */
export function ownerKey(owner: AnyOwner | NormalizedOwner): string | null {
  const o = ownerOf(owner as AnyOwner)
  if (o === null) return null
  if (o.provider === 'shikimori' && !CANONICAL_SHIKIMORI_ID.test(o.userId)) return null
  return `${o.provider}:${o.userId}`
}

/**
 * The same owner by owner key, whatever the layout (#715): what the merge
 * runner, the claims and the writer compare. Never true for an owner with no
 * key. `sameOwner` above stays the identity check a `writeManifest` needs,
 * where a v1 → v2 change of the same account is still an owner change.
 */
export function sameOwnerKey(
  a: AnyOwner | NormalizedOwner,
  b: AnyOwner | NormalizedOwner
): boolean {
  const x = ownerKey(a)
  return x !== null && x === ownerKey(b)
}

/** Whether `who` is `owner`: the Shikimori user for a v1 owner, a tracker account for a v2 one. */
export function isOwnedBy(owner: AnyOwner, who: OwnerAccounts): boolean {
  if (owner == null) return false
  if (isTrackerOwner(owner)) {
    if (ownerKey(owner) === null) return false
    return who.trackerAccounts.some(
      (a) => a.provider === owner.provider && a.userId === owner.userId
    )
  }
  return who.shikimoriUserId !== null && who.shikimoriUserId === owner.shikimoriId
}

/** The same owner: both none, or the same layout and the same `(provider, userId)`. */
export function sameOwner(a: AnyOwner, b: AnyOwner): boolean {
  if (a == null || b == null) return a == null && b == null
  if (isTrackerOwner(a) !== isTrackerOwner(b)) return false
  const x = ownerOf(a)!
  const y = ownerOf(b)!
  return x.provider === y.provider && x.userId === y.userId
}
