// @vitest-environment happy-dom
// The no-account choice's copy (#578), checked against what shipped since (#587):
// a claim PC syncs with the drive (S9 #584), so the warning no longer says
// syncing "arrives in a later update". Since #714 both warnings are
// tracker-generic, and keep the Shikimori texts for a Shikimori-owned library
// on a Shikimori-only PC.
import { describe, it, expect, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import IdentityWarning from '../../../src/renderer/src/components/shared-library/IdentityWarning.vue'

const candidate: SharedLibraryCandidate = {
  root: '/media/u/STICK/Trip',
  libraryId: '3b0e7a52-5c1f-4d8e-9a6b-2f4c8d1e7a90',
  name: 'Trip',
  ownerNickname: 'akira',
  ownerProvider: 'shikimori',
  mode: 'metadata',
  titleCount: 2,
  identity: 'choose'
}

const account = (trackerId: TrackerId, connected: boolean): TrackerAccount => ({
  trackerId,
  user: connected ? { id: 1, nickname: 'me', avatar: null } : null,
  hasCredentials: connected,
  sessionExpired: false,
  needsSetup: false,
  credentialState: connected ? 'ok' : 'none'
})

/** The trackers store's source: `connected` trackers have a user. */
function stubTrackers(connected: TrackerId[]): void {
  const state: TrackerAccountsState = {
    accounts: (['shikimori', 'anilist', 'mal'] as const).map((id) =>
      account(id, connected.includes(id))
    ),
    primary: connected[0] ?? null,
    mirror: {},
    featureSources: {}
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(
    { trackerListAccounts: async () => state },
    {
      get: (target, prop, recv) =>
        prop in target ? Reflect.get(target, prop, recv) : async () => null
    }
  )
}

async function render(
  over: Partial<SharedLibraryCandidate>,
  connected: TrackerId[] = []
): Promise<string> {
  stubTrackers(connected)
  const w = mount(IdentityWarning, { props: { candidate: { ...candidate, ...over } } })
  await flushPromises()
  return w.text()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('IdentityWarning, no account', () => {
  it('says the claim syncs with the drive now, and never with Shikimori', async () => {
    const text = await render({})
    expect(text).toContain('This library belongs to akira')
    expect(text).toContain('This PC has no Shikimori account.')
    expect(text).toContain("this PC then syncs akira's watch state with the drive")
    expect(text).toContain('It never sends anything to Shikimori.')
    expect(text).not.toContain('later update')
  })

  it('an AniList owner: no Shikimori wording, and the owner line names AniList (#714)', async () => {
    const text = await render({ ownerProvider: 'anilist' })
    expect(text).not.toContain('Shikimori')
    expect(text).toContain('This library belongs to akira (AniList)')
    expect(text).toContain('This PC has no tracker account.')
    expect(text).toContain('It never sends anything to AniList.')
  })

  it('an unknown provider: the nickname alone (#714)', async () => {
    const text = await render({ ownerProvider: 'kitsu' })
    expect(text).toContain('This library belongs to akira This PC has no tracker account.')
    expect(text).not.toContain('kitsu')
    expect(text).not.toContain('Shikimori')
    expect(text).toContain('It never sends anything to a tracker.')
  })
})

describe('IdentityWarning, someone else’s library (#714)', () => {
  it('a Shikimori owner on a Shikimori-only PC keeps the Shikimori text', async () => {
    const text = await render({ identity: 'foreign' }, ['shikimori'])
    expect(text).toContain('This library belongs to akira')
    expect(text).toContain("You're logged in to Shikimori as someone else")
    expect(text).not.toContain('None of the accounts')
  })

  it('an AniList owner on a Shikimori-only PC: no Shikimori wording', async () => {
    const text = await render({ identity: 'foreign', ownerProvider: 'anilist' }, ['shikimori'])
    expect(text).not.toContain('Shikimori')
    expect(text).toContain('This library belongs to akira (AniList)')
    expect(text).toContain('None of the accounts on this PC owns it')
  })

  it('a Shikimori owner on a PC with AniList only, or with both: the generic text', async () => {
    for (const connected of [['anilist'], ['shikimori', 'anilist']] as TrackerId[][]) {
      setActivePinia(createPinia())
      const text = await render({ identity: 'foreign' }, connected)
      expect(text).not.toContain('logged in to Shikimori')
      expect(text).toContain('This library belongs to akira (Shikimori)')
      expect(text).toContain('None of the accounts on this PC owns it')
    }
  })
})
