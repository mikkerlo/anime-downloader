// @vitest-environment happy-dom
//
// A room jump of more than one episode walks every step (#501).
//
// `handleRemoteEpisodeChange` follows a relative jump with
// `walkEpisodeSteps(shouldStep, () => goToEpisode(dir, 'follow', …))`, and
// `shouldStep()` reads `!navigating.value`. Both of `goToEpisode`'s source arms
// write the new source and release `navigating` in a `nextTick` callback. Those
// source writes queue a render, so `nextTick(fn)` chains `fn` behind that flush:
// un-awaited, the step returned `'moved'`, the walk resumed one microtask before
// the release, read `navigating === true` and stopped. Measured in #492's manual
// test: a 29 → 31 jump left the follower on 30 in 12 of 12 runs.
//
// `PlayerView` has no mount harness, so `goToEpisode` is modelled here at the
// granularity that decides the ordering, on real Vue: a mounted component that
// renders the source (the pending flush), the syncplay episode-change watcher
// as a pre-flush `watch` on the index, and the real `walkEpisodeSteps`. The
// source scans in `test/renderer/components/player-lifecycle-scope.test.ts`
// pin the component to this shape, one arm at a time.

import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent, h, nextTick, ref, watch } from 'vue'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { walkEpisodeSteps } from '../../src/renderer/src/utils'
import type { EpisodeStepOutcome } from '../../src/renderer/src/utils'

const EPISODES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']

type Arm = 'local-file' | 'stream'

interface ModelOptions {
  arm: Arm
  /** The fix: `await nextTick(release)`. `false` is main's shape before #501. */
  awaitRelease?: boolean
  /** Render the source, as `<video :src>` does. Off = no pending flush. */
  render?: boolean
  /** Bump `navigationEpoch` between the source write and the release callback. */
  supersedeBeforeRelease?: boolean
  /** Throw from the release callback, as a failing `seekProgrammatically` would. */
  throwInRelease?: boolean
  /** Pass `continuesWalk` to steps after the first, as the walk does. */
  continuesWalk?: boolean
}

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

const macrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function model(startIdx: number, opts: ModelOptions) {
  const awaitRelease = opts.awaitRelease ?? true
  const activeEpisodeIndex = ref(startIdx)
  const activeFilePath = ref('')
  const activeStreamUrl = ref('')
  const navigating = ref(false)
  let navigationEpoch = 0
  let translationEpoch = 0
  let pendingPrevEpisodeInt = ''
  const pushes: string[] = []
  const caught: unknown[] = []

  // `use-syncplay-client.ts`'s episode-change watcher: a pre-flush `watch`
  // that pushes `setFile` on every index commit.
  watch(activeEpisodeIndex, (i) => {
    pushes.push(EPISODES[i])
  })

  if (opts.render ?? true) {
    wrapper = mount(
      defineComponent({
        setup: () => () => h('video', { src: activeFilePath.value || activeStreamUrl.value })
      })
    )
  }

  async function goToEpisode(
    direction: 'prev' | 'next',
    continuesWalk = false
  ): Promise<EpisodeStepOutcome> {
    const targetIndex =
      direction === 'prev' ? activeEpisodeIndex.value - 1 : activeEpisodeIndex.value + 1
    if (targetIndex < 0 || targetIndex >= EPISODES.length) return 'unreachable'
    if (navigating.value) return 'superseded'
    await macrotask() // saveProgress(true)
    const prevEpisodeInt = EPISODES[activeEpisodeIndex.value]
    navigating.value = true
    const myNav = ++navigationEpoch
    try {
      await macrotask() // resolveEpisodeTranslation + playerCleanupRemux
      if (navigationEpoch !== myNav) return 'superseded'
      activeEpisodeIndex.value = targetIndex
      if (!continuesWalk) pendingPrevEpisodeInt = direction === 'next' ? prevEpisodeInt : ''
      await macrotask() // playerFindLocalFile / playerGetStreamUrl
      if (navigationEpoch !== myNav) return 'moved'
      if (opts.arm === 'local-file') {
        activeFilePath.value = `file:${EPISODES[targetIndex]}`
        activeStreamUrl.value = ''
      } else {
        activeFilePath.value = ''
        activeStreamUrl.value = `stream:${EPISODES[targetIndex]}`
      }
      if (opts.supersedeBeforeRelease) navigationEpoch++
      const release = (): void => {
        if (navigationEpoch !== myNav) return
        if (opts.throwInRelease) throw new Error('seek failed')
        navigating.value = false
      }
      if (awaitRelease) await nextTick(release)
      else void nextTick(release)
      return 'moved'
    } catch (err) {
      if (navigationEpoch !== myNav) return 'superseded'
      if (navigationEpoch === myNav) navigating.value = false
      caught.push(err)
      return 'moved'
    }
  }

  /** `handleRemoteEpisodeChange`, resolving with the walk's outcome. */
  function follow(episodeInt: string): Promise<EpisodeStepOutcome | 'arrived'> {
    const idx = EPISODES.indexOf(episodeInt)
    const dir = idx > activeEpisodeIndex.value ? 'next' : 'prev'
    const walkTranslation = translationEpoch
    let steps = 0
    return walkEpisodeSteps(
      () =>
        activeEpisodeIndex.value !== idx &&
        !navigating.value &&
        translationEpoch === walkTranslation,
      () => goToEpisode(dir, (opts.continuesWalk ?? true) && steps++ > 0)
    )
  }

  return {
    follow,
    episode: () => EPISODES[activeEpisodeIndex.value],
    navigating: () => navigating.value,
    pendingPrev: () => pendingPrevEpisodeInt,
    pushes,
    caught,
    pickTranslation: () => {
      translationEpoch++
    }
  }
}

const ARMS: Arm[] = ['local-file', 'stream']

describe('a room jump walks every step (#501)', () => {
  it.each(ARMS)('reaches N+2 on the %s arm', async (arm) => {
    const m = model(5, { arm })
    expect(await m.follow('8')).toBe('arrived')
    expect(m.episode()).toBe('8')
    expect(m.pushes).toEqual(['7', '8'])
    expect(m.navigating()).toBe(false)
  })

  it.each(ARMS)('reaches N+3 on the %s arm', async (arm) => {
    const m = model(5, { arm })
    await m.follow('9')
    expect(m.episode()).toBe('9')
    expect(m.pushes).toEqual(['7', '8', '9'])
  })

  it.each(ARMS)('walks a Prev jump back two on the %s arm', async (arm) => {
    const m = model(5, { arm })
    await m.follow('4')
    expect(m.episode()).toBe('4')
    expect(m.pushes).toEqual(['5', '4'])
  })

  // main's shape before #501, kept as the characterisation the fix answers.
  it.each(ARMS)('stopped at N+1 with an un-awaited release on the %s arm', async (arm) => {
    const m = model(5, { arm, awaitRelease: false })
    expect(await m.follow('8')).toBe('arrived')
    expect(m.episode()).toBe('7')
    expect(m.pushes).toEqual(['7'])
    // The release did run, one hop after the walk had already ended.
    await macrotask()
    expect(m.navigating()).toBe(false)
    expect(m.episode()).toBe('7')
  })

  // The harness's own control: without a pending flush `nextTick(fn)` chains
  // onto an already-resolved promise and `fn` runs before the walk resumes, so
  // main's shape passes. Every case above depends on the render being mounted.
  it('needs the pending flush: with nothing rendered, the un-awaited shape also reaches N+2', async () => {
    const m = model(5, { arm: 'stream', awaitRelease: false, render: false })
    await m.follow('8')
    expect(m.episode()).toBe('8')
  })

  it.each(ARMS)(
    'settles a superseded step whose release returns early, and stops the walk, on the %s arm',
    async (arm) => {
      // `nextTick(fn)` settles once `fn` has run, early return or not, so the
      // awaited step cannot hang. The walk stops because the superseding run
      // still holds `navigating`.
      const m = model(5, { arm, supersedeBeforeRelease: true })
      expect(await m.follow('8')).toBe('arrived')
      expect(m.episode()).toBe('7')
      expect(m.navigating()).toBe(true)
    }
  )

  it.each(ARMS)(
    'sends a throw from the release to the catch, which releases navigating, on the %s arm',
    async (arm) => {
      const m = model(5, { arm, throwInRelease: true })
      await m.follow('8')
      // The catch released the flag and returned `'moved'`, so the walk took
      // its second step (which threw too, and was caught the same way).
      expect(m.caught).toHaveLength(2)
      expect(m.navigating()).toBe(false)
      expect(m.episode()).toBe('8')
    }
  )

  it('stops at the first translation pick made mid-walk', async () => {
    const m = model(5, { arm: 'stream' })
    const walk = m.follow('9')
    // Inside step 1: after its commit, before its release.
    await macrotask()
    await macrotask()
    m.pickTranslation()
    await walk
    expect(m.episode()).toBe('7')
  })

  it('keeps the walk’s first pending mark-watched, so the skipped episode is not marked', async () => {
    const m = model(5, { arm: 'stream' })
    await m.follow('9')
    expect(m.episode()).toBe('9')
    expect(m.pendingPrev()).toBe('6')
  })

  it('would mark the intermediate episode if every step overwrote it', async () => {
    const m = model(5, { arm: 'stream', continuesWalk: false })
    await m.follow('9')
    expect(m.pendingPrev()).toBe('8')
  })
})
