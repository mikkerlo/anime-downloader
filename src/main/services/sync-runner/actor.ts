// Who writes a Shared Library (#584): S5's writer checks ownership itself, so
// the actor must carry the claim when this PC has no account. The claim comes
// from the attached record (`attachedLibraries[libraryId].claim`, S7a #578, or
// `trackerClaim` for a v2 library, #714), and only while no tracker account is
// connected (a login to any tracker drops it). The actor presents every
// connected account (#714).

import { ownerAccountsOf } from '../../lib/shared-library/owner'
import type { StorageService } from '../../store/types'
import { connectedAccounts } from '../../trackers/primary'

export function buildActor(
  store: Pick<StorageService, 'get'>,
  libraryId: string,
  appVersion: string
): SharedLibraryActor {
  const accounts = connectedAccounts(store)
  const rec = store.get<Record<string, AttachedLibraryRecord> | undefined>('attachedLibraries')?.[
    libraryId
  ]
  let claim: SharedLibraryActorClaim | null = null
  // A record read straight from the store, outside `reconcileClaims`: a
  // leftover claim next to any `<provider>User` counts for nothing.
  if (accounts.length === 0 && rec) {
    if (rec.trackerOwner) {
      // A v2 claim (#714): the writer refuses it until #715.
      if (rec.trackerClaim)
        claim = { libraryId, provider: rec.trackerClaim.provider, userId: rec.trackerClaim.userId }
    } else if (rec.claim && rec.owner) {
      claim = { libraryId, ownerId: rec.claim.ownerId }
    }
  }
  const { shikimoriUserId, trackerAccounts } = ownerAccountsOf(accounts)
  return {
    installId: store.get<string | undefined>('installId') ?? '',
    appVersion,
    shikimoriUserId,
    claim,
    trackerAccounts
  }
}
