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

/** Only `//`-prefixed whole lines are stripped, so prose inside one can't satisfy a scan; a trailing `// …` or any line of a block comment still can. */
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

/**
 * The ladder does not stop at `prepareMkvForPlayback`'s boundary: these two
 * continuations issue blanket `playerCleanupRemux()` calls of their own, each
 * after a suspension point. `cancelHevcTranscode` is deliberately NOT here —
 * its cleanup is the function's first statement with no preceding await, so
 * there is no window to guard.
 */
const CONTINUATIONS: [string, string][] = [
  [
    'selectTranslation',
    stripComments(slice('async function selectTranslation', 'async function goToEpisode'))
  ],
  ['goToEpisode', stripComments(slice('async function goToEpisode', 'function cancelAutoAdvance'))]
]

/**
 * The continuations' own checkpoints. `selectTranslation` / `goToEpisode` have
 * no prepare identity of their own, so theirs stay the plain unmount test.
 */
const BAIL = 'if (unmounted) return'

/**
 * The ladder inside `prepareMkvForPlayback` / `prepareHevcTranscode`. #291
 * generalised those checkpoints from "unmounted" to "unmounted **or**
 * superseded", so the literal they are matched by has to change with them.
 *
 * It is deliberately NOT widened to `'if (unmounted'`, which would match a
 * checkpoint that forgot the supersede term and leave this scan silently not
 * proving the thing #291 exists for. It names the helper instead, and
 * `shouldBail`'s own definition is pinned separately below so the two terms
 * cannot be quietly dropped out of it either. This scan is the only renderer
 * verification there is — `PlayerView` has no mount harness.
 */
const PREPARE_BAIL = 'if (shouldBail(myPrepare))'

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
    // The three `playerCloseStreamSession` entries are #291's targeted unwind —
    // one per checkpoint that can hold a `sessionId` this invocation opened.
    expect(callSites(PREPARE_MKV).map((c) => c.name)).toEqual([
      'window.api.watchProgressGet',
      'window.api.syncplayGetRoomPosition',
      'window.api.playerRemuxMkvStream',
      'window.api.playerCloseStreamSession',
      'prepareHevcTranscode',
      'window.api.playerCloseStreamSession',
      'msePlayer.startMseSession',
      'window.api.playerCloseStreamSession',
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
      'window.api.playerCloseStreamSession',
      'msePlayer.setTranscoding',
      'window.api.playerCloseStreamSession',
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
      const lastBail = body.lastIndexOf(PREPARE_BAIL, index)
      expect(
        lastBail,
        `no \`${PREPARE_BAIL}\` between the preceding await and ${name}(`
      ).toBeGreaterThan(lastAwait)
    }
  })

  it('places the prepareHevcTranscode bail above setTranscoding, as the first statement', () => {
    // Not at either call site: `prepareHevcTranscode` has two entries (the
    // `requiresTranscode` short-circuit and the `always-transcode` prompt
    // choice), and a check at one of them leaves the other open. Above
    // `setTranscoding(true)`, not below, so the flag is not latched on a dead
    // instance either.
    const bail = PREPARE_HEVC.indexOf(PREPARE_BAIL)
    const setTranscoding = PREPARE_HEVC.indexOf('msePlayer.setTranscoding(true)')
    expect(bail).toBeGreaterThan(-1)
    expect(setTranscoding).toBeGreaterThan(bail)
  })

  it('guards askHevcChoice and shellOpenExternalFile from one checkpoint above the choice', () => {
    // The `hevcPromptResolver` unblock in `onBeforeUnmount` is *conditional* —
    // it only fires if a resolver is already installed. A close during the
    // `playerCleanupRemux`/`getSetting` awaits leaves it null, so a prompt
    // opened afterwards is settled by nobody: `prepareMkvForPlayback` never
    // returns, its `finally` never runs, and `mkvPreparesInFlight` stays held.
    const choiceDecl = PREPARE_MKV.indexOf('let choice: HevcPromptChoice')
    const bailAboveChoice = PREPARE_MKV.lastIndexOf(PREPARE_BAIL, choiceDecl)
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
    expect(PREPARE_MKV.lastIndexOf(PREPARE_BAIL, legacy)).toBeGreaterThan(
      precedingAwait(PREPARE_MKV, legacy)
    )
  })

  it("unwinds on { error: 'cancelled' } instead of falling through to the legacy remux", () => {
    // `cancelled` is main's self-reap answer: a cleanup overtook this open. It
    // is NOT an open failure, and without this arm it is indistinguishable from
    // one — it would reach the `MSE stream open failed, falling back to legacy
    // remux` warn and then `runLegacyRemuxIpc`, the one spawn nothing in the
    // codebase can kill once issued. Answering "a cleanup overtook you" with
    // the uninterruptible full-file remux is the worst available reaction.
    //
    // Reachable on a live component in the #291 overlap: an earlier open parked
    // in `probeMkvForMse` while some other path bumps `cleanupGeneration`, so
    // the reply-time re-read answers `cancelled` with the component mounted.
    // See the note on the arm itself in `prepareMkvForPlayback` for the trace —
    // `player-ipc-session-cleanup-race.test.ts` pins main's half, not this one.
    const cancelled = PREPARE_MKV.indexOf("streamResult.error === 'cancelled'")
    const fallbackWarn = PREPARE_MKV.indexOf('MSE stream open failed, falling back to legacy remux')
    const legacy = PREPARE_MKV.indexOf('runLegacyRemuxIpc(')
    expect(cancelled).toBeGreaterThan(-1)
    expect(fallbackWarn).toBeGreaterThan(cancelled)
    expect(legacy).toBeGreaterThan(cancelled)
    // It must return, not merely warn — and nothing may await between the test
    // and the return, or the unwind itself becomes a suspension point.
    const ret = PREPARE_MKV.indexOf('return', cancelled)
    expect(ret).toBeGreaterThan(-1)
    expect(ret).toBeLessThan(fallbackWarn)
    expect(PREPARE_MKV.slice(cancelled, ret)).not.toContain('await ')
  })

  it("renames 'cancelled' on the transcode path too, so no bare string reaches remuxError", () => {
    // The transcode handler answers `{ error: 'cancelled' }` as well, from the
    // reply-time generation re-read in `player:remux-mkv-stream-transcode`.
    // There is no fall-through hazard on this path — the arm returns and there
    // is nothing below it to fall into — so this is purely user-facing: every
    // caller assigns `prep.error` straight to `remuxError.value`, so a bare
    // `cancelled` would be shown verbatim in the player's error UI where the
    // copy path deliberately says `stream cancelled`.
    const arm = PREPARE_HEVC.indexOf("if ('error' in r)")
    const mseOk = PREPARE_HEVC.indexOf('const mseOk')
    expect(arm).toBeGreaterThan(-1)
    expect(mseOk).toBeGreaterThan(arm)
    const body = PREPARE_HEVC.slice(arm, mseOk)
    // Reverting to the pass-through turns this red.
    const renamed = body.match(/r\.error === 'cancelled' \? '([^']+)' : r\.error/)?.[1]
    expect(renamed).toBeTruthy()
    expect(body).not.toMatch(/return \{ ok: false, error: r\.error \}/)
    // Both paths must surface the SAME string — a rename on one side only is
    // the regression this pins, so the copy path's literal is read from the
    // source rather than repeated here. Equality, not `toContain`: `body` holds
    // the `=== 'cancelled'` test itself, so containment is vacuous for exactly
    // the literal that must never be surfaced.
    const copyCancelled = PREPARE_MKV.indexOf("streamResult.error === 'cancelled'")
    const copyReturn = PREPARE_MKV.slice(copyCancelled, PREPARE_MKV.indexOf('}', copyCancelled))
    const copyString = copyReturn.match(/error: '([^']+)'/)?.[1]
    expect(copyString).toBeTruthy()
    expect(copyString).not.toBe('cancelled')
    expect(renamed).toBe(copyString)
  })

  it('bails with { ok: false } so the callers skip initSubtitles on the way out', () => {
    // `{ ok: true }` would fall through to the `initSubtitles(video)` calls in
    // `selectTranslation` / `goToEpisode` and construct an orphan worker.
    expect(SOURCE).toContain(
      "const PLAYER_CLOSED_BAIL = { ok: false, error: 'player closed' } as const;"
    )
  })

  it('wraps the whole prepareMkvForPlayback body in a finally that releases mkvPreparesInFlight', () => {
    // Ten early returns — two `emit('close')` pairs, the external-open failure,
    // and the bails — every one of which has to release the count.
    const set = PREPARE_MKV.indexOf('mkvPreparesInFlight++')
    const tryIdx = PREPARE_MKV.indexOf('try {', set)
    const finallyIdx = PREPARE_MKV.indexOf('} finally {')
    expect(set).toBeGreaterThan(-1)
    expect(tryIdx).toBeGreaterThan(set)
    expect(finallyIdx).toBeGreaterThan(tryIdx)
    expect(PREPARE_MKV.indexOf('mkvPreparesInFlight--', finallyIdx)).toBeGreaterThan(finallyIdx)
    // The `finally` must be the last thing in the function, i.e. no return sits
    // outside it.
    expect(PREPARE_MKV.indexOf('return', finallyIdx)).toBe(-1)
  })
})

/**
 * #291 — two `prepareMkvForPlayback` calls can be in flight at once on a LIVE
 * component (one parked in main's `probeMkvForMse`, above `registerSession`,
 * while the user picks another translation). Neither caller-side conditional
 * fires, both handlers register and spawn, and the loser's ffmpeg is orphaned.
 *
 * The fix is renderer-side supersede, so main still legitimately registers two
 * sessions — see the characterization test in
 * `test/services/player-ipc-session-cleanup-race.test.ts`. This block is the
 * only verification the renderer half gets: a behavioral test would have to
 * re-implement the epoch logic and would then pass regardless of what
 * `PlayerView` does.
 */
describe('#291 — supersede identity and the targeted unwind', () => {
  /** Every `if (shouldBail(myPrepare)) { … }` block body in the two functions. */
  function bailBlocks(body: string): string[] {
    const out: string[] = []
    let at = body.indexOf(PREPARE_BAIL)
    while (at > -1) {
      const open = body.indexOf('{', at)
      const semi = body.indexOf(';', at)
      // Single-statement form (`… return PLAYER_CLOSED_BAIL;`) has no block.
      if (open > -1 && open < semi) {
        let depth = 0
        let i = open
        for (; i < body.length; i++) {
          if (body[i] === '{') depth++
          else if (body[i] === '}' && --depth === 0) break
        }
        out.push(body.slice(open, i + 1))
      } else {
        out.push(body.slice(at, semi + 1))
      }
      at = body.indexOf(PREPARE_BAIL, at + 1)
    }
    return out
  }

  it('keeps prepareEpoch component-scope — a per-instance top-level let in <script setup>', () => {
    // Module scope (a second plain `<script>` block, or a hoist into an imported
    // module) would make two live `PlayerView` instances share one counter, and
    // each would then supersede the other's opens. A top-level `let` inside
    // `<script setup>` is per-instance, which is exactly what `unmounted` and
    // `mkvPreparesInFlight` already rely on.
    // A plain line scan, not a tag regex: SFC top-level blocks always start at
    // column 0, so this cannot be satisfied by prose inside a comment — and it
    // sidesteps CodeQL's `js/bad-tag-filter`, which reads any hand-rolled
    // `<script…>` pattern as an HTML sanitiser missing its `<SCRIPT>` variant.
    const scripts = SOURCE.split('\n').filter((l) => l.startsWith('<script'))
    expect(scripts).toEqual(['<script setup lang="ts">'])
    const setupStart = SOURCE.indexOf('<script setup lang="ts">')
    const setupEnd = SOURCE.indexOf('</script>', setupStart)
    const decl = SOURCE.indexOf('let prepareEpoch = 0;')
    expect(decl).toBeGreaterThan(setupStart)
    expect(decl).toBeLessThan(setupEnd)
  })

  it('tests BOTH terms in shouldBail — unmounted and the epoch compare', () => {
    // The whole point of routing every checkpoint through one helper: dropping
    // either term here is a single-line edit that would otherwise leave 15
    // checkpoints reading correct while proving nothing.
    const helper = stripComments(slice('function shouldBail(', '\n}'))
    expect(helper).toContain('unmounted')
    expect(helper).toContain('myPrepare !== prepareEpoch')
    expect(helper).toContain('||')
  })

  it('takes the supersede id at prepareMkvForPlayback entry, and only there', () => {
    // `prepareHevcTranscode` is a CONTINUATION of the same prepare, so it takes
    // `myPrepare` as a parameter. Re-taking an epoch there would make the
    // transcode supersede its own copy-path caller.
    expect([...SOURCE.matchAll(/\+\+prepareEpoch/g)]).toHaveLength(1)
    expect(PREPARE_MKV).toContain('const myPrepare = ++prepareEpoch;')
    expect(PREPARE_HEVC).not.toContain('prepareEpoch')
    expect(PREPARE_HEVC).toMatch(/myPrepare: number/)
    // Both call sites thread it through.
    expect([...PREPARE_MKV.matchAll(/prepareHevcTranscode\([^)]*myPrepare\)/g)]).toHaveLength(2)
  })

  it('leaves no bare `unmounted` checkpoint behind in either function', () => {
    // A checkpoint that kept only the unmount term would pass the guard scan's
    // `lastAwait` ordering via a *neighbouring* bail while itself proving
    // nothing about supersede.
    expect(PREPARE_MKV).not.toContain(BAIL)
    expect(PREPARE_HEVC).not.toContain(BAIL)
  })

  it.each([
    ['prepareMkvForPlayback', PREPARE_MKV],
    ['prepareHevcTranscode', PREPARE_HEVC]
  ])('puts a supersede bail above every in-function blanket cleanup in %s', (_name, body) => {
    // THE failure mode most likely to be missed. These two blanket kills are not
    // on the "unwind path" as such — they sit inside the two functions, below
    // several awaits, on the `!mseOk` branches. A superseded prepare falling
    // into either reaps the WINNER's session and unlinks the shared tmpDir.
    const sites = [...body.matchAll(/window\.api\.playerCleanupRemux\(/g)]
    expect(sites).toHaveLength(1)
    for (const site of sites) {
      const lastBail = body.lastIndexOf(PREPARE_BAIL, site.index!)
      expect(lastBail, 'no supersede bail above the blanket cleanup').toBeGreaterThan(-1)
      expect(lastBail).toBeGreaterThan(precedingAwait(body, site.index!))
      // …and it is THIS branch's own guard, not one inherited from the branch
      // above. Deleting the bail that sits over the kill would otherwise leave
      // `lastIndexOf` pointing at the `startMseSession` checkpoint on the
      // success branch, which guards nothing here.
      const between = body.slice(lastBail, site.index!)
      expect(between).not.toContain('msePlayer.startMseSession')
      // …and it is the bail that unwinds, not a fall-through: the block between
      // the guard and the kill must contain the targeted close, never nothing.
      expect(between).toContain('playerCloseStreamSession')
    }
  })

  it('puts the transcode !mseOk bail above setTranscoding(false), not below it', () => {
    // Ordering, not mere presence. Both statements on this branch belong to the
    // WINNER once this invocation is superseded: the blanket kill would reap the
    // winner's session and unlink the shared tmpDir, and the flag clear would
    // switch off its live transcode overlay. So the guard is the branch's first
    // statement, above both.
    const branch = PREPARE_HEVC.slice(
      PREPARE_HEVC.indexOf('if (!mseOk)'),
      PREPARE_HEVC.indexOf('msePlayer.startMseSession')
    )
    const bail = branch.indexOf(PREPARE_BAIL)
    expect(bail).toBeGreaterThan(-1)
    expect(branch.indexOf('msePlayer.setTranscoding(false)')).toBeGreaterThan(bail)
    expect(branch.indexOf('window.api.playerCleanupRemux(')).toBeGreaterThan(bail)
  })

  it('unwinds through the targeted close, never the blanket cleanup', () => {
    for (const body of [PREPARE_MKV, PREPARE_HEVC]) {
      for (const block of bailBlocks(body)) {
        expect(block).not.toContain('playerCleanupRemux(')
      }
    }
  })

  it('issues the close fire-and-forget, so it is not a suspension point', () => {
    // An AWAITED close inside a bail block becomes the `lastAwait` for the next
    // guarded call below it while the bail literal sits above — which fails the
    // `lastBail > lastAwait` scan at every checkpoint at once. The tempting
    // repair is to weaken that scan, which is precisely what must not happen.
    // Nothing runs after the unwind, so there is nothing to order against.
    for (const body of [PREPARE_MKV, PREPARE_HEVC]) {
      for (const block of bailBlocks(body)) {
        if (!block.includes('playerCloseStreamSession')) continue
        expect(block).toContain('void window.api.playerCloseStreamSession(')
        expect(block).toContain('.catch(() => {})')
        expect(block).not.toContain('await ')
      }
    }
  })

  it("narrows on 'sessionId' in …, not on !('error' in …)", () => {
    // The copy-path reply is a THREE-way union: the `{ requiresTranscode: true }`
    // arm carries no id (main short-circuits before spawning on it), so
    // `!('error' in streamResult)` would try to close a session that was never
    // opened. It is also rejected by the typechecker — but by `vue-tsc`
    // specifically (`npm run typecheck:web`), with TS2339 on the
    // `{ requiresTranscode: true }` arm. Plain `tsc` does not read the SFC's
    // `<script setup>` at all, so `npm run typecheck:node` stays green on it.
    const closes = [...PREPARE_MKV.matchAll(/playerCloseStreamSession/g)]
    expect(closes).toHaveLength(3)
    for (const c of closes) {
      const bail = PREPARE_MKV.lastIndexOf(PREPARE_BAIL, c.index!)
      const guard = PREPARE_MKV.lastIndexOf("'sessionId' in streamResult", c.index!)
      expect(guard, 'close is not narrowed by a `sessionId` in-check').toBeGreaterThan(bail)
      expect(guard).toBeLessThan(c.index!)
    }
    // The transcode reply is a two-way union, but it uses the same narrowing so
    // there is one shape to read, not two.
    expect(PREPARE_HEVC).toContain("if ('sessionId' in r)")
  })

  it('mutates no other shared renderer state on the unwind', () => {
    // Both halves of the earlier draft's "clear the flags on the unwind" were
    // wrong. `mkvBuffering` is unreachable for a loser (no await between the
    // checkpoint above it and the assignment). `transcodingHevc` is already
    // cleared by the superseder's own `resetMseState()` — and clearing it here
    // would drop the WINNER's live transcode overlay, since the unwind runs
    // strictly later than the winner's state writes.
    for (const body of [PREPARE_MKV, PREPARE_HEVC]) {
      for (const block of bailBlocks(body)) {
        expect(block).not.toContain('mkvBuffering')
        expect(block).not.toContain('setTranscoding')
        expect(block).not.toContain('remuxError')
      }
    }
  })

  it('never surfaces the unwind result in remuxError at any of the three callers', () => {
    // For the #280 unmount half the write landed on discarded state. A
    // superseded open unwinds on a LIVE component, so `player closed` would
    // replace the winner's video with an error banner.
    const src = stripComments(SOURCE)
    // Three call sites, all routed through the guard.
    expect([...src.matchAll(/reportPrepareError\(prep\)/g)]).toHaveLength(3)
    // The one surviving direct write is the guard's own, after the early return.
    const writes = [...src.matchAll(/remuxError\.value = prep\.error/g)]
    expect(writes).toHaveLength(1)
    const guard = stripComments(slice('function reportPrepareError(', '\n}'))
    expect(guard).toContain('if (prep === PLAYER_CLOSED_BAIL) return;')
    expect(guard.indexOf('PLAYER_CLOSED_BAIL')).toBeLessThan(guard.indexOf('remuxError.value'))
  })

  /** The `if (!prep.ok) { … }` arm inside one of the two continuations. */
  function unwindArm(fnStart: string, fnEnd: string): string {
    const body = stripComments(slice(fnStart, fnEnd))
    const at = body.indexOf('if (!prep.ok) {')
    expect(at, `missing !prep.ok arm in ${fnStart}`).toBeGreaterThan(-1)
    let depth = 0
    let i = body.indexOf('{', at)
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++
      else if (body[i] === '}' && --depth === 0) break
    }
    return body.slice(at, i + 1)
  }

  it('releases the caller-side flags on an unwind only while it still owns them', () => {
    // The caller-side blind spot the in-function bail-block scan structurally
    // cannot see: `reportPrepareError` covers `remuxError`, but each `!prep.ok`
    // arm also releases its own flow's flag one frame up, and on the supersede
    // half that arm runs on a LIVE component.
    //
    // The guard is an OWNERSHIP compare, deliberately NOT
    // `prep !== PLAYER_CLOSED_BAIL`: that test says only THAT this run was
    // superseded, never BY WHOM. `selectTranslation` and `goToEpisode`
    // supersede each other freely and neither touches the other's flag, so
    // skipping the clear on every superseded unwind strands the flag for the
    // life of the component — `navigating` stuck true disables prev/next and
    // makes every later `goToEpisode` a no-op at its own re-entrancy guard.
    const callers = [
      {
        arm: unwindArm('async function selectTranslation(', '\nasync function goToEpisode('),
        flag: 'switchingTranslation',
        set: 'const mySwitch = ++translationEpoch;',
        guard: 'if (translationEpoch === mySwitch) switchingTranslation.value = false;'
      },
      {
        arm: unwindArm('async function goToEpisode(', '\nfunction cancelAutoAdvance('),
        flag: 'navigating',
        set: 'const myNav = ++navigationEpoch;',
        guard: 'if (navigationEpoch === myNav) navigating.value = false;'
      }
    ]
    for (const c of callers) {
      expect(c.arm).toContain('reportPrepareError(prep)')
      // Exactly one clear in the arm, and it is the guarded one.
      expect([...c.arm.matchAll(new RegExp(`${c.flag}\\.value = false`, 'g'))]).toHaveLength(1)
      expect(c.arm).toContain(c.guard)
      expect(c.arm).not.toContain('PLAYER_CLOSED_BAIL')
      // The token the compare reads is taken where the flag is SET, so the
      // compare cannot be vacuously true.
      expect(stripComments(SOURCE)).toContain(c.set)
    }
  })

  it('stops the syncplay episode walk at the first translation pick made after it began', () => {
    // `goToEpisode`'s unwind releases `navigating` whenever it still owns it —
    // it must, or the flag strands — so the walk needs its own term for "the
    // user superseded me". Without it the loop reads the released flag as
    // permission to take another step, that step supersedes the translation
    // switch in turn, and the user's pick is dropped silently.
    //
    // The term must read the MONOTONIC `translationEpoch`, not the transient
    // `switchingTranslation` flag: a pick taking the stream fall-back is one
    // `playerGetStreamUrl` round trip and clears the flag in its own
    // `nextTick`, which lands before a step parked on an MSE open resumes — so
    // the loop would re-read both flags as false and step anyway.
    const handler = stripComments(
      slice('function handleRemoteEpisodeChange(', '\n// Disposers for the non-syncplay')
    )
    // Sampled ONCE, in the handler and above the loop, so the compare cannot go
    // vacuous the way a per-iteration re-sample would.
    const sample = 'const walkTranslation = translationEpoch;'
    expect(handler).toContain(sample)
    expect(handler.indexOf(sample)).toBeLessThan(handler.indexOf('const stepTowards ='))
    const walk = stripComments(slice('const stepTowards =', 'stepTowards()'))
    expect(walk).toContain('activeEpisodeIndex.value !== idx')
    expect(walk).toContain('!navigating.value')
    expect(walk).toContain('translationEpoch === walkTranslation')
    expect(walk).not.toContain('switchingTranslation')
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

  it('widens the teardown cleanup with the mkvPreparesInFlight COUNT, not a boolean latch', () => {
    // Covers the window where main registered and spawned a session but the
    // reply that assigns `streamSessionId` has not landed — both other terms
    // read false there and the ffmpeg was orphaned.
    //
    // A counter because nothing serialises `prepareMkvForPlayback`'s three call
    // sites and the MSE open is behind no blocking overlay (`remuxing` covers
    // only the legacy full-remux path, `mkvBuffering` is a toast). While
    // `onMounted`'s open is parked in main's `probeMkvForMse` the user can pick
    // another downloaded `.mkv` translation; the inner call's `finally` would
    // clear a boolean out from under the still-in-flight outer open, and if it
    // set neither `streamSessionId` nor `remuxedPath` (early `{ error }`,
    // failed legacy remux, external-open or cancel arms) a close at that moment
    // read all three terms false and orphaned the outer ffmpeg.
    //
    // Pinned as shape, not as behavior: `prepareMkvForPlayback` is a closure
    // inside `<script setup>` with no mount harness (see this file's header),
    // so there is no way to hold two of them open at once from a test. The four
    // assertions below are chosen to be jointly sufficient — a boolean cannot
    // satisfy all of them.
    expect(unmountedBody()).toContain(
      'if (remuxedPath.value || hadActiveStream || mkvPreparesInFlight > 0) {'
    )
    // The declaration is a number, and nothing anywhere assigns it a boolean.
    expect(SOURCE).toContain('let mkvPreparesInFlight = 0;')
    expect(SOURCE).not.toContain('mkvPreparesInFlight = true')
    expect(SOURCE).not.toContain('mkvPreparesInFlight = false')
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
    //
    // The `CONTINUATIONS` bodies are comment-stripped, and that is load-bearing
    // here: the count below is pinned over a regex that ordinary prose matches,
    // so a *whole-line* `//` in `PlayerView.vue` naming `initSubtitles(video)`
    // would otherwise count as a site and fail this. It narrows the hazard
    // without closing it — `stripComments` only blanks whole-line `//`, so a
    // *trailing* `// …`, or any line of a block comment, naming the literal
    // still counts as a site (#312).
    let guarded = 0
    for (const [name, body] of CONTINUATIONS) {
      const sites = [...body.matchAll(/initSubtitles\(video\)/g)]
      expect(sites, `${name} initSubtitles site count`).toHaveLength(2)
      for (const site of sites) {
        // The guard is the enclosing `if`, which is on the same line for one
        // pair of sites and on the line above for the other.
        const condition = body.slice(body.lastIndexOf('if (', site.index!), site.index!)
        expect(condition, `${name} unguarded initSubtitles at offset ${site.index}`).toContain(
          '!unmounted'
        )
        guarded++
      }
    }
    expect(guarded).toBe(4)
  })
})

describe('#280 (4) — the ladder extends to the continuations own blanket cleanups', () => {
  // The third slice. `prepareMkvForPlayback` / `prepareHevcTranscode` are not
  // the only places a resumed continuation can reach `playerCleanupRemux()`:
  // `selectTranslation` and `goToEpisode` issue four of their own, every one of
  // them after a suspension point.
  //
  // Why it is reachable, and why the `initSubtitles` guards did not cover it:
  // `resetMseState()` clears `streamSessionId` at unmount, so for the MSE
  // population the `if (remuxedPath.value || streamSessionId.value)` condition
  // reads false and nothing fires. `remuxedPath` is NOT cleared — nothing in
  // `onBeforeUnmount` calls `clearRemux()` — so on the legacy-remux population
  // the condition is still true on a dead instance and the blanket kill fires
  // from a resumed continuation, SIGKILLing a successor `PlayerView`'s session
  // and `unlinkSync`ing its tmpDir out from under it. That is precisely the
  // post-`await` blanket kill the unmount hook is written to avoid.
  const CLEANUP_RE = /window\.api\.playerCleanupRemux\(/g

  it('pins the closed set: two blanket cleanups in each continuation', () => {
    // A fifth site added to either function without a bail fails the rule
    // below; this assertion is what stops the *inventory* decaying quietly, the
    // same closed-set discipline the `prepareMkvForPlayback` scan uses.
    for (const [name, body] of CONTINUATIONS) {
      expect([...body.matchAll(CLEANUP_RE)], `${name} cleanup site count`).toHaveLength(2)
    }
  })

  it.each(CONTINUATIONS)(
    'guards every blanket playerCleanupRemux in %s against the preceding await',
    (_name, body) => {
      // Delete any one of the four bails and this goes red naming its site.
      for (const site of [...body.matchAll(CLEANUP_RE)]) {
        const lastAwait = precedingAwait(body, site.index!)
        const lastBail = body.lastIndexOf(BAIL, site.index!)
        expect(lastAwait, 'expected a suspension point before the cleanup').toBeGreaterThan(-1)
        expect(
          lastBail,
          `no \`${BAIL}\` between the preceding await and the blanket playerCleanupRemux at ${site.index}`
        ).toBeGreaterThan(lastAwait)
      }
    }
  )

  it('leaves cancelHevcTranscode out of scope — its cleanup precedes every await', () => {
    // It looks like the same shape but is not: the cleanup is the function's
    // FIRST statement, so no continuation can resume into it. Pinning that here
    // stops a future author "fixing" it by reflex, and fails if an await is
    // ever introduced above the cleanup.
    const body = stripComments(slice('async function cancelHevcTranscode', 'function formatTime'))
    const cleanup = body.indexOf('window.api.playerCleanupRemux(')
    expect(cleanup).toBeGreaterThan(-1)
    // `precedingAwait` excludes the cleanup's own `await` — -1 means there is
    // no earlier suspension point at all, so no continuation resumes into it.
    expect(precedingAwait(body, cleanup)).toBe(-1)
  })
})

describe('#311 — the ladder checkpoints the stream fall-back in BOTH continuations', () => {
  // The rule the #280 ladder actually carries is "bail after every await whose
  // continuation resumes with no checkpoint of its own". `playerGetStreamUrl`
  // is not the widest window either continuation has — `prepareMkvForPlayback`
  // is — but it is the widest *unchecked* one: that await comes back through
  // `shouldBail`, this one returns a stream URL whether or not the component is
  // still alive. `selectTranslation` had the checkpoint and `goToEpisode` did
  // not, which is the asymmetry #311 closes; scanning both from one `it.each`
  // is what stops them drifting apart again.
  const STREAM_URL_RE = /await window\.api\.playerGetStreamUrl\(/g

  it.each(CONTINUATIONS)(
    'bails immediately after every playerGetStreamUrl await in %s',
    (name, body) => {
      const sites = [...body.matchAll(STREAM_URL_RE)]
      // The inventory is pinned, not just looped over: "for every await, assert
      // a bail" passes vacuously over an empty match list, so a rename of the
      // channel or a move behind a helper would turn this quietly green on the
      // exact site it exists to protect.
      expect(sites, `${name} playerGetStreamUrl site count`).toHaveLength(1)
      for (const site of sites) {
        const semi = body.indexOf(';', site.index!)
        expect(semi, `unterminated playerGetStreamUrl statement in ${name}`).toBeGreaterThan(-1)
        // Asserted before slicing: `indexOf` returns -1 when the bail is
        // missing, and `slice(semi + 1, -1)` is "everything but the last
        // character", which is non-whitespace — red for the wrong reason and
        // reported as a several-hundred-character diff.
        const bail = body.indexOf(BAIL, semi)
        expect(
          bail,
          `no \`${BAIL}\` after the playerGetStreamUrl await in ${name}`
        ).toBeGreaterThan(-1)
        // "Immediately after", spelled as an assertion: a bare reachability
        // check would also accept a bail thirty lines down, which is the
        // failure this scan is about. Comments are already stripped from these
        // bodies; the blank lines they leave behind are why this is a
        // whitespace test rather than an offset compare.
        expect(
          body.slice(semi + 1, bail),
          `statements between the playerGetStreamUrl await and its \`${BAIL}\` in ${name}`
        ).toMatch(/^\s*$/)
      }
    }
  )
})

describe('#280 (3) — the diagnostic element listeners are removed at teardown', () => {
  const TYPES = ['waiting', 'stalled', 'error', 'timeupdate', 'seeking', 'seeked']

  it('registers all six from one table and removes the same table', () => {
    // One table drives both directions, so an added listener cannot be
    // registered without also being removed.
    const table = slice('const DIAGNOSTIC_LISTENERS', 'onMounted(')
    for (const type of TYPES) expect(table).toContain(`['${type}',`)
    expect(mountedBody()).toContain(
      'for (const [type, handler] of DIAGNOSTIC_LISTENERS) v.addEventListener(type, handler);'
    )
    expect(unmountedBody()).toContain(
      'for (const [type, handler] of DIAGNOSTIC_LISTENERS) video.removeEventListener(type, handler);'
    )
  })

  it('removes them before the teardown pause', () => {
    // The pause can otherwise fire a final `waiting`/`seeking` into
    // `maybeRespawnForUnbufferedPosition()` after `resetMseState()` is queued.
    const body = unmountedBody()
    const remove = body.indexOf('video.removeEventListener(type, handler)')
    const pause = body.indexOf('video.pause();')
    expect(remove).toBeGreaterThan(-1)
    expect(pause).toBeGreaterThan(remove)
  })

  it('reads the element off e.currentTarget, never videoRef.value', () => {
    // Going through the ref would make removal ordering versus Vue's
    // ref-nulling load-bearing for no reason.
    const handlers = stripComments(slice('const videoOf = (e: Event)', 'onMounted('))
    expect(handlers).toContain('e.currentTarget as HTMLVideoElement')
    expect(handlers).not.toContain('videoRef.value')
  })

  it('empties the element with removeAttribute, not src = ""', () => {
    const body = unmountedBody()
    expect(body).toContain("video.removeAttribute('src');")
    expect(body).not.toContain("video.src = '';")
    expect(body.indexOf("video.removeAttribute('src');")).toBeLessThan(
      body.indexOf('video.load();')
    )
  })
})
