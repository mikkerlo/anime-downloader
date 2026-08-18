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

/** Line comments are stripped so prose that names a call site can't satisfy a scan. */
function stripComments(text: string): string {
  return text.replace(/^[ \t]*\/\/.*$/gm, '')
}

function mountedBody(): string {
  return stripComments(slice('onMounted(', 'onBeforeUnmount('))
}

function unmountedBody(): string {
  return stripComments(slice('onBeforeUnmount(', 'const seekProgress ='))
}

const PREPARE_MKV = stripComments(
  slice('async function prepareMkvForPlayback', 'function askHevcChoice')
)
const PREPARE_HEVC = stripComments(
  slice('async function prepareHevcTranscode', 'async function cancelHevcTranscode')
)

const BAIL = 'if (unmounted) return'

/**
 * Everything in these two functions that reaches out of the component: the IPC
 * surface plus the three non-`window.api` calls that still hold an external
 * resource — `prepareHevcTranscode`/`runLegacyRemuxIpc` (ffmpeg),
 * `askHevcChoice` (a modal whose resolver outlives the component),
 * `startMseSession` (a `MediaSource` + object URL) and `setTranscoding` (a
 * latched flag on the shared MSE composable).
 */
const GUARDED_CALL_RE =
  /(window\.api\.\w+|prepareHevcTranscode|runLegacyRemuxIpc|askHevcChoice|msePlayer\.startMseSession|msePlayer\.setTranscoding)\(/g

function callSites(body: string): { name: string; index: number }[] {
  const out: { name: string; index: number }[] = []
  const re = new RegExp(GUARDED_CALL_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    // Skip the function's own declaration.
    if (body.slice(Math.max(0, m.index - 'function '.length), m.index) === 'function ') continue
    out.push({ name: m[1], index: m.index })
  }
  return out
}

/**
 * The last `await` that can actually suspend *before* `index` is reached — i.e.
 * not the awaited call's own `await`. `const x = await window.api.foo()` must
 * not count as a suspension point that precedes `foo`; the statement separator
 * is what distinguishes "an earlier statement suspended here" from "this is my
 * own await".
 */
function precedingAwait(body: string, index: number): number {
  let at = body.lastIndexOf('await ', index)
  while (at > -1 && !body.slice(at + 'await '.length, index).includes(';')) {
    at = body.lastIndexOf('await ', at - 1)
  }
  return at
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

describe('#280 (4) — the unmounted ladder in prepareMkvForPlayback / prepareHevcTranscode', () => {
  // The rule this pins is "a bail after EVERY surviving await in the two
  // functions", not "a bail above every `window.api.*` call". The weaker phrasing
  // misses three things the continuation can still reach on a dead instance:
  // the two blanket `playerCleanupRemux()` calls (which kill a *successor*
  // player's sessions and `unlinkSync` its tmpDir), and `startMseSession`,
  // which is not a `window.api` call at all but leaks an object URL.
  it('pins the closed set of outward calls in prepareMkvForPlayback', () => {
    // A fifth main-process call added here fails this assertion until the author
    // lists it — and the guard assertion below then forces a bail with it.
    // Without the closed set the ladder is a snapshot that quietly decays.
    expect(callSites(PREPARE_MKV).map((c) => c.name)).toEqual([
      'window.api.watchProgressGet',
      'window.api.syncplayGetRoomPosition',
      'window.api.playerRemuxMkvStream',
      'prepareHevcTranscode',
      'msePlayer.startMseSession',
      'window.api.playerCleanupRemux',
      'window.api.getSetting',
      'askHevcChoice',
      'window.api.shellOpenExternalFile',
      'window.api.setSetting',
      'prepareHevcTranscode',
      'runLegacyRemuxIpc'
    ])
  })

  it('pins the closed set of outward calls in prepareHevcTranscode', () => {
    expect(callSites(PREPARE_HEVC).map((c) => c.name)).toEqual([
      'msePlayer.setTranscoding',
      'window.api.playerRemuxMkvStreamTranscode',
      'msePlayer.setTranscoding',
      'msePlayer.setTranscoding',
      'window.api.playerCleanupRemux',
      'msePlayer.startMseSession'
    ])
  })

  it.each([
    ['prepareMkvForPlayback', PREPARE_MKV],
    ['prepareHevcTranscode', PREPARE_HEVC]
  ])('guards every outward call in %s against the preceding await', (_name, body) => {
    // Delete any one bail and this goes red, naming the call it uncovered.
    for (const { name, index } of callSites(body)) {
      const lastAwait = precedingAwait(body, index)
      const lastBail = body.lastIndexOf(BAIL, index)
      expect(lastBail, `no \`${BAIL}\` between the preceding await and ${name}(`).toBeGreaterThan(
        lastAwait
      )
    }
  })

  it('places the prepareHevcTranscode bail above setTranscoding, as the first statement', () => {
    // Not at either call site: `prepareHevcTranscode` has two entries (the
    // `requiresTranscode` short-circuit and the `always-transcode` prompt
    // choice), and a check at one of them leaves the other open. Above
    // `setTranscoding(true)`, not below, so the flag is not latched on a dead
    // instance either.
    const bail = PREPARE_HEVC.indexOf(BAIL)
    const setTranscoding = PREPARE_HEVC.indexOf('msePlayer.setTranscoding(true)')
    expect(bail).toBeGreaterThan(-1)
    expect(setTranscoding).toBeGreaterThan(bail)
  })

  it('guards askHevcChoice and shellOpenExternalFile from one checkpoint above the choice', () => {
    // The `hevcPromptResolver` unblock in `onBeforeUnmount` is *conditional* —
    // it only fires if a resolver is already installed. A close during the
    // `playerCleanupRemux`/`getSetting` awaits leaves it null, so a prompt
    // opened afterwards is settled by nobody: `prepareMkvForPlayback` never
    // returns, its `finally` never runs, and `mkvPrepareInFlight` stays latched.
    const choiceDecl = PREPARE_MKV.indexOf('let choice: HevcPromptChoice')
    const bailAboveChoice = PREPARE_MKV.lastIndexOf(BAIL, choiceDecl)
    const getSetting = PREPARE_MKV.indexOf("window.api.getSetting('hevcTranscodeOnPlay')")
    expect(getSetting).toBeGreaterThan(-1)
    expect(bailAboveChoice).toBeGreaterThan(getSetting)
    expect(choiceDecl).toBeGreaterThan(bailAboveChoice)
    expect(PREPARE_MKV.indexOf('askHevcChoice()')).toBeGreaterThan(bailAboveChoice)
    expect(PREPARE_MKV.indexOf('window.api.shellOpenExternalFile(')).toBeGreaterThan(
      bailAboveChoice
    )
  })

  it('guards runLegacyRemuxIpc — the one spawn nothing can kill after the fact', () => {
    // `player:remux-mkv` never calls `registerSession`, so `playerCleanupRemux`
    // cannot reach it: not at unmount, not on the next open, not ever. This
    // renderer check is the only thing in the codebase that can stop it.
    const legacy = PREPARE_MKV.indexOf('runLegacyRemuxIpc(')
    expect(PREPARE_MKV.lastIndexOf(BAIL, legacy)).toBeGreaterThan(
      precedingAwait(PREPARE_MKV, legacy)
    )
  })

  it('bails with { ok: false } so the callers skip initSubtitles on the way out', () => {
    // `{ ok: true }` would fall through to the `initSubtitles(video)` calls in
    // `selectTranslation` / `goToEpisode` and construct an orphan worker.
    expect(SOURCE).toContain(
      "const PLAYER_CLOSED_BAIL = { ok: false, error: 'player closed' } as const;"
    )
  })

  it('wraps the whole prepareMkvForPlayback body in a finally that clears mkvPrepareInFlight', () => {
    // Ten early returns — two `emit('close')` pairs, the external-open failure,
    // and the bails — every one of which has to clear the flag.
    const set = PREPARE_MKV.indexOf('mkvPrepareInFlight = true')
    const tryIdx = PREPARE_MKV.indexOf('try {', set)
    const finallyIdx = PREPARE_MKV.indexOf('} finally {')
    expect(set).toBeGreaterThan(-1)
    expect(tryIdx).toBeGreaterThan(set)
    expect(finallyIdx).toBeGreaterThan(tryIdx)
    expect(PREPARE_MKV.indexOf('mkvPrepareInFlight = false', finallyIdx)).toBeGreaterThan(
      finallyIdx
    )
    // The `finally` must be the last thing in the function, i.e. no return sits
    // outside it.
    expect(PREPARE_MKV.indexOf('return', finallyIdx)).toBe(-1)
  })
})

describe('#280 (4) — the unmount side of the compensating cleanup', () => {
  it('sets unmounted first in onBeforeUnmount, above the async saveProgress', () => {
    const body = unmountedBody()
    const flag = body.indexOf('unmounted = true')
    const save = body.indexOf('saveProgress(true)')
    expect(flag).toBeGreaterThan(-1)
    expect(save).toBeGreaterThan(flag)
  })

  it('widens the teardown cleanup with mkvPrepareInFlight', () => {
    // Covers the window where main registered and spawned a session but the
    // reply that assigns `streamSessionId` has not landed — both other terms
    // read false there and the ffmpeg was orphaned.
    expect(unmountedBody()).toContain(
      'if (remuxedPath.value || hadActiveStream || mkvPrepareInFlight) {'
    )
  })

  it('keeps the blanket cleanup synchronous in the hook, never after an await', () => {
    // `playerCleanupRemux` kills EVERY registered session. It is safe here only
    // because it runs before any successor `PlayerView` can mount; a
    // post-`await` compensator would SIGKILL the next player's session.
    const body = unmountedBody()
    expect(body).not.toContain('await ')
    expect(body).toContain('window.api.playerCleanupRemux();')
  })

  it('keeps the hevcPromptResolver unblock running regardless of the flag', () => {
    // It is a teardown obligation: an awaiting `prepareMkvForPlayback` cannot
    // unwind without it.
    const body = unmountedBody()
    const flag = body.indexOf('unmounted = true')
    const unblock = body.indexOf('if (hevcPromptResolver) {')
    expect(unblock).toBeGreaterThan(flag)
    expect(body.slice(flag, unblock)).not.toContain('return')
  })
})

describe("#280 (4) — the onMounted tail and the continuations' orphan subtitle workers", () => {
  it('checks unmounted before initWebGPU, not after', () => {
    // `initWebGPU()` allocates a `GPUDevice` whose only release is
    // `a4k.destroy()`, which already ran at unmount. A check "somewhere in the
    // tail" is exactly the bug.
    const body = mountedBody()
    const initWebGpu = body.indexOf('await a4k.initWebGPU();')
    expect(initWebGpu).toBeGreaterThan(-1)
    const bailAbove = body.lastIndexOf('if (unmounted) return;', initWebGpu)
    expect(bailAbove).toBeGreaterThan(-1)
    // Nothing may await between that bail and the allocation.
    expect(body.slice(bailAbove, initWebGpu)).not.toContain('await ')
  })

  it('checks unmounted after every await in the onMounted tail', () => {
    const body = mountedBody()
    // Stops at the nested `onVideoReady` closure — its `await` is inside its
    // own async function, driven by a `loadedmetadata` event the discarded
    // element can no longer fire.
    const tail = body.slice(
      body.indexOf('await prepareMkvForPlayback(props.filePath)'),
      body.indexOf('const onVideoReady = async')
    )
    const awaits = [...tail.matchAll(/await /g)].map((m) => m.index!)
    for (const at of awaits) {
      const next = awaits.find((i) => i > at) ?? tail.length
      const bail = tail.indexOf('if (unmounted) return;', at)
      expect(bail, `no bail between the await at ${at} and the next one`).toBeGreaterThan(-1)
      expect(bail).toBeLessThan(next)
    }
  })

  it('guards all four initSubtitles sites in the two continuations', () => {
    // Four, not two: the streaming-fallback branches of `selectTranslation` and
    // `goToEpisode` do the same thing as their local-file branches, against the
    // same `video` const, after a `playerGetStreamUrl` network round trip — so
    // the unmount window there is *wider*. `SubtitlesOctopus` is a Web Worker +
    // canvas whose only disposer, `destroySubtitles()`, already ran at unmount.
    const continuations = [
      slice('async function selectTranslation', 'async function goToEpisode'),
      slice('async function goToEpisode', 'function cancelAutoAdvance')
    ]
    let guarded = 0
    for (const body of continuations) {
      const sites = [...body.matchAll(/initSubtitles\(video\)/g)]
      expect(sites).toHaveLength(2)
      for (const site of sites) {
        // The guard is the enclosing `if`, which is on the same line for one
        // pair of sites and on the line above for the other.
        const condition = body.slice(body.lastIndexOf('if (', site.index!), site.index!)
        expect(condition, `unguarded initSubtitles at offset ${site.index}`).toContain('!unmounted')
        guarded++
      }
    }
    expect(guarded).toBe(4)
  })
})
