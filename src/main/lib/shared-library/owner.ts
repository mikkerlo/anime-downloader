// Who owns a Shared Library, across layout majors (#713). Every owner
// comparison goes through here.
//
// A v1 owner (`{ shikimoriId }`) is matched by this PC's Shikimori user, and a
// claim only ever names a v1 owner. A v2 owner (`{ provider, userId }`) is
// matched only by a tracker account the actor carries, never by the Shikimori
// user, even when its `provider` is `'shikimori'`. Production actors carry no
// tracker account yet, so on this version every v2 owner is `foreign`.

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

/** Whether `who` is `owner`: the Shikimori user for a v1 owner, a tracker account for a v2 one. */
export function isOwnedBy(owner: AnyOwner, who: OwnerAccounts): boolean {
  if (owner == null) return false
  if (isTrackerOwner(owner)) {
    return who.trackerAccounts.some((a) => a.provider === owner.provider && a.userId === owner.userId)
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
