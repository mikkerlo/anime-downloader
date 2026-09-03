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

// The `<script setup>` region, and the input every whole-source scan below
// reads. Module scope rather than local to the one `it()` that used to own
// these two `indexOf` lines, because `SETUP` is built from them and the
// assertion that makes `SETUP` well-defined — `expect(scripts).toEqual([…])`,
// which rules out a second top-level `<script>` block — has to sit on the same
// values. Recomputing them beside `SETUP` would leave the pair that is asserted
// about and the pair that feeds `SETUP` free to drift with nothing reading both.
//
// Narrowing matters because `stripComments` is quote-aware and `<template>` is
// not JavaScript: its apostrophes are not string delimiters (`couldn't` inside
// an HTML comment is a live unmatched one), so a whole-file pass desynchronises
// there and then includes or excludes `<style>` block comments by accident.
// Dropping the non-script text also closes the false-POSITIVE direction — a
// needle matching inside `<style>` comment prose would satisfy a scan vacuously.
// Every needle in this file is script-side; the two literals that match
// `PlayerView.vue` only outside the region are `'</script>'` (used below against
// raw `SOURCE`, which stays raw) and `'else-if'` (read over App.vue's template).
const setupStart = SOURCE.indexOf('<script setup lang="ts">')
const setupEnd = SOURCE.indexOf('</script>', setupStart)
const SETUP = SOURCE.slice(setupStart, setupEnd)

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

/**
 * Every comment is stripped — a whole-line `//`, a trailing `// …` after code,
 * and block comments (their newlines kept, so line structure survives) — so
 * prose that names a call site can't satisfy a scan whatever style it is
 * written in. A line of a block comment used to still count as a site; #302
 * inverted that rather than merely widening it.
 *
 * The one deliberate carve-out, and the only part of this not inferable from
 * the helper's name: a `//` inside a STRING LITERAL is preserved.
 * `PlayerView.vue` returns `'anime-video://' + encodeURIComponent(…)` twice, and
 * a naive trailing rule truncates both mid-expression — silently, because no
 * scan asserts on those lines, so the helper would quietly mangle the input of
 * every scan that reads it. Whoever later collapses this back into a two-line
 * regex will read this docstring rather than the fixture that pins it.
 *
 * Quote tracking is enough and a tokenizer is not needed at this sha: the only
 * `//` occurrences that are not whole-line comments are two genuine trailing
 * comments and those two string literals, no template literal contains `//`,
 * and the one regex literal in the file (`/hvc1|hev1/i`) carries no quote, `//`
 * or `/*`, so it is inert here. A regex literal containing any of those WOULD
 * desynchronise this scan, and silently — which is why this clause is a fact
 * about the current file, not a property anything enforces.
 *
 * Feed it JavaScript, never the whole SFC — `SETUP`, or a slice of it.
 */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch
      i++
      while (i < text.length) {
        if (text[i] === '\\') {
          out += text.slice(i, i + 2)
          i += 2
          continue
        }
        out += text[i]
        i++
        if (text[i - 1] === ch) break
      }
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? text.length : close + 2
      // Newlines only: blanking the body in place keeps every downstream
      // `indexOf` roughly line-aligned with the file it came from.
      out += text.slice(i, end).replace(/[^\n]/g, '')
      i = end
      continue
    }
    out += ch
    i++
  }
  return out
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
    //
    // This assertion is also what makes the module-scope `SETUP` well-defined:
    // a second top-level `<script>` block would leave `SETUP` covering only the
    // first one and silently narrow every scan pointed at it. The bounds are
    // the module-scope pair for exactly that reason — see their comment.
    const scripts = SOURCE.split('\n').filter((l) => l.startsWith('<script'))
    expect(scripts).toEqual(['<script setup lang="ts">'])
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
    const src = stripComments(SETUP)
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
      expect(stripComments(SETUP)).toContain(c.set)
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

describe('#302 — every caller-side flag clear is guarded by ownership', () => {
  // #291 gave `switchingTranslation` / `navigating` an ownership token where
  // each flag is SET, but only one clear per flow read it — the `!prep.ok`
  // unwind arm above. The scope line is "can another run of the SAME flow be in
  // flight when this clear executes", NOT "is there an await between here and
  // my last resume point": the second test establishes only that no NEW run was
  // admitted since the resume and says nothing about one already parked.
  // `selectTranslation` has no re-entrancy guard at all (its early return only
  // stops a re-pick of the already-active translation) and `goToEpisode`'s sits
  // above `await saveProgress(true)`, so both flows overlap without any of
  // #291's machinery and the loser landing first clears the winner's flag.
  //
  // A closed-set classifier rather than eight literal `toContain`s, so a ninth
  // clear added later cannot slip in unguarded.
  //
  // Every scan here reads comment-stripped, script-region source. The
  // membership half below compares INDICES, and `stripComments` shortens the
  // text, so its bounds must be computed in the same space as the matches they
  // are tested against — `stripComments(SETUP)`, named rather than left as "the
  // stripped source". Note the opposite order from every other scan in this
  // file, which strips a raw slice: `slice()` keeps indexing raw `SOURCE` on
  // purpose, because one of its callers passes an own-line `//` as an END
  // needle and stripping would delete it out from under `indexOf`.
  const SRC = stripComments(SETUP)

  /** Backward-match the `(` that opens the `)` at `close`. */
  function openParen(src: string, close: number): number {
    let depth = 0
    for (let i = close; i >= 0; i--) {
      if (src[i] === ')') depth++
      else if (src[i] === '(' && --depth === 0) return i
    }
    return -1
  }

  /**
   * Strict: `function …(…) {` or `… => {` only. `if (`, `for (`, `try`,
   * `catch` and bare blocks are NOT function bodies, and the outward walk
   * steps over them.
   *
   * The looser reading — "nearest enclosing block" — classifies all eight
   * sites identically today and is still wrong. A clear placed inside the
   * `if (v) { … }` block this change standardises both `selectTranslation`
   * callbacks on would have `if (v) {` as its nearest enclosing block, which is
   * not preceded by `nextTick(`, so the misread routes it to branch (a) and
   * demands a compare the callback's early return already provides. Relaxing it
   * the other way — "any opener up to the function boundary" — is wrong too: a
   * clear inside a NON-`nextTick` callback, such as the one-shot
   * `loadedmetadata` listener if it ever grows a braced body, runs after the
   * outer guard has already passed and genuinely needs its own compare.
   */
  function isFunctionBody(src: string, brace: number): boolean {
    const head = src.slice(0, brace).trimEnd()
    if (head.endsWith('=>')) return true
    const close = head.lastIndexOf(')')
    if (close === -1) return false
    // Only a TS return-type annotation may sit between the parameter list and
    // the brace (`): Promise<void> {`).
    if (!/^\s*(:\s*[^;{}()]*)?$/.test(head.slice(close + 1))) return false
    const open = openParen(src, close)
    return open > -1 && /\bfunction\s*[A-Za-z0-9_$]*\s*$/.test(src.slice(0, open))
  }

  /** The function body at `brace` is a `(…) => {` handed straight to `nextTick(`. */
  function isNextTickBody(src: string, brace: number): boolean {
    const head = src.slice(0, brace).trimEnd()
    if (!head.endsWith('=>')) return false
    const params = head.slice(0, -2).trimEnd()
    if (!params.endsWith(')')) return false
    const open = openParen(src, params.length - 1)
    return open > -1 && src.slice(0, open).trimEnd().endsWith('nextTick(')
  }

  /**
   * Walks OUTWARD from `at` to an enclosing `{`, never inward from a known
   * opener and never by searching for one. `if (!resolvedTr) {` occurs FOUR
   * times inside `goToEpisode` — the first three are the resolution-chain
   * fallbacks (b)/(c)/(d) and none of them contains a clear — so a matcher that
   * searches for that string finds the wrong block.
   */
  function enclosing(src: string, at: number, functionsOnly: boolean): number {
    let depth = 0
    for (let i = at; i >= 0; i--) {
      const ch = src[i]
      if (ch === '}') depth++
      else if (ch === '{') {
        if (depth > 0) depth--
        else if (!functionsOnly || isFunctionBody(src, i)) return i
      }
    }
    return -1
  }

  function boundsOf(startNeedle: string, endNeedle: string): [number, number] {
    const start = SRC.indexOf(startNeedle)
    expect(start, `missing slice start: ${startNeedle}`).toBeGreaterThan(-1)
    const end = SRC.indexOf(endNeedle, start + startNeedle.length)
    expect(end, `missing slice end: ${endNeedle}`).toBeGreaterThan(start)
    return [start, end]
  }

  function callers(): {
    name: string
    flag: string
    guard: string
    early: string
    clears: number
    bare: number
    bounds: [number, number]
  }[] {
    return [
      {
        name: 'selectTranslation',
        flag: 'switchingTranslation',
        guard: 'if (translationEpoch === mySwitch) switchingTranslation.value = false;',
        early: 'if (translationEpoch !== mySwitch) return;',
        clears: 5,
        bare: 0,
        bounds: boundsOf('async function selectTranslation(', '\nasync function goToEpisode(')
      },
      {
        name: 'goToEpisode',
        flag: 'navigating',
        guard: 'if (navigationEpoch === myNav) navigating.value = false;',
        early: 'if (navigationEpoch !== myNav) return;',
        clears: 6,
        bare: 1,
        bounds: boundsOf('async function goToEpisode(', '\nfunction cancelAutoAdvance(')
      }
    ]
  }

  it('strips block and trailing comments, and never a `//` inside a string literal', () => {
    // The carve-out is not hypothetical: `PlayerView.vue` returns
    // `'anime-video://' + encodeURIComponent(…)` twice, and a naive `//.*$`
    // rule truncates both mid-expression. NOTHING in the suite would go red on
    // that — no scan asserts on those two lines — so the helper would silently
    // mangle the input of every scan that reads it until some needle happened
    // to land on a line containing a URL scheme. The helper being the one
    // unpinned input in a change whose whole test story is about naming inputs
    // is the wrong shape to ship.
    const fixture = [
      "const url = 'anime-video://' + encodeURIComponent(p); // trailing prose",
      '/* block prose */ const kept = 1;'
    ].join('\n')
    const out = stripComments(fixture)
    expect(out).toContain("'anime-video://'")
    expect(out).toContain('const kept = 1;')
    expect(out).not.toContain('trailing prose')
    expect(out).not.toContain('block prose')
    // And on the real input every scan in this file reads.
    expect(SRC).toContain("'anime-video://' + encodeURIComponent(")
  })

  it('classifies every flag clear as guarded, or as the one allowed bare site', () => {
    for (const c of callers()) {
      const [start, end] = c.bounds
      const body = SRC.slice(start, end)
      const sites = [...body.matchAll(new RegExp(`${c.flag}\\.value = false`, 'g'))].map(
        (m) => start + m.index!
      )
      // Slice-scoped, not whole-source, and that is load-bearing: a whole-source
      // count would also fire on a clear added in the OTHER flow's slice and
      // mask the confinement scan below. It is also the direction membership
      // cannot see — membership catches a clear added in the wrong flow, never
      // one deleted, and a deleted clear strands the flag.
      expect(sites, `${c.name} clear count`).toHaveLength(c.clears)

      let bare = 0
      for (const at of sites) {
        // (c) is consulted FIRST — ordered, then positional. The allowed bare
        // site sits at a straight-line position, so a positional-first
        // classifier routes it to (a) and demands a compare the body
        // deliberately does not have.
        const block = enclosing(SRC, at, false)
        expect(block, `${c.name}: clear outside any block at ${at}`).toBeGreaterThan(-1)
        if (c.flag === 'navigating' && SRC.slice(0, block).trimEnd().endsWith('if (!resolvedTr)')) {
          // (c) selects on SHAPE ALONE — an `if (!resolvedTr)` block sitting at
          // a straight-line position — so on its own it pins where the allowed
          // bare clear is, never WHY it is allowed to be bare. That reason is a
          // claim about the source ABOVE it: nothing between
          // `const myNav = ++navigationEpoch` and the clear suspends, so the
          // ownership compare the other six carry would be dead code here.
          // Without the pin below, an `await` dropped anywhere into the
          // resolution chain reintroduces #302 at precisely the one site this
          // change deliberately leaves bare, and the whole scan stays green —
          // cardinality and confinement included — because the clear neither
          // moved nor changed shape. Scoped to `start`, not an unscoped
          // `indexOf`: the premise is about THIS function's epoch set site.
          const set = SRC.indexOf('const myNav = ++navigationEpoch', start)
          expect(set, `${c.name}: no epoch set site above the bare clear at ${at}`).toBeGreaterThan(
            -1
          )
          expect(set, `${c.name}: the bare clear at ${at} sits above its epoch set`).toBeLessThan(
            at
          )
          expect(
            SRC.slice(set, at),
            `${c.name}: the bare clear at ${at} is now reached across a suspension`
          ).not.toContain('await ')
          bare++
          continue
        }

        const fn = enclosing(SRC, at, true)
        expect(fn, `${c.name}: clear outside any function body at ${at}`).toBeGreaterThan(-1)
        if (isNextTickBody(SRC, fn)) {
          // (b) — accepted only when the CALLBACK's first statement is the
          // early return. Containment in a `nextTick(` is the SELECTOR for this
          // branch, never the allowance: the guard wraps the whole body because
          // a superseded callback otherwise steers the element the winner is
          // now driving — one `<video>`, never swapped.
          expect(
            SRC.slice(fn + 1)
              .trimStart()
              .startsWith(c.early),
            `${c.name}: nextTick callback at ${fn} does not open with \`${c.early}\``
          ).toBe(true)
        } else {
          // (a) — accepted only as the exact single-line form already in the
          // file on the two `!prep.ok` arms, never by mere containment.
          const line = SRC.slice(SRC.lastIndexOf('\n', at) + 1, SRC.indexOf('\n', at)).trim()
          expect(line, `${c.name}: unguarded straight-line clear at ${at}`).toBe(c.guard)
        }
      }
      // Cardinality on branch (c), not just its shape: without it a ninth clear
      // dropped in as `if (!resolvedTr) { … }` at any straight-line position
      // classifies as the exception and lands green.
      expect(bare, `${c.name}: allowed bare clears`).toBe(c.bare)

      // Mutating this: a ninth bare clear must be added BELOW that function's
      // first `nextTick(`, with the count literal above bumped alongside it.
      // The bump matters because cardinality fires on ANY clear added inside
      // the slice, so without it the mutant goes red for a reason that has
      // nothing to do with classification and the (a)/(b) selector stays
      // unpinned by the very mutation written to pin it. The placement matters
      // because a clear dropped ABOVE the first `nextTick(` classifies as (a)
      // and goes red even under a broken "is there a `nextTick(` textually
      // above me" selector — which would otherwise route all four straight-line
      // clears to (b) and let them be satisfied by an enclosing callback's
      // early return.
      //
      // Also, and this is not a hole: with the bump in place, the same ninth
      // clear placed at an IN-CALLBACK position lands green. Branch (b) keys on
      // the callback, not on the clear, so once a callback opens with its early
      // return every clear inside it is guarded — which is semantically right.
      // (Claim about the ADD only: deleting a clear at an in-callback position
      // drops the slice count and goes red on cardinality.)
    }
  })

  it('confines each flag write to its own flow, whole-source', () => {
    // The per-caller scan above is keyed on `c.flag` and structurally cannot
    // see a `navigating.value = false` dropped into `selectTranslation`, or the
    // reverse — and that confinement is what the whole safety argument rests
    // on. A cross-flow supersede leaves the OTHER counter untouched, so the
    // loser's compare is still true and it still releases its own flag; nothing
    // strands. Written as whole-source membership per slice rather than "the
    // slice contains N writes": the two slices are adjacent and purely textual,
    // so the loose form would also accept a write sitting in the gap between
    // `selectTranslation`'s closing brace and `goToEpisode`'s opener.
    for (const c of callers()) {
      const [start, end] = c.bounds
      const writes = [...SRC.matchAll(new RegExp(`${c.flag}\\.value =`, 'g'))]
      expect(writes.length, `${c.flag} write count`).toBeGreaterThan(0)
      for (const w of writes) {
        expect(
          w.index! >= start && w.index! < end,
          `${c.flag} written outside ${c.name} at ${w.index}`
        ).toBe(true)
      }
    }
  })

  // ---------------------------------------------------------------------
  // #317 — the same ownership question, asked of the REACTIVE WRITES rather
  // than of the flag clears.
  //
  // #302 put the compare on the `nextTick` callbacks, which leaves a
  // superseded run *half* stopped: it declines to seek and to play, but it has
  // already installed its own source, its own episode identity and its own
  // translation on the way down. The half that still runs is the half that
  // mutates shared state.
  //
  // The rule is POSITIONAL and it is one rule, not a rule plus an exception
  // list: after every await in these two functions, the ownership compare goes
  // BELOW `clearRemux()` / `msePlayer.resetMseState()` (where they follow) and
  // ABOVE the first symbol-set write. A resume point with no symbol-set write
  // below it is then vacuously satisfied rather than listed by hand, which is
  // what stops the inventory going stale.
  //
  // Below the clears, not above them: those two calls are the run's own
  // bookkeeping for a kill it already issued (main has SIGKILLed every
  // registered session and swept the shared tmpDir). Bailing above them leaves
  // `remuxedPath` pointing at an unlinked file on a LIVE component, and
  // `remuxedPath.value || streamSessionId.value` then reads true for the next
  // run. That is why the #280/#311 ladder rule — "checkpoint immediately after
  // every await" — is wrong here if applied naively, and why this scan asserts
  // the compare's POSITION rather than merely its presence: a presence-only
  // scan is satisfied by a compare placed above the clears, which is the exact
  // failure the whole `playerCleanupRemux` argument is about.
  // ---------------------------------------------------------------------

  /**
   * The clobber inventory: everything a superseded run can install on its way
   * down that the winner is now the owner of.
   *
   * WRITES AND CALLS ONLY. `activeSubtitleContent.value` is also *read*, in the
   * `if (… && video && !unmounted)` orphan-worker guards, and a matcher on the
   * bare identifier would flag those reads and drag the compares above the
   * guards they belong under — so every ref member tests for `=` not followed
   * by `=`.
   *
   * `pendingPrevEpisodeInt` is the one member that is NOT a ref: a plain `let`
   * declared at the top of `<script setup>`, so it is assigned bare. Folding it
   * into a single `<name>\.value =` matcher with the other nine drops it
   * silently, and the block-count tripwire below CANNOT catch that — the six
   * episode-identity writes above it keep its block red on their own, so the
   * count still reads ten while the dropped mark-watched clobber goes unpinned.
   * Its own matcher, and its own assertion, are below for that reason.
   *
   * `window.api.playerCleanupRemux(` is deliberately absent though it is a
   * cross-run mutation too: its earliest resume point in `goToEpisode` is
   * `await saveProgress(true)`, above the `const myNav = ++navigationEpoch`
   * that a compare would have to read, so carrying it would force exactly the
   * exemption list this scan refuses to encode. Its safety argument is the
   * branch (c) premise — the whole stretch from the epoch bump to the bare
   * clear is synchronous — which is pinned by its own scan above.
   */
  const SYMBOL_SET: { name: string; re: string }[] = [
    { name: 'activeFilePath', re: 'activeFilePath\\.value =(?!=)' },
    { name: 'activeStreamUrl', re: 'activeStreamUrl\\.value =(?!=)' },
    { name: 'activeSubtitleContent', re: 'activeSubtitleContent\\.value =(?!=)' },
    { name: 'activeTranslationId', re: 'activeTranslationId\\.value =(?!=)' },
    { name: 'selectedHeight', re: 'selectedHeight\\.value =(?!=)' },
    { name: 'activeEpisodeIndex', re: 'activeEpisodeIndex\\.value =(?!=)' },
    { name: 'activeEpisodeLabel', re: 'activeEpisodeLabel\\.value =(?!=)' },
    { name: 'activeTranslations', re: 'activeTranslations\\.value =(?!=)' },
    { name: 'activeDownloadedTrIds', re: 'activeDownloadedTrIds\\.value =(?!=)' },
    // The non-ref. See the docstring above before touching this line.
    { name: 'pendingPrevEpisodeInt', re: 'pendingPrevEpisodeInt =(?!=)' },
    { name: 'persistSelectedTranslation(', re: 'persistSelectedTranslation\\(' },
    { name: 'resetEpisodeTracking(', re: 'resetEpisodeTracking\\(' },
    { name: 'destroySubtitles(', re: 'destroySubtitles\\(' },
    // Shared state the winner owns, exactly like `destroySubtitles(`: it writes
    // `remuxError`, which paints `.remux-overlay` over whatever is playing, and
    // the only clear is at the top of `prepareMkvForPlayback` — so a winner that
    // took the stream branch never clears a loser's write. Listing it is what
    // pins the two prepare-arm compares ABOVE their `if (!prep.ok)`.
    { name: 'reportPrepareError(', re: 'reportPrepareError\\(' },
    // A mutation in its own right, not merely a suspension point:
    // `prepareMkvForPlayback`'s first effectful statements are
    // `msePlayer.resetMseState(); clearRemux(); remuxError.value = '';`, above
    // every await, and the one `shouldBail(myPrepare)` above them cannot fire
    // on a supersede because no statement separates it from its own
    // `++prepareEpoch`. So a loser reaching the CALL wipes the winner's MSE
    // state before it does anything else.
    { name: 'prepareMkvForPlayback(', re: 'prepareMkvForPlayback\\(' }
  ]

  /**
   * The closed inventory, per flow. Pinned rather than merely looped over: a
   * symbol quietly dropped from the set above turns a red site green, and the
   * block count alone cannot see it whenever a sibling write keeps its block
   * red — which is true of ten of the thirty-one sites.
   */
  const SYMBOL_SCAN: Record<string, { sites: number; blocks: number }> = {
    selectTranslation: { sites: 15, blocks: 5 },
    goToEpisode: { sites: 18, blocks: 5 }
  }

  function symbolSites(body: string): { name: string; index: number }[] {
    const out: { name: string; index: number }[] = []
    for (const { name, re } of SYMBOL_SET) {
      for (const m of body.matchAll(new RegExp(re, 'g'))) out.push({ name, index: m.index! })
    }
    return out.sort((a, b) => a.index - b.index)
  }

  /**
   * Group the sites by the resume point they are reached from. `precedingAwait`
   * is the anchor — the same one the `unmounted` scans in this file use — and
   * it is the only one that reaches all ten blocks: an anchor keyed to
   * `playerGetStreamUrl` leaves the episode-identity block green, because that
   * block is reached from a `playerCleanupRemux` resume point instead. Its
   * own-await skip is what files `prepareMkvForPlayback(` under the
   * `playerCleanupRemux` above it rather than under its own `await`.
   */
  function blocksOf(body: string): Map<number, { name: string; index: number }[]> {
    const blocks = new Map<number, { name: string; index: number }[]>()
    for (const s of symbolSites(body)) {
      const at = precedingAwait(body, s.index)
      expect(at, `${s.name} at ${s.index} is reached from no await at all`).toBeGreaterThan(-1)
      const group = blocks.get(at)
      if (group) group.push(s)
      else blocks.set(at, [s])
    }
    return blocks
  }

  /**
   * The per-flow epoch literal, taken from the #302 table above so the two
   * cannot drift. Deliberately NOT one shared `'Epoch !== my'`-style constant:
   * `CONTINUATIONS` is `it.each`-ed over both functions, and a literal loose
   * enough to match both would also pass a MISMATCHED pair
   * (`translationEpoch !== myNav`).
   */
  function earlyFor(name: string): string {
    const c = callers().find((x) => x.name === name)
    expect(c, `no #302 caller entry for ${name}`).toBeTruthy()
    return c!.early
  }

  it.each(CONTINUATIONS)(
    'guards every symbol-set write in %s against the run that superseded it',
    (name, body) => {
      const early = earlyFor(name)
      const expected = SYMBOL_SCAN[name]
      expect(expected, `no symbol-set inventory for ${name}`).toBeTruthy()
      expect(symbolSites(body).length, `${name} symbol-set site count`).toBe(expected.sites)

      const blocks = blocksOf(body)
      expect(blocks.size, `${name} guarded block count`).toBe(expected.blocks)

      // Collected rather than asserted per block, so a run of this scan names
      // EVERY unguarded block at once instead of only the first. On v4.6.55
      // that list is five entries here and five in the other flow — one per row
      // of #317's table.
      const unguarded: string[] = []
      for (const [awaitAt, group] of blocks) {
        const first = group[0].index
        const compare = body.lastIndexOf(early, first)
        if (compare <= awaitAt) {
          unguarded.push(
            `${group[0].name} at ${first}: no \`${early}\` between the await at ${awaitAt} and it`
          )
          continue
        }
        // Position, not presence. Wherever the clears follow the await, they
        // must fall between the await and the compare — never below it.
        const clear = body.indexOf('clearRemux();', awaitAt)
        const reset = body.indexOf('msePlayer.resetMseState();', awaitAt)
        if (clear > -1 && clear < first && reset > -1 && reset < first && compare < reset) {
          unguarded.push(
            `${group[0].name} at ${first}: the compare at ${compare} sits ABOVE the clears at ${clear}/${reset}`
          )
        }
      }
      expect(unguarded, `${name}: unguarded symbol-set blocks`).toEqual([])
    }
  )

  it('pins the ten-block inventory and the non-ref pendingPrevEpisodeInt site', () => {
    // Ten blocks across the two flows — one per row of #317's table. If the
    // symbol set is ever narrowed to make this scan cheaper to satisfy, a
    // short inventory shows up here as a count rather than as silence.
    const total = CONTINUATIONS.reduce((n, [, body]) => n + blocksOf(body).size, 0)
    expect(total, 'guarded blocks across both continuations').toBe(10)

    const goTo = CONTINUATIONS.find(([n]) => n === 'goToEpisode')![1]
    const pending = symbolSites(goTo).filter((s) => s.name === 'pendingPrevEpisodeInt')
    expect(pending, 'pendingPrevEpisodeInt site count').toHaveLength(1)
    expect(goTo).toContain("pendingPrevEpisodeInt = direction === 'next' ? prevEpisodeInt : '';")

    // It rides in the episode-identity block, and is the last member of it —
    // which is exactly why a `<name>\.value =`-shaped matcher loses it for
    // free: the six writes above keep the block red without it.
    const identity = goTo.indexOf('activeEpisodeIndex.value =')
    expect(identity, 'missing the episode-identity block').toBeGreaterThan(-1)
    const resume = precedingAwait(goTo, pending[0].index)
    expect(resume).toBe(precedingAwait(goTo, identity))

    // Asserted in its own right, not merely as a member of a red block: the
    // write it guards silently drops the winner's pending mark-watched, and
    // `maybeMarkPendingPrevWatched()` is gated on an `episodeOpenedAt` the same
    // block just reset — so nothing reports the loss.
    const early = earlyFor('goToEpisode')
    expect(
      goTo.lastIndexOf(early, pending[0].index),
      'no ownership compare above the pendingPrevEpisodeInt write'
    ).toBeGreaterThan(resume)
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
    // so a `//` in `PlayerView.vue` naming `initSubtitles(video)` would
    // otherwise count as a site and fail this. Since #302 that closes the
    // hazard rather than narrowing it — `stripComments` now blanks a trailing
    // `// …` and a block comment's body as well as a whole-line `//`, so no
    // comment in any style can present the literal as a site, and the enclosing
    // `if (` the walk below looks for can only be real code.
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
    //
    // Stripped like the other twelve `slice(` call sites (#302): these are
    // positive `toContain`s over a literal ordinary prose can carry, so against
    // raw text a commented-out entry still reads as a registration. No
    // cardinality pin goes with it, deliberately — this table drives BOTH
    // directions, so a seventh listener is registered and removed by
    // construction, and a length assertion would turn a correct addition RED.
    const table = stripComments(slice('const DIAGNOSTIC_LISTENERS', 'onMounted('))
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
