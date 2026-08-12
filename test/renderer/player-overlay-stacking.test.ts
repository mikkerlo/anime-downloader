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
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `no rule for \`${selector}\``).toBeGreaterThan(-1)
  const end = css.indexOf('}', start)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
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
