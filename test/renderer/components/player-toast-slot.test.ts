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
})
