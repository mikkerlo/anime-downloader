import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Overlay stacking order inside `.player-overlay` (#220).
//
// The bug: the four controls-bar dropdowns (Anime4K / Sync / Translation /
// Quality) painted *under* the "Skip OP" / "Skip ED" pill, which covered menu
// rows and swallowed clicks meant for them. The dropdowns are
// `position: absolute; bottom: 100%` — they escape the bar geometrically but
// not in stacking order, because `.controls-bar` has `position` + `z-index`
// and therefore forms a stacking context that confines them to *its* level.
//
// This lives at the source-scan layer on purpose, not as a mounted test.
// `PlayerView.vue` is a ~2.9k-line SFC with no mount harness here (see
// `components/player-toast-slot.test.ts` and `components/player-syncplay-
// resume.test.ts`, which scan for the same reason), and more fundamentally
// happy-dom computes neither stacking contexts nor layout — a mounted test
// could observe neither half of this bug. The values are the behavior.
//
// What keeps it non-vacuous: every assertion is keyed to one edit that
// reintroduces a real defect — dropping the bar back below the skip button,
// over-correcting past the modals, re-growing the invisible dead strip under
// the raised bar, or "fixing" it in `player-menus.css` where no value can work.

const RENDERER = resolve(__dirname, '../../src/renderer/src')

// Read `PlayerView.vue` explicitly rather than globbing the player styles.
// `.ctrl-btn { padding }` and `.ctrl-btn.big svg { height }` — two of the
// geometry inputs below — exist *twice*: once here and once in
// `player-menus.css`, which the menu components pull in under their own scope
// ids. Only these copies apply to the play button that sets the row height, so
// a glob would silently feed the wrong number in the moment the two diverge.
const PLAYER_VIEW = readFileSync(resolve(RENDERER, 'components/views/PlayerView.vue'), 'utf8')
const MENUS_CSS = readFileSync(resolve(RENDERER, 'assets/player-menus.css'), 'utf8')

// Parse by selector, never by line number: PRs shift every CSS line in this
// file (#224 moved them all by +2 mid-review), and a line-indexed guard rots.
function findRule(css: string, selector: string): string | null {
  const start = css.indexOf(`\n${selector} {`)
  if (start === -1) return null
  const end = css.indexOf('}', start)
  if (end <= start) return null
  return css.slice(start, end)
}

function rule(css: string, selector: string): string {
  const found = findRule(css, selector)
  expect(found, `no rule for \`${selector}\``).not.toBeNull()
  return found!
}

function px(css: string, selector: string, prop: string): number {
  const match = new RegExp(`(?:^|[;{\\n])\\s*${prop}:\\s*(-?[\\d.]+)px`).exec(rule(css, selector))
  expect(match, `\`${selector}\` declares no \`${prop}\` in px`).not.toBeNull()
  return Number(match![1])
}

function zIndex(css: string, selector: string): number {
  const match = /(?:^|[;{\n])\s*z-index:\s*(-?\d+)/.exec(rule(css, selector))
  expect(match, `\`${selector}\` declares no z-index`).not.toBeNull()
  return Number(match![1])
}

describe('player overlay stacking order (#220)', () => {
  it('paints the controls bar — and so its dropdowns — above the skip button', () => {
    // The regression assertion. Fails on the pre-fix source (bar 5 vs button
    // 12), which is exactly the inversion that let the "Skip ED" pill cover
    // the Anime4K / Sync / Translation / Quality menus and eat their clicks.
    // All four dropdowns share `.preset-menu` and declare no z-index of their
    // own, so raising the bar covers all four at once — there is no per-menu
    // path that could be fixed in isolation and no second one to miss.
    expect(zIndex(PLAYER_VIEW, '.controls-bar')).toBeGreaterThan(
      zIndex(PLAYER_VIEW, '.skip-button-overlay')
    )
  })

  it('keeps the bar below the auto-advance countdown and the remux modal', () => {
    // The over-correction guard: a bar raised past these would bury the
    // countdown's Cancel button and paint over a blocking modal.
    const bar = zIndex(PLAYER_VIEW, '.controls-bar')
    expect(bar).toBeLessThan(zIndex(PLAYER_VIEW, '.auto-advance-overlay'))
    expect(zIndex(PLAYER_VIEW, '.auto-advance-overlay')).toBeLessThan(
      zIndex(PLAYER_VIEW, '.remux-overlay')
    )
  })

  it('lifts the skip button clear of the controls bar box', () => {
    // Now that the bar wins the overlap, any overlap is an *invisible* dead
    // strip: `.controls-bar` carries `@click.stop` and no `pointer-events:
    // none`, while its gradient is nearly transparent at that height. So the
    // button's `bottom` must exceed the bar's full height, computed from the
    // live rules rather than hardcoded — a future `padding: 48px …` on the bar
    // fails here instead of silently re-growing the strip.
    //
    // `.controls-bar` has exactly two element children (`.seek-container` and
    // `.controls-row`), and `.controls-row` is a `display: flex` row with no
    // vertical padding or margin, so this sum is complete, not a lower bound.
    // Its tallest child is the `.ctrl-btn.big` play button; the `.preset-menu`
    // dropdowns are out of flow and never contribute, open or closed.
    const padding = /padding:\s*([\d.]+)px\s+[\d.]+px\s+([\d.]+)px/.exec(
      rule(PLAYER_VIEW, '.controls-bar')
    )
    expect(padding, '.controls-bar padding is no longer a 3-value px shorthand').not.toBeNull()
    // `.ctrl-btn`'s padding is doubled below, so the sum is only correct while
    // it stays a single-value shorthand.
    expect(rule(PLAYER_VIEW, '.ctrl-btn')).toMatch(/padding:\s*[\d.]+px\s*;/)

    const barHeight =
      Number(padding![1]) +
      px(PLAYER_VIEW, '.seek-container', 'height') +
      px(PLAYER_VIEW, '.seek-container', 'margin-bottom') +
      (px(PLAYER_VIEW, '.ctrl-btn', 'padding') * 2 +
        px(PLAYER_VIEW, '.ctrl-btn.big svg', 'height')) +
      Number(padding![2])

    // Deliberately a relation, not `toBe(130)`: growing the bar *and* moving
    // the button with it is a correct change and must stay green, while
    // growing the bar alone (the regression) goes red.
    expect(px(PLAYER_VIEW, '.skip-button-overlay', 'bottom')).toBeGreaterThanOrEqual(barHeight + 15)
  })

  it('leaves `.preset-menu` without a z-index of its own', () => {
    // Deliberate, and the assertion most likely to be deleted by the next
    // person it inconveniences — hence the reason in the test rather than a
    // commit message. `.preset-menu` renders inside `.controls-bar`, which is
    // a stacking context, so *no* z-index here can lift a dropdown above the
    // skip button: the value would be confined to the bar's level while
    // reading, convincingly, like a fix. The bar is the only lever.
    expect(rule(MENUS_CSS, '.preset-menu')).not.toMatch(/z-index/)
  })

  it('keeps every `.preset-menu` dropdown on that shared, unlayered rule', () => {
    // The "fixed one of two independent paths" failure mode: if a menu stopped
    // using `.preset-menu` (or grew its own stacking context), the bar-level
    // fix would quietly stop covering it. All four must stay on the shared one.
    for (const menu of ['Anime4KMenu', 'SyncplayMenu', 'TranslationMenu', 'QualityMenu']) {
      const source = readFileSync(resolve(RENDERER, `components/player/${menu}.vue`), 'utf8')
      expect(source, `${menu} no longer renders .preset-menu`).toMatch(/class="preset-menu\b/)
      expect(source, `${menu} declares its own z-index`).not.toMatch(/z-index/)
    }
  })
})

// --- #445: a positive z-index inside the bar must not escape to the bar -------
//
// The second half of the same mistake. #220 established that `.controls-bar`
// confines its descendants; what it did not cover is that the confinement stops
// there. `.seek-knob` (`2`) and `.seek-band` (`1`) sat under two positioned but
// `z-index: auto` ancestors (`.seek-container`, `.seek-track`), so neither was a
// stacking context and both values were compared at the *bar's* level — where a
// positive z-index paints in a later step than `auto` regardless of DOM order,
// and so above the `.preset-menu` dropdowns, which deliberately declare none.
// The seek bar visibly cut across the open Syncplay panel.
//
// So the assertion below is keyed to the property, not to the two selectors:
// the defect was not a wrong number, it was a value escaping its row. Anything
// new inside the bar that carries a positive z-index has to answer for itself.

const STACKING_CONTEXT_FORMS = [
  // `isolation: isolate` — the lever #445 chose, because it says why it is there.
  /(?:^|[;{\n])\s*isolation:\s*isolate\b/,
  // `position` + a numeric `z-index` — what `.controls-bar` itself does.
  /(?:^|[;{\n])\s*position:\s*(?:relative|absolute|fixed|sticky)\b/
]

// Only those two forms count. `opacity` and `transform` also create a stacking
// context in the browser, and accepting them would make this check vacuous on
// the very element it was written for: `.seek-band` carries `opacity: 0.55` of
// its own, so an `opacity`-aware predicate would let the escaping value satisfy
// itself through its own rule. Narrow on purpose.
function establishesStackingContext(css: string, selector: string): boolean {
  const found = findRule(css, selector)
  if (found === null) return false
  if (STACKING_CONTEXT_FORMS[0].test(found)) return true
  return STACKING_CONTEXT_FORMS[1].test(found) && /(?:^|[;{\n])\s*z-index:\s*-?\d+/.test(found)
}

function positiveZIndex(css: string, selector: string): number | null {
  const found = findRule(css, selector)
  if (found === null) return null
  const match = /(?:^|[;{\n])\s*z-index:\s*(-?\d+)/.exec(found)
  if (match === null) return null
  return Number(match[1]) > 0 ? Number(match[1]) : null
}

// Elements that carry no close tag, so their classes apply to a leaf and never
// become an ancestor of anything.
const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'source', 'track', 'area', 'col'])

type BarElement = { classes: string[]; ancestors: string[] }

// Walk the `.controls-bar` subtree of the template, carrying the stack of open
// tags' static classes. Nesting is what this test needs and what the
// selector-keyed helpers above cannot give: whether a z-index escapes depends
// entirely on what sits between it and the bar.
function controlsBarElements(source: string): BarElement[] {
  const template = source.slice(0, source.indexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '')
  const attr = template.indexOf('class="controls-bar"')
  expect(attr, 'no `class="controls-bar"` element in the template').toBeGreaterThan(-1)

  // Attribute values legitimately contain `>` (`v-if="… && duration > 0"` on
  // both seek bands), so tag matching has to consume quoted strings rather than
  // stop at the first `>`.
  const tags = /<(\/?)([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  tags.lastIndex = template.lastIndexOf('<', attr)

  const stack: string[][] = []
  const found: BarElement[] = []
  let match: RegExpExecArray | null
  while ((match = tags.exec(template)) !== null) {
    const [, closing, tag, attrs, selfClosing] = match
    if (closing) {
      stack.pop()
      if (stack.length === 0) return found
      continue
    }
    const classes = (/(?:^|\s)class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/).filter(Boolean)
    // The bar itself is not a subject: its own `13` resolves against
    // `.player-overlay` and is #220's, pinned above. Nor is it an ancestor that
    // could confine anything — escaping *to* the bar is the defect — so it is
    // neither recorded nor offered as a confining ancestor below.
    if (stack.length > 0) found.push({ classes, ancestors: stack.slice(1).flat() })
    if (!selfClosing && !VOID_TAGS.has(tag.toLowerCase())) stack.push(classes)
  }
  expect.fail('`.controls-bar` is not closed in the template')
}

describe('positive z-index inside the controls bar (#445)', () => {
  it('confines every positive z-index in the bar below the bar itself', () => {
    for (const { classes, ancestors } of controlsBarElements(PLAYER_VIEW)) {
      for (const cls of classes) {
        const z = positiveZIndex(PLAYER_VIEW, `.${cls}`)
        if (z === null) continue
        const confined = ancestors.some((a) => establishesStackingContext(PLAYER_VIEW, `.${a}`))
        expect(
          confined,
          `\`.${cls}\` declares \`z-index: ${z}\` and nothing between it and ` +
            '`.controls-bar` establishes a stacking context, so the value resolves at ' +
            "the bar's level and paints above the unlayered `.preset-menu` dropdowns " +
            `however late they come in the tree (#445). Ancestors walked: ${
              ancestors.map((a) => `.${a}`).join(', ') || '(none)'
            }`
        ).toBe(true)
      }
    }
  })

  it('still has positive z-indexes in the bar to confine', () => {
    // Pinned per docs/testing.md: a scan over a closed set cannot tell "nothing
    // escapes" from "the walk found nothing" — a template refactor or a tag the
    // regex above mis-parses would turn the assertion above silently green.
    // Pinning the set rather than a count also makes the next positive z-index
    // added inside the bar red here, so it gets the look #445 came out of, even
    // though the generic check would pass it once it is properly nested.
    const escaping = controlsBarElements(PLAYER_VIEW)
      .flatMap(({ classes }) => classes)
      .filter((cls) => positiveZIndex(PLAYER_VIEW, `.${cls}`) !== null)
    expect([...new Set(escaping)].sort()).toEqual(['seek-band', 'seek-knob'])
  })

  it('resolves every class in the bar statically', () => {
    // The walk reads static `class="…"` only. A `:class` binding inside the bar
    // would carry classes it cannot evaluate, so the check above would skip
    // them without saying so — red here instead of going quietly blind.
    const template = PLAYER_VIEW.slice(0, PLAYER_VIEW.indexOf('</template>'))
    const bar = template.slice(template.lastIndexOf('<', template.indexOf('class="controls-bar"')))
    expect(bar.slice(0, bar.indexOf('</transition>'))).not.toMatch(/:class=|v-bind:class=/)
  })

  it('keeps `.seek-container` the stacking context that confines them', () => {
    // Separate and direct, so deleting the one line in `PlayerView.vue` reds
    // here by name instead of just restoring the escape through the generic
    // check. Either form is a real fix; `isolation: isolate` is the one in the
    // file because it carries no ordering claim of its own.
    expect(establishesStackingContext(PLAYER_VIEW, '.seek-container')).toBe(true)
    // And the values it confines are still the ones that need confining: the
    // intra-row order (track < downloaded < buffered < progress < band < knob)
    // is what those numbers are for and is untouched by isolating the row.
    expect(positiveZIndex(PLAYER_VIEW, '.seek-knob')).toBeGreaterThan(
      positiveZIndex(PLAYER_VIEW, '.seek-band')!
    )
  })
})
