// @vitest-environment happy-dom
//
// #280 — `PlayerView`'s `onMounted` is `async`, and teardown-sensitive wiring
// used to sit *after* its first two `await`s. Three consequences:
//
//   1. a `watch()` created after an await escapes the component's effect scope
//      and is never stopped;
//   2. a close landing inside those awaits leaks both IPC subscriptions,
//      because `onBeforeUnmount` runs against `null` and the resumed
//      continuation registers them on a dead instance;
//   3. a close landing inside `prepareMkvForPlayback` orphans an ffmpeg
//      process, because the unmount cleanup is skipped (no `streamSessionId`
//      yet) and nothing else in the app reaps a stream session.
//
// There is no mount harness for `PlayerView` — it needs dozens of `window.api`
// channels plus WebGPU/MSE/JASSUB init — so the regression halves below scan
// the source, the same approach `player-syncplay-resume.test.ts` takes for this
// SFC and `test/ipc-channels.test.ts` takes for the channel table. The one
// behavioral test here (#1) reduces the scope question to our own invariant on
// a throwaway component instead.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineComponent, h, ref, watch, onMounted, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { parse } from '@vue/compiler-sfc'
import type { ElementNode, TemplateChildNode } from '@vue/compiler-core'

const PLAYER_VIEW = resolve(__dirname, '../../../src/renderer/src/components/views/PlayerView.vue')
const APP_VUE = resolve(__dirname, '../../../src/renderer/src/App.vue')

const SOURCE = readFileSync(PLAYER_VIEW, 'utf8')

/**
 * Every scan below asserts on an explicit slice, never on the whole file. A
 * file-wide `indexOf` would pass for the wrong reasons: `await
 * window.api.getSetting(` also occurs inside `prepareMkvForPlayback` and in
 * `onMounted`'s tail, and `prepareMkvForPlayback(` also occurs in
 * `selectTranslation` and `goToEpisode`.
 */
function slice(startNeedle: string, endNeedle: string): string {
  const start = SOURCE.indexOf(startNeedle)
  const end = SOURCE.indexOf(endNeedle, start + startNeedle.length)
  expect(start, `missing slice start: ${startNeedle}`).toBeGreaterThan(-1)
  expect(end, `missing slice end: ${endNeedle}`).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

function mountedBody(): string {
  return slice('onMounted(', 'onBeforeUnmount(')
}

describe('#280 (1) — watcher scope is bound by synchronous creation, not by the hook', () => {
  // Measured on Vue 3.5.32, fire counts across unmount for three watchers on the
  // same ref: created in `setup` 1→1, created synchronously inside `onMounted`
  // 1→1, created after two `await`s inside `onMounted` 1→**2**. The third arm is
  // deliberately NOT asserted: it pins a Vue defect, so a Vue release that bound
  // post-`await` watchers to the instance scope would turn CI red for a change
  // that is strictly good for us. What we assert is our own invariant — the two
  // shapes the hoist produces are both silent after unmount.
  it('stops both a setup-created and a sync-in-onMounted watcher at unmount', async () => {
    const target = ref(0)
    const fired: string[] = []

    const Probe = defineComponent({
      setup() {
        watch(target, () => fired.push('setup'))
        onMounted(() => {
          watch(target, () => fired.push('sync-in-onMounted'))
        })
        return () => h('div')
      }
    })

    const wrapper = mount(Probe)
    await nextTick()

    target.value = 1
    await nextTick()
    expect(fired).toEqual(['setup', 'sync-in-onMounted'])

    wrapper.unmount()
    await nextTick()

    fired.length = 0
    target.value = 2
    await nextTick()
    expect(fired).toEqual([])
  })
})

describe('#280 (2) — the teardown-sensitive wiring is hoisted above the awaits', () => {
  it('creates the videoRef watch and both stream subscriptions before the first await', () => {
    const body = mountedBody()
    const firstAwait = body.indexOf('await window.api.getSetting(')
    const theWatch = body.indexOf('watch(\n    videoRef,')
    const subSubtitles = body.indexOf(
      'unsubPlayerStreamSubtitles = subs.subscribeStreamSubtitles()'
    )
    const subStream = body.indexOf('unsubPlayerStream = msePlayer.subscribeStreamEvents()')

    expect(firstAwait).toBeGreaterThan(-1)
    expect(theWatch).toBeGreaterThan(-1)
    expect(subSubtitles).toBeGreaterThan(-1)
    expect(subStream).toBeGreaterThan(-1)

    // Fails on v4.6.30: all three sat after the first `getSetting` await.
    expect(theWatch).toBeLessThan(firstAwait)
    expect(subSubtitles).toBeLessThan(firstAwait)
    expect(subStream).toBeLessThan(firstAwait)
  })

  it('keeps both getSetting awaits ahead of prepareMkvForPlayback', () => {
    // `docs/syncplay.md` records that this ordering is what keeps
    // `useSyncplayClient`'s `onMounted` push ahead of `prepareMkvForPlayback`'s
    // `syncplayGetRoomPosition` read — "a removed await would invert that
    // silently and spawn ep 2 at ep 1's position". This is the second issue to
    // move code around those two awaits; the assertion above alone would not
    // catch a future hoist that took the awaits with it.
    const body = mountedBody()
    const shortcuts = body.indexOf("await window.api.getSetting('keyboardShortcuts')")
    const prefetch = body.indexOf("await window.api.getSetting(\n    'prefetchNextEpisode'\n  )")
    const prepare = body.indexOf('await prepareMkvForPlayback(props.filePath)')

    expect(shortcuts).toBeGreaterThan(-1)
    expect(prefetch).toBeGreaterThan(shortcuts)
    expect(prepare).toBeGreaterThan(prefetch)
  })
})

describe('#280 — structural facts the fix must not disturb', () => {
  function templateRoot(file: string): ElementNode {
    const { descriptor, errors } = parse(readFileSync(file, 'utf8'), { filename: file })
    expect(errors).toEqual([])
    expect(descriptor.template).toBeTruthy()
    return descriptor.template!.ast as unknown as ElementNode
  }

  function walk(node: TemplateChildNode, visit: (el: ElementNode) => void): void {
    if (node.type !== 1) return
    const el = node as ElementNode
    visit(el)
    for (const child of el.children) walk(child, visit)
  }

  const STRUCTURAL_DIRECTIVES = ['if', 'else', 'else-if', 'for']

  function directiveNames(el: ElementNode): string[] {
    return el.props.filter((p) => p.type === 7).map((p) => (p as { name: string }).name)
  }

  function hasKey(el: ElementNode): boolean {
    return el.props.some(
      (p) =>
        (p.type === 6 && p.name === 'key') ||
        (p.type === 7 &&
          (p as { name: string; arg?: { content?: string } }).name === 'bind' &&
          (p as { arg?: { content?: string } }).arg?.content === 'key')
    )
  }

  it('leaves the <video> and every ancestor inside PlayerView unkeyed and unconditional', () => {
    // This is what makes "exactly one <video> element per mount" true, which is
    // in turn what makes the un-removed diagnostic listeners a latent hazard
    // rather than a per-swap leak. A later `:key` added for cache-busting would
    // silently promote it.
    const root = templateRoot(PLAYER_VIEW)
    const chain: ElementNode[] = []
    let found = false

    const search = (node: TemplateChildNode, ancestors: ElementNode[]): void => {
      if (node.type !== 1 || found) return
      const el = node as ElementNode
      const path = [...ancestors, el]
      if (el.tag === 'video') {
        chain.push(...path)
        found = true
        return
      }
      for (const child of el.children) search(child, path)
    }
    for (const child of root.children) search(child, [])

    expect(found).toBe(true)
    expect(chain.map((el) => el.tag)).toEqual(['div', 'div', 'video'])
    for (const el of chain) {
      expect(directiveNames(el).filter((n) => STRUCTURAL_DIRECTIVES.includes(n))).toEqual([])
      expect(hasKey(el)).toBe(false)
    }
  })

  it('renders exactly one <PlayerView v-if> in App.vue, with no :key', () => {
    const root = templateRoot(APP_VUE)
    const players: ElementNode[] = []
    for (const child of root.children)
      walk(child, (el) => {
        if (el.tag === 'PlayerView') players.push(el)
      })

    expect(players).toHaveLength(1)
    expect(directiveNames(players[0])).toContain('if')
    expect(directiveNames(players[0]).filter((n) => n === 'for')).toEqual([])
    expect(hasKey(players[0])).toBe(false)
  })
})
