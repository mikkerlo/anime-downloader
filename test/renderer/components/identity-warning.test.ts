// @vitest-environment happy-dom
// The no-account choice's copy (#578), checked against what shipped since (#587):
// a claim PC syncs with the drive (S9 #584), so the warning no longer says
// syncing "arrives in a later update".
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import IdentityWarning from '../../../src/renderer/src/components/shared-library/IdentityWarning.vue'

const candidate: SharedLibraryCandidate = {
  root: '/media/u/STICK/Trip',
  libraryId: '3b0e7a52-5c1f-4d8e-9a6b-2f4c8d1e7a90',
  name: 'Trip',
  ownerNickname: 'akira',
  mode: 'metadata',
  titleCount: 2,
  identity: 'choose'
}

describe('IdentityWarning, no account', () => {
  it('says the claim syncs with the drive now, and never with Shikimori', () => {
    const w = mount(IdentityWarning, { props: { candidate } })
    const text = w.text()
    expect(text).toContain("this PC then syncs akira's watch state with the drive")
    expect(text).toContain('It never sends anything to Shikimori.')
    expect(text).not.toContain('later update')
  })
})
