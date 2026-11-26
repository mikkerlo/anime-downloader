// The credential vault's user-facing states (#690, epic #688), shared so the
// AniList and MyAnimeList cards (#703, #702) render the copy main describes.

/** A stored sign-in the vault can't decrypt: keyring gone, or the profile moved. */
export const VAULT_LOCKED_TITLE = "Can't unlock saved sign-in"

/** The one way back from `VAULT_LOCKED_TITLE` besides Disconnect. */
export const VAULT_LOCKED_ACTION = 'Sign in again'

/**
 * Shown when the vault stored a sign-in without encryption because the system
 * keyring wasn't available. `config.backup.json` is refreshed from
 * `config.json` at every start, so a signed-out token stays in the backup until
 * then, and restoring that backup can bring it back.
 */
export const VAULT_PLAIN_WARNING =
  "Your system keyring isn't available, so this sign-in is saved without encryption. " +
  'After you sign out, a copy stays in config.backup.json until the next start, ' +
  'and restoring that backup brings it back.'
