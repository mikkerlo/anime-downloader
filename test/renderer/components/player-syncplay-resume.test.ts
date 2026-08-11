import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// The resume-vs-room precedence rule (#240). `resumeFromSavedPosition` is an
// unexported `<script setup>` internal of a ~2.9k-line SFC wired to dozens of
// `window.api` channels and to WebGPU/MSE/JASSUB init, so there is no mount
// harness for it here — this scans the source, the same approach
// `player-toast-slot.test.ts` takes for the toast-slot gate and
// `test/ipc-channels.test.ts` takes for the channel table. The *behavior* the
// guard reads is covered for real at the composable seam, in
// `use-syncplay-client.test.ts` (`hasRemoteStateApplied` + the deferral block).
//
// What makes the scan non-vacuous: each assertion below is keyed to one edit
// that would reintroduce the bug — dropping the guard, moving it after the
// write, letting the toast survive it, or losing the `loadedmetadata` fan-out
// that applies the parked state in the first place.
const SOURCE = readFileSync(
  resolve(__dirname, '../../../src/renderer/src/components/views/PlayerView.vue'),
  'utf8'
)

const FLAT = SOURCE.replace(/\s+/g, ' ')

function resumeBody(): string {
  const start = SOURCE.indexOf('async function resumeFromSavedPosition')
  const end = SOURCE.indexOf('function maybeMarkPendingPrevWatched')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

const GUARD =
  "if (syncplayStatus.value.state === 'ready' && syncplay.hasRemoteStateApplied()) return;"

describe('PlayerView — remote state outranks the saved position (#240)', () => {
  it('guards the resume on a ready session with a remote state applied or pending', () => {
    // Both halves matter: `state === 'ready'` alone would eat the saved position
    // of a user alone in a room (main emits no `remote-state` for a self/absent
    // `setBy`), and `hasRemoteStateApplied()` alone would honor a room we are no
    // longer connected to.
    expect(resumeBody().replace(/\s+/g, ' ')).toContain(GUARD)
  })

  it('places the guard after watchedReported and before the seek and both toasts', () => {
    const body = resumeBody().replace(/\s+/g, ' ')
    const guard = body.indexOf(GUARD)
    const watched = body.indexOf('watchedReported = !!saved.watched;')
    const write = body.indexOf('video.currentTime = saved.position;')
    const toasts = [...body.matchAll(/resumeToast\.value = `Resumed at/g)].map((m) => m.index!)

    expect(watched).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(-1)
    // Both branches set the toast — the MSE-MKV early return (#198) and the
    // direct-file/CDN write. The room's position wins on both, so neither may
    // announce a resume that did not happen.
    expect(toasts).toHaveLength(2)

    // The saved record still populates `watchedReported`; only the seek and its
    // toast are skipped.
    expect(guard).toBeGreaterThan(watched)
    expect(guard).toBeLessThan(write)
    toasts.forEach((t) => expect(guard).toBeLessThan(t))
  })

  it('fans loadedmetadata into the composable from the template', () => {
    // Without this the parked state is never applied at all: the composable owns
    // no element listeners, it is driven by PlayerView's bindings.
    expect(FLAT).toContain('@loadedmetadata="syncplay.onVideoLoadedMetadata"')
  })
})
