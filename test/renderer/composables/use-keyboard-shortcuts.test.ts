import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

// Run lifecycle hook bodies immediately so the composable's window listener
// registration is observable in this unit context.
vi.mock('vue', async () => {
  const actual = await vi.importActual<typeof import('vue')>('vue')
  return {
    ...actual,
    onMounted: (fn: () => void) => fn(),
    onBeforeUnmount: (fn: () => void) => {
      // Run on test teardown via beforeEach reset; expose for direct invocation
      ;(globalThis as { __unmountFns?: (() => void)[] }).__unmountFns ??= []
      ;(globalThis as { __unmountFns: (() => void)[] }).__unmountFns.push(fn)
    }
  }
})

import {
  matchesBinding,
  useKeyboardShortcuts,
  type ShortcutAction
} from '../../../src/renderer/src/composables/keyboard-shortcuts'

function ev(key: string, mods: Partial<Record<'ctrl' | 'meta' | 'shift' | 'alt', boolean>> = {}) {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt
  } as KeyboardEvent
}

describe('matchesBinding', () => {
  it('matches a plain key', () => {
    expect(matchesBinding(ev('Escape'), 'Escape')).toBe(true)
  })

  it('rejects when modifier is missing', () => {
    expect(matchesBinding(ev('f'), 'Ctrl+F')).toBe(false)
  })

  it('matches Ctrl+F when ctrl is held', () => {
    expect(matchesBinding(ev('F', { ctrl: true }), 'Ctrl+F')).toBe(true)
  })

  it('rejects when an unexpected modifier is held', () => {
    expect(matchesBinding(ev('F', { ctrl: true, shift: true }), 'Ctrl+F')).toBe(false)
  })

  it('matches Shift+Alt combinations', () => {
    expect(matchesBinding(ev('K', { shift: true, alt: true }), 'Shift+Alt+K')).toBe(true)
  })

  it('case-insensitive on the key', () => {
    expect(matchesBinding(ev('f', { ctrl: true }), 'Ctrl+F')).toBe(true)
    expect(matchesBinding(ev('F', { ctrl: true }), 'Ctrl+f')).toBe(true)
  })

  it('CmdOrCtrl resolves to Ctrl on non-Mac platforms (default test env)', () => {
    // The module sets isMac from navigator.platform; in vitest's node env there is
    // no navigator, so isMac is false (see use-shortcuts module head guard).
    expect(matchesBinding(ev('D', { ctrl: true }), 'CmdOrCtrl+D')).toBe(true)
    expect(matchesBinding(ev('D', { meta: true }), 'CmdOrCtrl+D')).toBe(false)
  })
})

describe('useKeyboardShortcuts', () => {
  let added: ((e: KeyboardEvent) => void) | null
  let removed: ((e: KeyboardEvent) => void) | null

  beforeEach(() => {
    added = null
    removed = null
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn((_: string, h: (e: KeyboardEvent) => void) => {
        added = h
      }),
      removeEventListener: vi.fn((_: string, h: (e: KeyboardEvent) => void) => {
        removed = h
      })
    }
  })

  function setup(opts: { bindings?: Record<string, string>; suppressed?: boolean }): {
    actions: ShortcutAction[]
    bindings: ReturnType<typeof ref>
    suppressWhen: ReturnType<typeof ref>
  } {
    const actions: ShortcutAction[] = []
    const bindings = ref(opts.bindings ?? {})
    const suppressWhen = ref<unknown>(opts.suppressed ? true : null)
    // `useKeyboardShortcuts` calls onMounted/onBeforeUnmount which require an
    // active component instance. We bypass that by patching the lifecycle hooks
    // on the composable's vue import — but the cleaner path is to verify the
    // registered listener works correctly. The onMounted body just adds the
    // listener via window.addEventListener — we already spy on that, so we
    // simulate the mount by directly invoking the composable; the addEventListener
    // call still records the handler (the warning about no active instance is
    // expected and harmless in this unit test).
    useKeyboardShortcuts({
      bindings,
      suppressWhen,
      onAction: (a) => actions.push(a)
    })
    return { actions, bindings, suppressWhen }
  }

  it('registers a window keydown listener on mount', () => {
    setup({ bindings: { back: 'Escape' } })
    expect(
      (globalThis.window as { addEventListener: ReturnType<typeof vi.fn> }).addEventListener
    ).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(added).not.toBeNull()
  })

  it('dispatches the action whose binding matches', () => {
    const { actions } = setup({ bindings: { back: 'Escape', focusSearch: 'Ctrl+F' } })
    added?.({
      ...ev('F', { ctrl: true }),
      target: { tagName: 'DIV' } as HTMLElement,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent)
    expect(actions).toEqual(['focusSearch'])
  })

  it('skips the "back" action when typing in an input', () => {
    const { actions } = setup({ bindings: { back: 'Escape' } })
    added?.({
      ...ev('Escape'),
      target: { tagName: 'INPUT' } as HTMLElement,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent)
    expect(actions).toEqual([])
  })

  it('still fires non-back actions inside an input', () => {
    const { actions } = setup({ bindings: { back: 'Escape', goDownloads: 'Ctrl+D' } })
    added?.({
      ...ev('D', { ctrl: true }),
      target: { tagName: 'TEXTAREA' } as HTMLElement,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent)
    expect(actions).toEqual(['goDownloads'])
  })

  it('is suppressed entirely when suppressWhen is truthy', () => {
    const { actions } = setup({ bindings: { back: 'Escape' }, suppressed: true })
    added?.({
      ...ev('Escape'),
      target: { tagName: 'DIV' } as HTMLElement,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent)
    expect(actions).toEqual([])
  })

  it('ignores empty bindings', () => {
    const { actions } = setup({ bindings: { back: '', focusSearch: 'Ctrl+F' } })
    added?.({
      ...ev('Escape'),
      target: { tagName: 'DIV' } as HTMLElement,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent)
    expect(actions).toEqual([])
  })

  it('captures an onBeforeUnmount callback that removes the keydown listener', () => {
    setup({ bindings: { back: 'Escape' } })
    const fns = (globalThis as { __unmountFns?: (() => void)[] }).__unmountFns ?? []
    expect(fns.length).toBeGreaterThan(0)
    fns[fns.length - 1]()
    expect(
      (globalThis.window as { removeEventListener: ReturnType<typeof vi.fn> }).removeEventListener
    ).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(removed).not.toBeNull()
  })
})
