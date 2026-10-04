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

// The input every POSITIVE scan in this file reads. A `toContain` over raw
// text is satisfied by a commented-out copy of the needle, which is the one way
// the declarations these scans pin are likely to disappear (#302, #321) — so
// positive scans read stripped, script-region source. Declared once here rather
// than per-describe: the name would otherwise say nothing about which block it
// belongs to, and a later edit to one copy would be invisible to the others.
//
// Negative (`not.toContain`) scans deliberately keep reading raw `SOURCE`,
// which is a superset of this, so they stay strictly the stronger check. Each
// says so at its own site — that part has to stay local.
const SRC = stripComments(SETUP)

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
    expect(SRC).toContain(
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
    //
    // Both scans below therefore read RAW `SOURCE`, deliberately: the first has
    // to see text outside `SETUP` (a second block is by definition not in it),
    // and the second compares an INDEX against `setupStart`/`setupEnd`, which
    // are raw-source offsets — `stripComments` shortens the text, so mixing the
    // two spaces would compare offsets that do not mean the same thing.
    //
    // "Deliberately raw" is not "safe in the #321 sense": comment out
    // `let prepareEpoch = 0;` and the `indexOf` below still finds it, still
    // inside the bounds, still green. What closes that hole here is not this
    // scan — it is typecheck, since two code-side sites read the binding
    // (`:570`, `:1074`) and fail before any test runs.
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
    // Over stripped source: comment prose that writes the literal
    // `++prepareEpoch` would otherwise inflate the count and turn this red for
    // no real reason. `PlayerView.vue` already carries four comment mentions of
    // `prepareEpoch`, one of them a bump's own description.
    expect([...SRC.matchAll(/\+\+prepareEpoch/g)]).toHaveLength(1)
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
    // Three call sites, all routed through the guard.
    expect([...SRC.matchAll(/reportPrepareError\(prep\)/g)]).toHaveLength(3)
    // The one surviving direct write is the guard's own, after the early return.
    const writes = [...SRC.matchAll(/remuxError\.value = prep\.error/g)]
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
      expect(SRC).toContain(c.set)
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
    expect(handler.indexOf(sample)).toBeLessThan(handler.indexOf('walkEpisodeSteps('))
    const walk = stripComments(slice('void walkEpisodeSteps(', '\n}'))
    expect(walk).toContain('activeEpisodeIndex.value !== idx')
    expect(walk).toContain('!navigating.value')
    expect(walk).toContain('translationEpoch === walkTranslation')
    expect(walk).not.toContain('switchingTranslation')
  })

  it('stops the walk on a step that declined to move, not only on observed state', () => {
    // #419. The three terms above are all state the walk reads from OUTSIDE the
    // step, and none of them can see a step that refused to advance: a boundary
    // no-op, an episode with no usable translation, or a failed on-demand fetch
    // all leave `activeEpisodeIndex` where it was and release `navigating` on the
    // way out. The old `while` loop re-read both as permission and called again
    // with every term unchanged — a tight retry of the same failing step. Worse,
    // the boundary check is `goToEpisode`'s first statement, so that retry could
    // resolve without ever awaiting a real task: a microtask spin that starved
    // timers, input and rAF for as long as the room stayed on that episode.
    //
    // Fails against the pre-#419 source, where the loop is a bare `while` and
    // `goToEpisode` returns `Promise<void>` with no outcome to break on.
    const handler = stripComments(
      slice('function handleRemoteEpisodeChange(', '\n// Disposers for the non-syncplay')
    )
    expect(handler).toContain('void walkEpisodeSteps(')
    // `'follow'` since #486 — also the origin that arms the #487 token.
    expect(handler).toContain("() => goToEpisode(dir, 'follow')")
    // The loop itself is gone from the component — the break-on-outcome rule
    // lives in `walkEpisodeSteps` (see `test/renderer/utils.test.ts`), where it
    // is reachable by a real unit test instead of only by a source scan.
    expect(handler).not.toContain('while (')
    // And the outcome type is what makes the break possible at all: a
    // `Promise<void>` signature here would type-error, but a scan is what keeps
    // the claim visible next to the walk it protects.
    expect(SRC).toContain(
      "async function goToEpisode(\n  direction: 'prev' | 'next',\n  origin: SyncplayEpisodeSwitch\n): Promise<EpisodeStepOutcome> {"
    )
  })
})

describe('#487 — the pending-follow token: armed by a remote Next, read only by the user’s Next', () => {
  // `PlayerView` has no mount harness, so the decision lives in
  // `shouldSwallowLocalNext` (unit-tested in
  // `test/renderer/should-swallow-local-next.test.ts`, driven end to end in
  // `test/services/syncplay-two-peer-episode-change.test.ts`) and these scans pin
  // the component to it: who sets the token, who clears it, and who reads it.
  const GO_TO = stripComments(slice('async function goToEpisode(', '\nfunction cancelAutoAdvance('))
  const USER_NEXT = stripComments(
    slice('function onUserNext(', '\nfunction onPrefetchSettingChanged(')
  )
  const CLEAR = 'if (navigationEpoch === myNav) pendingFollowIndex = null;'

  it('routes the button and the keyboard Next through onUserNext, and nothing else', () => {
    // The two user-facing call sites, and the wrapper is their only route.
    expect(SOURCE).toContain('@nav="onUserNext"')
    expect(SOURCE.split('@nav="onUserNext"').length - 1).toBe(1)
    const keyboard = stripComments(slice("case 'next-episode':", 'break;'))
    expect(keyboard.trim()).toBe("case 'next-episode':\n      onUserNext();")
    // Exactly two callers: the template binding above and the keyboard case.
    expect(SRC.split('onUserNext();').length - 1).toBe(1)

    // The wrapper consults the helper with the token and the ACTIVE index, and
    // consumes the token on a swallow — before the `goToEpisode` it skips.
    expect(USER_NEXT).toContain(
      'if (shouldSwallowLocalNext(pendingFollowIndex, activeEpisodeIndex.value)) {'
    )
    const consume = USER_NEXT.indexOf('pendingFollowIndex = null;')
    expect(consume).toBeGreaterThan(USER_NEXT.indexOf('shouldSwallowLocalNext('))
    expect(consume).toBeLessThan(USER_NEXT.indexOf("void goToEpisode('next', 'local');"))
    // The `navigating` term sits ABOVE the helper call: a keyboard press during
    // the follow's own in-flight step must not consume the token, or the press
    // that lands after the source swap is free to skip.
    const guard = USER_NEXT.indexOf('if (!canNext.value || navigating.value) return;')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(USER_NEXT.indexOf('shouldSwallowLocalNext('))
  })

  it('leaves Prev, auto-advance and the walk off the helper', () => {
    // Whole-script: the helper is called from exactly one place.
    expect(SRC.split('shouldSwallowLocalNext(').length - 1).toBe(1)
    expect(SRC).toContain("if (canPrev.value) goToEpisode('prev', 'local');")
    expect(SOURCE).toContain(`@nav="goToEpisode('prev', 'local')"`)
    const ended = stripComments(slice('function onVideoEnded(', '\nfunction onUserNext('))
    expect(ended).toContain("goToEpisode('next', 'local');")
    expect(ended).not.toContain('onUserNext')
    // The token is READ nowhere but the wrapper.
    const reads = [...SRC.matchAll(/pendingFollowIndex(?!\s*=[^=])/g)].map((m) => m.index!)
    const userStart = SRC.indexOf('function onUserNext(')
    const userEnd = SRC.indexOf('\nfunction onPrefetchSettingChanged(')
    // The declaration plus the one read in the helper call.
    expect(reads).toHaveLength(2)
    expect(reads.filter((at) => at > userStart && at < userEnd)).toHaveLength(1)
  })

  it('arms the token at the commit, for a remote Next only, and clears it on every other commit', () => {
    const write =
      "pendingFollowIndex = origin === 'follow' && direction === 'next' ? targetIndex : null;"
    expect(GO_TO).toContain(write)
    // In the episode-identity block, under the same ownership compare as every
    // other write there — which is what stops a superseded step setting it.
    const identity = GO_TO.indexOf('activeEpisodeIndex.value = targetIndex;')
    expect(identity).toBeGreaterThan(-1)
    expect(GO_TO.indexOf(write)).toBeGreaterThan(identity)
    expect(
      GO_TO.lastIndexOf("if (navigationEpoch !== myNav) return 'superseded';", identity)
    ).toBeGreaterThan(GO_TO.lastIndexOf('await ', identity))
    // The one place a token is armed: no other write outside goToEpisode but
    // the consume in the wrapper.
    const writes = [...SRC.matchAll(/pendingFollowIndex = (?!=)/g)].length
    // Commit + loadedmetadata + three failure arms + the consume.
    expect(writes).toBe(6)
  })

  it('clears it under ownership on loadedmetadata and on all three no-source arms', () => {
    // Exactly four guarded clears in goToEpisode: the metadata listener and the
    // three arms that return `'moved'` with no `loadedmetadata` behind them.
    expect(GO_TO.split(CLEAR).length - 1).toBe(4)
    // Both source arms install the same listener, so both clear it.
    expect(
      GO_TO.split("v.addEventListener('loadedmetadata', onTargetMetadata, { once: true });")
        .length - 1
    ).toBe(2)
    const listener = GO_TO.slice(GO_TO.indexOf('const onTargetMetadata = (): void => {'))
    expect(listener.slice(0, listener.indexOf('};'))).toContain(CLEAR)

    // Each failure arm clears it right beside its own `navigating` release.
    const NAV = 'if (navigationEpoch === myNav) navigating.value = false;'
    const arms = [
      ['!prep.ok', GO_TO.indexOf('if (!prep.ok) {')],
      ['null stream', GO_TO.indexOf('if (!result) {')],
      ['catch', GO_TO.indexOf('} catch {')]
    ] as const
    for (const [name, at] of arms) {
      expect(at, `${name}: arm missing`).toBeGreaterThan(-1)
      const nav = GO_TO.indexOf(NAV, at)
      const clear = GO_TO.indexOf(CLEAR, at)
      expect(clear, `${name}: no token clear`).toBeGreaterThan(-1)
      // Beside the arm's own `navigating` release — at most #486's hold release
      // between them — and above the arm's first `return`, so no exit path
      // skips it.
      expect(
        GO_TO.slice(nav + NAV.length, clear)
          .replace('if (committed) syncplay.endEpisodeSwitchHold();', '')
          .replace('syncplay.endEpisodeSwitchHold();', '')
          .trim(),
        `${name}: clear not beside release`
      ).toBe('')
      expect(GO_TO.indexOf('return ', nav), `${name}: a return above the clear`).toBeGreaterThan(
        clear
      )
    }
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
  // Every scan here reads the module-level `SRC` — comment-stripped,
  // script-region source. That matters more here than elsewhere: the
  // membership half below compares INDICES, and `stripComments` shortens the
  // text, so its bounds must be computed in the same space as the matches they
  // are tested against. Note the opposite order from every other scan in this
  // file, which strips a raw slice: `slice()` keeps indexing raw `SOURCE` on
  // purpose, because one of its callers passes an own-line `//` as an END
  // needle and stripping would delete it out from under `indexOf`.

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
   * Walks OUTWARD from `at` to the enclosing FUNCTION body's `{`, never inward
   * from a known opener and never by searching for one. Searching is what makes
   * a needle-based matcher wrong here: guard shapes repeat inside these two
   * functions — `if (navigationEpoch !== myNav) return` alone occurs six times
   * in `goToEpisode` — so `indexOf` on any of them finds a block that is not the
   * one containing the clear under test.
   */
  function enclosing(src: string, at: number): number {
    let depth = 0
    for (let i = at; i >= 0; i--) {
      const ch = src[i]
      if (ch === '}') depth++
      else if (ch === '{') {
        if (depth > 0) depth--
        else if (isFunctionBody(src, i)) return i
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

  /**
   * `early` is the whole statement, including the `;`, because branch (b) asserts
   * that a `nextTick` callback OPENS with it and those callbacks still return
   * void.
   *
   * `compare` is the same test with the returned value cut off, and it exists
   * because #419 gave `goToEpisode` an outcome: its ownership bails now read
   * `return 'superseded';` above the episode-identity write and `return 'moved';`
   * below it, so no single statement literal reaches every #317 block any more.
   * Still one literal PER FLOW rather than a shared `'Epoch !== my'`-style
   * pattern — a matcher loose enough to cover both flows would also accept a
   * mismatched pair (`translationEpoch !== myNav`), which is the failure the old
   * per-flow literal was chosen to catch.
   */
  function callers(): {
    name: string
    flag: string
    guard: string
    early: string
    compare: string
    clears: number
    bounds: [number, number]
  }[] {
    return [
      {
        name: 'selectTranslation',
        flag: 'switchingTranslation',
        guard: 'if (translationEpoch === mySwitch) switchingTranslation.value = false;',
        early: 'if (translationEpoch !== mySwitch) return;',
        compare: 'if (translationEpoch !== mySwitch) return',
        clears: 5,
        bounds: boundsOf('async function selectTranslation(', '\nasync function goToEpisode(')
      },
      {
        name: 'goToEpisode',
        flag: 'navigating',
        guard: 'if (navigationEpoch === myNav) navigating.value = false;',
        early: 'if (navigationEpoch !== myNav) return;',
        compare: 'if (navigationEpoch !== myNav) return',
        clears: 6,
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
      '/* block prose */ const kept = 1;',
      "// const PLAYER_CLOSED_BAIL = { ok: false, error: 'player closed' } as const;"
    ].join('\n')
    const out = stripComments(fixture)
    expect(out).toContain("'anime-video://'")
    expect(out).toContain('const kept = 1;')
    expect(out).not.toContain('trailing prose')
    expect(out).not.toContain('block prose')
    // The failure mode #321 is about, pinned on the helper itself: a
    // declaration deleted from the code and left behind as a commented-out
    // line must be INVISIBLE to a positive `toContain` scan. Over raw text that
    // scan still passes and reports green. The needle keeps its quotes because
    // that is how the real declaration reads — a stripper that stopped honouring
    // the whole-line `//` leaves `PLAYER_CLOSED_BAIL` in `out` and fails here
    // directly, without the quotes needing to desynchronise anything.
    expect(out).not.toContain('PLAYER_CLOSED_BAIL')
    // And on the real input every scan in this file reads.
    expect(SRC).toContain("'anime-video://' + encodeURIComponent(")
  })

  it('classifies every flag clear as guarded, by its callback or by its own line', () => {
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

      for (const at of sites) {
        const fn = enclosing(SRC, at)
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
      // Mutating this: a clear added anywhere at a straight-line position must
      // carry `c.guard` verbatim, with the count literal above bumped alongside
      // it. The bump matters because cardinality fires on ANY clear added inside
      // the slice, so without it the mutant goes red for a reason that has
      // nothing to do with classification and the (a)/(b) selector stays
      // unpinned by the very mutation written to pin it. Placement matters the
      // other way round now: a clear dropped ABOVE the first `nextTick(`
      // classifies as (a) and goes red even under a broken "is there a
      // `nextTick(` textually above me" selector — which would otherwise route
      // every straight-line clear to (b) and let them be satisfied by an
      // enclosing callback's early return.
      //
      // Also, and this is not a hole: with the bump in place, the same clear
      // placed at an IN-CALLBACK position lands green. Branch (b) keys on the
      // callback, not on the clear, so once a callback opens with its early
      // return every clear inside it is guarded — which is semantically right.
      // (Claim about the ADD only: deleting a clear at an in-callback position
      // drops the slice count and goes red on cardinality.)
    }
  })

  it('leaves no bare clear in either flow, the exception having lost its premise', () => {
    // There used to be a third branch above: `goToEpisode`'s `if (!resolvedTr)`
    // arm cleared `navigating` bare, and that was sound because nothing between
    // `const myNav = ++navigationEpoch` and the clear suspended — the whole
    // (a)-(d) resolution chain was synchronous, so no second run could be
    // admitted in between and the ownership compare would have been dead code.
    //
    // #419 moved that chain into `resolveEpisodeTranslation` and made it
    // awaitable, because an off-page target arrives with `translations: []` and
    // has to be fetched before anything can be ranked. The premise is therefore
    // gone, the exception with it, and this asserts BOTH halves — the count is
    // zero, and the reason the count is zero is a suspension where there was
    // none. Without the second half a later refactor could make the chain
    // synchronous again and re-bare the clear while this scan stayed green on
    // the classifier alone.
    for (const c of callers()) {
      const [start, end] = c.bounds
      const body = SRC.slice(start, end)
      const set = SRC.indexOf(
        c.flag === 'navigating'
          ? 'const myNav = ++navigationEpoch'
          : 'const mySwitch = ++translationEpoch',
        start
      )
      expect(set, `${c.name}: no epoch set site`).toBeGreaterThan(-1)
      const first = body.indexOf(`${c.flag}.value = false`)
      expect(first, `${c.name}: no clear at all`).toBeGreaterThan(-1)
      const line = SRC.slice(
        SRC.lastIndexOf('\n', start + first) + 1,
        SRC.indexOf('\n', start + first)
      ).trim()
      expect(line, `${c.name}: the first clear is bare`).not.toBe(`${c.flag}.value = false;`)
      expect(
        SRC.slice(set, start + first),
        `${c.name}: the first clear is no longer reached across a suspension`
      ).toContain('await ')
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
   * red.
   *
   * That is the normal case here, not an edge: of the 33 sites across the 10
   * blocks below (15 + 18, the pins in this very object), 32 share a block
   * with a sibling. Dropping any one of the 15 symbols moves the block count
   * for exactly one of them — `prepareMkvForPlayback(` in `goToEpisode`, the
   * only site alone in its block. For the other 14 the block assertion goes on
   * reporting the same number and only these site counts catch the loss.
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
   *
   * `compare`, not `early`: #419 made `goToEpisode`'s bails return an outcome, so
   * the statement they end with differs by position (`'superseded'` above the
   * episode-identity write, `'moved'` below it) while the ownership TEST — the
   * only thing this scan is asking about — is unchanged. Cutting the literal at
   * `return` keeps it per-flow and keeps it a test of the compare.
   */
  function earlyFor(name: string): string {
    const c = callers().find((x) => x.name === name)
    expect(c, `no #302 caller entry for ${name}`).toBeTruthy()
    return c!.compare
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
    // The declaration scan is positive, so it reads stripped source — a
    // commented-out `let mkvPreparesInFlight = 0;` left behind by a deletion
    // would satisfy it over raw text (#321).
    expect(SRC).toContain('let mkvPreparesInFlight = 0;')
    // The two boolean scans stay RAW, deliberately. They are `not.toContain`,
    // so stripping could only LOOSEN them: over raw text a commented-out
    // `mkvPreparesInFlight = true` still fails, which is the behaviour we want
    // from a scan whose job is to catch a latch creeping back in.
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

describe('#419 review — the ladder reaches the toast arms and the on-demand fetch', () => {
  const GO_TO = stripComments(slice('async function goToEpisode', 'function cancelAutoAdvance'))
  const TOAST = 'showNavToast(NAV_FAILED_MESSAGE);'

  // The reviewer's finding, as an inventory rather than as one spot check: the
  // `catch` was the only one of the three arms that could raise a toast on a
  // DEAD component. The `!result` arm had `if (unmounted) return 'moved';`
  // above it and the resolution arm is covered by the post-resolution pair, so
  // a rejection from `playerGetStreamUrl` / `playerFindLocalFile` landing after
  // close fell straight through — and an unmount does NOT bump
  // `navigationEpoch`, so the ownership compare one line above cannot stand in
  // for the check. The consequence is the one timer that escapes teardown:
  // `showNavToast` arms `navToastTimer` after `onBeforeUnmount` has already
  // cleared it.
  //
  // Scanned per arm, from the toast BACKWARDS, because that is the direction the
  // claim runs — "nothing that toasts is reachable on a dead component" — and it
  // is what makes a fourth arm added later red by default instead of silently
  // unguarded.
  it('checks unmounted above every navigation toast, on all three arms', () => {
    const sites = [...GO_TO.matchAll(/showNavToast\(NAV_FAILED_MESSAGE\);/g)].map((m) => m.index!)
    // Pinned, not merely looped over: `for (const site of [])` passes
    // vacuously, so a toast moved behind a helper would turn this green on the
    // exact arms it exists to protect. Three arms — no resolution, a null
    // `playerGetStreamUrl`, and the `catch` — and `player-toast-slot.test.ts`
    // pins that the whole FILE has the same three, so none of them can escape
    // this slice either.
    expect(sites, 'navigation toast arms in goToEpisode').toHaveLength(3)
    // The `catch` is not reached by falling off the end of the `try`: it is
    // entered from a throw at ANY await inside it, so every bail lexically
    // above it is off the path and a plain backwards `lastIndexOf` is satisfied
    // by one of them. Without this floor this scan passes on the pre-review
    // source, finding the `playerGetStreamUrl` arm's `if (unmounted) return
    // 'moved';` fifty lines up and reporting the `catch` as guarded.
    const catchAt = GO_TO.indexOf('} catch {')
    expect(catchAt, 'missing the goToEpisode catch').toBeGreaterThan(-1)
    for (const site of sites) {
      const floor = site > catchAt ? catchAt : -1
      const bail = GO_TO.lastIndexOf(BAIL, site)
      expect(
        bail,
        `no \`${BAIL}\` above the toast at ${site}${floor > -1 ? ' inside the catch' : ''}`
      ).toBeGreaterThan(floor)
      // No await in between, which is what makes the check current rather than
      // merely present somewhere upstream: a suspension point after the bail
      // reopens the window the bail exists to close.
      expect(
        GO_TO.slice(bail, site),
        `a suspension point separates the toast at ${site} from its \`${BAIL}\``
      ).not.toContain('await ')
    }
  })

  // The outcome half. `moved` is not a detail here: the walk in
  // `walkEpisodeSteps` breaks on anything but `moved`, and below the identity
  // write the index HAS reached the target — a `superseded` there would stop
  // the walk at an index it has already left. Above the write nothing moved, so
  // an unmounted run reports `superseded` and stays silent, where a live one
  // still says `unreachable` and toasts.
  it('reports the catch arm by whether the identity write happened, above the toast', () => {
    const cat = GO_TO.indexOf('} catch {')
    expect(cat, 'missing the goToEpisode catch').toBeGreaterThan(-1)
    const arm = GO_TO.slice(cat)
    const bail = arm.indexOf("if (unmounted) return committed ? 'moved' : 'superseded';")
    expect(bail, 'missing the committed-aware unmount bail in the catch').toBeGreaterThan(-1)
    // Below the guarded clear and above the toast. Below, because #302 wants
    // `navigating` released by whichever run still owns it even on a dead
    // component — bailing above the clear would leave the flag set. Above,
    // because that is the whole point.
    expect(bail).toBeGreaterThan(
      arm.indexOf('if (navigationEpoch === myNav) navigating.value = false;')
    )
    expect(bail).toBeLessThan(arm.indexOf(TOAST))
    // And `committed` means what the outcome claims it does: set immediately
    // above the index write, so "committed" and "the index reached the target"
    // cannot come apart. The one statement between them is #486's synchronous
    // episode-switch mark, which has to sit directly on the commit it describes.
    expect(GO_TO).toContain(
      'committed = true;\n    syncplay.markEpisodeSwitch(origin);\n    activeEpisodeIndex.value = targetIndex;'
    )
  })

  // #280's ladder is sliced per flow, and this network call is the one that sits
  // OUTSIDE every slice it would be caught by: `fetchEpisodeWindowTranslations`
  // is its own function, reached from `resolveEpisodeTranslation`'s callback.
  // Read-only and cheap, so a stray batch for a dead player is not a bug — but
  // it is a full page of network for nothing, and the empty list it returns
  // instead is mapped to `unreachable` by the caller, where
  // `goToEpisode`'s own `if (unmounted) return 'superseded';` takes it first
  // and nothing toasts.
  it('abandons the on-demand page fetch on unmount, before the network batch', () => {
    const body = stripComments(
      slice('async function fetchEpisodeWindowTranslations', 'async function goToEpisode')
    )
    const cached = body.indexOf('await window.api.getEpisodesBatchCached(')
    const bail = body.indexOf('if (unmounted) return [];')
    const network = body.indexOf('await window.api.getEpisodesBatch(')
    expect(cached, 'missing the cache-first read').toBeGreaterThan(-1)
    expect(bail, 'missing the unmount bail in fetchEpisodeWindowTranslations').toBeGreaterThan(-1)
    expect(network, 'missing the network batch').toBeGreaterThan(-1)
    // Between the two, in that order: after the await it guards, and before the
    // call it is there to skip.
    expect(bail).toBeGreaterThan(cached)
    expect(bail).toBeLessThan(network)
  })
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

// #371 — the split between the episode being OPENED and the episode on SCREEN.
//
// `usePlayingEpisode`'s own tests (`use-playing-episode.test.ts`) cover the ref,
// the seed and the adopt-on-commit rule behaviourally. They are blind to two
// things, both of which live in this file instead:
//
//   1. WHICH `PlayerView` readers take the new ref. The composable is correct
//      whether two readers use it or zero do; the whole fix is the assignment.
//   2. Whether the ref is PRODUCED at all. Drop the `@loadstart` attribute from
//      the `<video>`, or drop the `seedPlayingEpisode()` call from `onMounted`,
//      and every composable test still passes — both are wiring in this SFC.
//
// Counts are pinned as literals rather than looped over a symbol set, per
// `docs/testing.md`'s rule for structural scans: a scan that walks the readers
// and asserts "each one is retargeted" cannot tell *all retargeted* from *the
// set lost an entry*, and dropping a symbol from the list is exactly how this
// kind of test rots.
describe('#371 — the retargeted readers, the untouched readers, and the producer', () => {
  // `saveProgress` and `maybeMarkWatched`'s Shikimori `epNum` — the only two
  // readers that are about the media currently decoding. Exactly two, and the
  // literal is what tells "both retargeted" apart from "one of them drifted
  // back": the two functions below are also asserted individually, but a third
  // site appearing somewhere else in the file would pass those and fail this.
  it('pins exactly 2 playing-episode reads, in exactly the two retargeted readers', () => {
    expect(SRC.split('playingEpisodeInt.value').length - 1).toBe(2)

    const saveProgress = stripComments(
      slice('async function saveProgress(', 'async function persistSelectedTranslation(')
    )
    expect(saveProgress).toContain('const epInt = playingEpisodeInt.value;')
    expect(saveProgress).not.toContain('currentEpisodeInt')

    const maybeMarkWatched = stripComments(
      slice('async function maybeMarkWatched(', 'function resetEpisodeTracking(')
    )
    expect(maybeMarkWatched).toContain('parseInt(playingEpisodeInt.value, 10)')
    expect(maybeMarkWatched).not.toContain('currentEpisodeInt')
  })

  // The amendment, and the third class the split produces: a writer whose KEY
  // is the selected episode but whose POSITION comes off the element. The key
  // stays on `currentEpisodeInt` — the translation id being recorded is about
  // the episode being opened — while the position is discarded when the element
  // is decoding something else. Pinned separately from the two retargeted
  // readers above because it is not one: the count there stays 2.
  it('guards the position source in persistSelectedTranslation, keeping its key selected', () => {
    // One call site, and it is the predicate's only consumer: `saveProgress`
    // and `maybeMarkWatched` switch keys outright rather than comparing.
    expect(SRC.split('isPlayingEpisode(epInt)').length - 1).toBe(1)
    expect(SRC).toContain('isPlayingEpisode } = usePlayingEpisode({')

    const persist = stripComments(
      slice('async function persistSelectedTranslation(', 'async function markEpisodeWatched(')
    )
    expect(persist).toContain('const epInt = currentEpisodeInt.value;')
    expect(persist).toContain('if (!isPlayingEpisode(epInt)) {')
  })

  // Split out because it fails for a different reason than "the guard is
  // missing": the guard can be present but placed after the fallback it feeds,
  // in which case the stale element values survive and nothing else notices.
  it('zeroes both position and duration, ahead of the stored-row fallback', () => {
    const persist = stripComments(
      slice('async function persistSelectedTranslation(', 'async function markEpisodeWatched(')
    )

    const guard = persist.indexOf('if (!isPlayingEpisode(epInt)) {')
    const fallback = persist.indexOf('if (!dur) {')
    expect(guard).toBeGreaterThan(-1)
    expect(fallback).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(fallback)

    // Both, not just the position: `duration.value` in the window is the
    // OUTGOING episode's duration, and a duration is per-episode too. Zeroing
    // `dur` is also what routes the write into the fallback below.
    const body = persist.slice(guard, fallback)
    expect(body).toContain('pos = 0;')
    expect(body).toContain('dur = 0;')
  })

  // Eleven original references, less the definition, less the two that moved.
  // Seven of the eight are `.value` reads; the eighth — the skip-UI reset
  // watcher, `watch(currentEpisodeInt, …)` — is a `watch` SOURCE, not a read.
  // It has to fire on selection so the new episode's OP/ED button appears, and
  // driving it off the playing ref would delay the skip-UI reset until the
  // element rebinds (on the MKV path, an ffmpeg spawn).
  it('pins exactly 8 selected-episode readers, plus the producer dep that feeds the ref', () => {
    // 8 `.value` reads = the 7 untouched readers + the one getter handed to
    // `usePlayingEpisode`, which is the ref's own source and not a consumer.
    expect(SRC.split('currentEpisodeInt.value').length - 1).toBe(8)
    expect(SRC.split('watch(currentEpisodeInt').length - 1).toBe(1)
    expect(SRC).toContain('const currentEpisodeInt = computed(')
    expect(SRC).toContain('getSelectedEpisodeInt: () => currentEpisodeInt.value')
  })

  // Enumerated so a reader silently switching sides is visible as more than a
  // count drift. Each entry names the site and the reason it is an OPENER (or
  // otherwise about the selection) rather than about the decoding media.
  it.each([
    [
      'skip markers',
      'const skipMarkers = useSkipMarkers({',
      'const {\n  showSkipDetections',
      'getCurrentEpisodeInt: () => currentEpisodeInt.value,'
    ],
    [
      'syncplay announce',
      'const syncplay = useSyncplayClient({',
      'const {\n  syncplayStatus',
      'getCurrentEpisodeInt: () => currentEpisodeInt.value,'
    ],
    [
      'resumeFromSavedPosition',
      'async function resumeFromSavedPosition(',
      'function seek(',
      'const epInt = currentEpisodeInt.value;'
    ],
    [
      'prepareMkvForPlayback saved-position fetch',
      'async function prepareMkvForPlayback(',
      'const [saved, roomPosition]',
      'const epInt = currentEpisodeInt.value;'
    ]
  ])('%s still reads the selected episode', (_name, start, end, needle) => {
    const body = stripComments(slice(start, end))
    expect(body).toContain(needle)
    expect(body).not.toContain('playingEpisodeInt')
  })

  // The producer half. Neither of these is a `currentEpisodeInt` read, so
  // neither is covered by the two counts above, and neither is visible to the
  // composable's own tests.
  it('binds loadstart declaratively on the <video>, exactly once', () => {
    // Raw SOURCE: the binding is a template attribute, outside `SETUP`.
    expect(SOURCE.split('@loadstart="onLoadStart"').length - 1).toBe(1)

    // Declarative, so teardown follows the element rather than outliving it —
    // the unmount block's `video.load()` is the file's only synchronous
    // `loadstart` source and it fires during teardown.
    expect(SRC).not.toContain("addEventListener('loadstart'")
  })

  // The same fact through the compiled template rather than through its text, so
  // dropping the attribute cannot go green on a spelling the text scan happens
  // to miss (`v-on:loadstart`, a reordered attribute, a handler renamed on one
  // side only). The listener total is pinned too: the element carried 13 before
  // this change, and an accidental removal that swaps in some other listener
  // would hold the count while breaking the binding, so both are asserted.
  // #486 added `error` (the episode switch's snapshot-hold release), so 15.
  it('exposes loadstart in the compiled <video> listener table, 15 handlers in all', () => {
    const { descriptor, errors } = parse(readFileSync(PLAYER_VIEW, 'utf8'), {
      filename: PLAYER_VIEW
    })
    expect(errors).toEqual([])

    const videos: ElementNode[] = []
    const visit = (node: TemplateChildNode): void => {
      if (node.type !== 1) return
      const el = node as ElementNode
      if (el.tag === 'video') videos.push(el)
      for (const child of el.children) visit(child)
    }
    for (const child of (descriptor.template!.ast as unknown as ElementNode).children) visit(child)
    expect(videos).toHaveLength(1)

    const handlers = videos[0].props
      .filter((p) => p.type === 7 && (p as { name: string }).name === 'on')
      .map((p) => (p as { arg?: { content?: string } }).arg?.content)

    expect(handlers).toHaveLength(15)
    expect(handlers).toContain('loadstart')
    expect(handlers).toContain('error')

    const loadstart = videos[0].props.find(
      (p) =>
        p.type === 7 &&
        (p as { name: string }).name === 'on' &&
        (p as { arg?: { content?: string } }).arg?.content === 'loadstart'
    )
    expect((loadstart as { exp?: { content?: string } }).exp?.content).toBe('onLoadStart')

    const error = videos[0].props.find(
      (p) =>
        p.type === 7 &&
        (p as { name: string }).name === 'on' &&
        (p as { arg?: { content?: string } }).arg?.content === 'error'
    )
    expect((error as { exp?: { content?: string } }).exp?.content).toBe(
      'syncplay.endEpisodeSwitchHold'
    )
  })

  it('calls seedPlayingEpisode exactly once, from inside onMounted', () => {
    expect(SRC.split('seedPlayingEpisode()').length - 1).toBe(1)
    expect(mountedBody()).toContain('seedPlayingEpisode();')
  })

  // Split from the count above because it is a different fact and fails for a
  // different reason: the seed can be present but hoisted wrongly. Every index
  // is asserted non-negative BEFORE it is ordered — `indexOf` returns -1 for a
  // missing needle, and -1 is less than everything, so a bare `toBeLessThan`
  // chain would pass vacuously on exactly the deletion this is meant to catch.
  it('seeds above onMounted’s first await and above the direct resume call', () => {
    const body = mountedBody()

    const seed = body.indexOf('seedPlayingEpisode();')
    const firstAwait = body.indexOf('await ')
    // The seed is required, not belt-and-braces: `resumeFromSavedPosition()` is
    // called DIRECTLY in this hook under `if (video.readyState >= 1)`, so on a
    // warm mount no `loadstart` precedes it and a `loadstart`-only ref would be
    // empty for the whole first episode.
    const directResume = body.indexOf('resumeFromSavedPosition();')

    expect(seed).toBeGreaterThan(-1)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(directResume).toBeGreaterThan(-1)

    // Synchronous, so a close landing in those awaits cannot leave the ref
    // unseeded on a resumed continuation (#280's rule, same reason).
    expect(seed).toBeLessThan(firstAwait)
    expect(seed).toBeLessThan(directResume)
  })
})

describe('#486 — who started an episode change, and the hold every failure arm releases', () => {
  // Main forces the room to 0 only for `'local'`, so a user-driven caller that
  // passed `'follow'` would leave the room on the old episode's number, and a
  // walk step that passed `'local'` would rewind the presser who is already
  // playing the new episode from 0. Read over the whole SFC because the nav
  // buttons call from the template.
  it("passes 'follow' from the remote walk alone, and 'local' from every other caller", () => {
    // `[^)\n]` keeps the multi-line declaration out of the census.
    // Both user-facing Nexts reach `goToEpisode` through `onUserNext` (#487),
    // so the keyboard case and the template's Next button are one site.
    const calls = [...SOURCE.matchAll(/goToEpisode\(([^)\n]*)\)/g)].map((m) => m[1])
    expect(calls).toEqual([
      "dir, 'follow'",
      "'prev', 'local'",
      "'next', 'local'",
      "'next', 'local'",
      "'prev', 'local'"
    ])
  })

  // A source that never reaches `loadedmetadata` has to release the snapshot
  // hold some other way, or a dead episode silences this peer's snapshots for
  // the rest of the mount: the prepare failure, the no-source arm, and the
  // throw below the index write.
  it('releases the snapshot hold on each of goToEpisode’s failure arms', () => {
    const goTo = stripComments(
      slice('async function goToEpisode(', '\nfunction cancelAutoAdvance(')
    )
    expect(goTo.split('syncplay.endEpisodeSwitchHold();').length - 1).toBe(3)
    expect(goTo).toContain('if (committed) syncplay.endEpisodeSwitchHold();')
    expect(goTo).toMatch(/reportPrepareError\(prep\);\s*syncplay\.endEpisodeSwitchHold\(\);/)
    expect(goTo).toMatch(
      /if \(!result\) \{\s*if \(navigationEpoch === myNav\) navigating\.value = false;\s*syncplay\.endEpisodeSwitchHold\(\);/
    )
  })
})
