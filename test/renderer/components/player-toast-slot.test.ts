import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// `.mkv-buffering-toast` is `position: absolute; top: 100px; right: 24px` — one
// slot, no stacking. PlayerView renders three toasts into it, and the two
// growing-`.part` ones (#63's "Waiting for download…" and #238's short-landing
// notice) can be live at the same moment: a clamped skip parks the playhead
// just behind the frontier, so `waiting` fires a beat later while the
// short-landing toast is still up.
//
// The gate that prevents the overlap lives in the template, which has no mount
// harness here (PlayerView is a ~2.5k-line SFC wired to dozens of `window.api`
// channels), so this scans the source instead — the same approach as
// `test/ipc-channels.test.ts` and `test/renderer/theme-tokens.test.ts`. It
// fails against the pre-review markup, where the short-landing toast was
// `v-if="skipClampToast"` with the collision check sampled once in the
// `onSkipLandedShort` callback.
const SOURCE = readFileSync(
  resolve(__dirname, '../../../src/renderer/src/components/views/PlayerView.vue'),
  'utf8'
).replace(/\s+/g, ' ')

function toastGates(): string[] {
  return [...SOURCE.matchAll(/<div v-if="([^"]+)" class="mkv-buffering-toast">/g)].map((m) => m[1])
}

describe('PlayerView growing-.part toast slot', () => {
  it('gates the short-landing toast on the waiting toast reactively, in the template', () => {
    const skipGate = toastGates().find((g) => g.includes('skipClampToast'))
    expect(skipGate).toBeDefined()
    expect(skipGate).toContain('!waitingToastUp')
  })

  it('drives the waiting toast from the same predicate, so the two cannot drift', () => {
    // If this one re-derived `waitingForDownload && !downloadDead` inline, the
    // gates would be two hand-copied booleans again and the `downloadDead`
    // half could be updated on one side only.
    expect(toastGates()).toContain('waitingToastUp')
  })

  it('derives that predicate from the shared utils helper, not from a local rule', () => {
    expect(SOURCE).toContain('waitingToastVisible(waitingForDownload.value, downloadDead.value)')
  })

  // Hiding the short-landing toast in the template is not enough on its own:
  // `showSkipClampToast` arms a 2500 ms timer that keeps `skipClampToast`
  // non-empty, and a clamped landing parks the playhead 2 s behind the frontier,
  // so `waiting` normally fires inside that window. Without a cancel, the next
  // `playing`/`canplay` drops the gate again and fades a stale notice back in
  // for the remainder of the timer. Same source-scan caveat as above — the
  // watcher lives in `<script setup>` and there is no mount harness, so this
  // pins the wiring, not the observable fade.
  it('retires the short-landing toast when the waiting toast takes the slot', () => {
    expect(SOURCE).toMatch(
      /watch\(\s*waitingToastUp\s*,\s*\(\s*(\w+)\s*\)\s*=>\s*\{\s*if \(\1\)\s*clearSkipClampToast\(\)/
    )
  })
})

describe('PlayerView episode-navigation notice (#419)', () => {
  // A dead-ended prev/next now says so. It must NOT say so through
  // `remuxError`, which renders `.remux-overlay` across the video: the failed
  // step leaves the CURRENT episode playing, so covering it would be a worse
  // outcome than the failure being reported. This pins the surface, in the
  // template, for the same reason as the scans above — there is no mount
  // harness for this SFC.
  it('reports a failed step in its own toast slot, not over the video', () => {
    expect(SOURCE).toContain('<div v-if="navToast" class="nav-toast">')
    // Its own row, because a room-driven walk can raise it while the syncplay
    // toast still names the move that triggered the walk.
    expect(SOURCE).toContain('.nav-toast { top: 180px;')
  })

  it('keeps the one wording for both silent arms and for the throw', () => {
    // Three arms reach it — no usable translation (fetch included), a null
    // `playerGetStreamUrl`, and the `catch` — and all three take the same
    // constant. Hand-written strings at three sites is how one of them ends up
    // saying nothing about the expired token that #354 found is the same null.
    expect(SOURCE).toContain('const NAV_FAILED_MESSAGE =')
    expect([...SOURCE.matchAll(/showNavToast\(NAV_FAILED_MESSAGE\)/g)]).toHaveLength(3)
    expect(SOURCE).not.toMatch(/showNavToast\('/)
  })

  // Non-regression for the boundary, which is the one `unreachable` that must
  // stay silent: #419 made `goToEpisode` toast on a step that cannot resolve,
  // and the cheapest way to get that wrong is to toast at the caller instead,
  // which would fire every time a user holds `next` at the last episode. The
  // gates that make that unreachable from the UI are these two.
  it('still hides both nav buttons for a single-episode anime', () => {
    const navs = [...SOURCE.matchAll(/<EpisodeNavButton v-if="([^"]+)" direction="(\w+)"/g)]
    expect(navs).toHaveLength(2)
    for (const m of navs) expect(m[1]).toBe('props.allEpisodes.length > 1')
    expect(navs.map((m) => m[2])).toEqual(['prev', 'next'])
  })

  it('still disables each nav button at its own end of the list and while navigating', () => {
    expect(SOURCE).toContain(
      '<EpisodeNavButton v-if="props.allEpisodes.length > 1" direction="prev" :disabled="!canPrev || navigating"'
    )
    expect(SOURCE).toContain(
      '<EpisodeNavButton v-if="props.allEpisodes.length > 1" direction="next" :disabled="!canNext || navigating"'
    )
  })
})
