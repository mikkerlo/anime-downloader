// The contract between `TrackerAccountCard` and a tracker's connect body
// (#700). The card owns the account shell (identity, chip, Disconnect, kept
// changes, the pending dialog); the body owns only how that tracker signs in.
// `ShikimoriConnectForm.vue` is the first; T6 and T7 add MAL's and AniList's.

/** Props the card passes to the body. */
export interface TrackerConnectFormProps {
  /**
   * Runs the body's sign-in and settles it in the card: the previous account
   * is read before `signIn` starts, so an account switch can be named. A
   * rejection from `signIn` comes back to the body to show; nothing after it
   * rejects.
   */
  complete: (signIn: () => Promise<TrackerUser>) => Promise<void>
}

/** What the body exposes to the card through its template ref. */
export interface TrackerConnectFormHandle {
  /** A sign-in is in progress, so the body has something to show. */
  active: boolean
  /** Starts a sign-in: the card's Reconnect on an expired session. */
  begin: () => Promise<void>
  /** Clears a sign-in in progress: run after a logout. */
  reset: () => void
}
