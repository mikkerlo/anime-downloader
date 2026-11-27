// @vitest-environment happy-dom
// `TrackerPendingDialog` builds its copy from a tracker label (#700). With
// 'Shikimori' every string is what `ShikimoriPendingDialog` showed in 6.x,
// byte for byte: a Shikimori-only user must not see the copy move.
import { describe, it, expect, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import TrackerPendingDialog from '../../../src/renderer/src/components/settings/TrackerPendingDialog.vue'

enableAutoUnmount(afterEach)

type Props = InstanceType<typeof TrackerPendingDialog>['$props']

function render(props: Omit<Props, 'trackerLabel'>) {
  const wrapper = mount(TrackerPendingDialog, { props: { trackerLabel: 'Shikimori', ...props } })
  return {
    title: wrapper.find('.pending-title').text(),
    text: wrapper.find('.pending-text').text(),
    buttons: wrapper.findAll('.pending-actions button').map((b) => b.text())
  }
}

describe("TrackerPendingDialog — Shikimori copy is 6.x's", () => {
  it('disconnect, several changes', () => {
    expect(render({ mode: 'disconnect', count: 2, nickname: 'mikkerlo' })).toEqual({
      title: 'Disconnect Shikimori?',
      text: "2 Shikimori changes haven't been synced yet.",
      buttons: ['Cancel', 'Discard', 'Keep for mikkerlo']
    })
  })

  it('disconnect, one change', () => {
    expect(render({ mode: 'disconnect', count: 1, nickname: 'mikkerlo' })).toEqual({
      title: 'Disconnect Shikimori?',
      text: "1 Shikimori change hasn't been synced yet.",
      buttons: ['Cancel', 'Discard', 'Keep for mikkerlo']
    })
  })

  it('switch: no Cancel', () => {
    expect(
      render({ mode: 'switch', count: 2, nickname: 'mikkerlo', newNickname: 'akvasha' })
    ).toEqual({
      title: 'Signed in to a different account',
      text: "2 Shikimori changes for mikkerlo haven't been synced yet. They won't be sent to akvasha.",
      buttons: ['Discard', 'Keep for mikkerlo']
    })
  })

  it('discard a kept row', () => {
    expect(render({ mode: 'discard', count: 4, nickname: 'friend' })).toEqual({
      title: 'Discard kept changes?',
      text: "4 Shikimori changes for friend haven't been synced yet. Discarding them can't be undone.",
      buttons: ['Cancel', 'Discard']
    })
  })

  it('discard the unknown-account bucket, one change', () => {
    expect(render({ mode: 'discard', count: 1, nickname: null })).toEqual({
      title: 'Discard kept changes?',
      text: "1 Shikimori change for an unknown account hasn't been synced yet. Discarding them can't be undone.",
      buttons: ['Cancel', 'Discard']
    })
  })
})

describe('TrackerPendingDialog — the label', () => {
  it('names the tracker it was given', () => {
    const wrapper = mount(TrackerPendingDialog, {
      props: { mode: 'disconnect', trackerLabel: 'AniList', count: 3, nickname: 'me' }
    })
    expect(wrapper.find('.pending-title').text()).toBe('Disconnect AniList?')
    expect(wrapper.find('.pending-text').text()).toBe("3 AniList changes haven't been synced yet.")
  })
})
