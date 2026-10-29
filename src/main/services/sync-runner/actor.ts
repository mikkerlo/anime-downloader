// Who writes a Shared Library (#584): S5's writer checks ownership itself, so
// the actor must carry the claim when this PC has no account. The claim comes
// from the attached record (`attachedLibraries[libraryId].claim`, S7a #578),
// and only while no Shikimori user is signed in (a login drops it).

import type { StorageService } from '../../store/types'

export function buildActor(
  store: Pick<StorageService, 'get'>,
  libraryId: string,
  appVersion: string
): SharedLibraryActor {
  const userId = store.get<{ id?: number } | null>('shikimoriUser')?.id ?? null
  const rec = store.get<Record<string, AttachedLibraryRecord> | undefined>('attachedLibraries')?.[
    libraryId
  ]
  const claim = userId === null && rec?.claim ? { libraryId, ownerId: rec.claim.ownerId } : null
  return {
    installId: store.get<string | undefined>('installId') ?? '',
    appVersion,
    shikimoriUserId: userId,
    claim
  }
}
