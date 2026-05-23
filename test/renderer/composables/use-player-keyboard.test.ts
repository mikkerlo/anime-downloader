import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import {
  usePlayerKeyboard,
  type PlayerAction
} from '../../../src/renderer/src/composables/use-player-keyboard'

type SpyDispatcher = {
  fn: ReturnType<typeof vi.fn>
  calls: PlayerAction[]
}

function makeKeyboard(overrides: {
  shortcuts?: Record<string, string>
  webgpuAvailable?: boolean
}) {
  const dispatcher: SpyDispatcher = {
    fn: vi.fn(),
    calls: []
  }
  dispatcher.fn.mockImplementation((action: PlayerAction) => {
    dispatcher.calls.push(action)
  })
  const shortcuts = ref(overrides.shortcuts ?? {})
  const webgpuAvailable = ref(overrides.webgpuAvailable ?? false)
  const { handleKeyDown } = usePlayerKeyboard({
    shortcuts,
    webgpuAvailable,
    onAction: dispatcher.fn
  })
  return { handleKeyDown, dispatcher, shortcuts, webgpuAvailable }
}

function fakeEvent(opts: {
  key: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  alt?: boolean
  target?: { tagName: string; isContentEditable?: boolean } | null
}): KeyboardEvent {
  const ev: Partial<KeyboardEvent> & {
    preventDefault: ReturnType<typeof vi.fn>
    stopPropagation: ReturnType<typeof vi.fn>
  } = {
    key: opts.key,
    ctrlKey: !!opts.ctrl,
    metaKey: !!opts.meta,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  }
  Object.defineProperty(ev, 'target', {
    value: opts.target ?? null,
    enumerable: true,
    configurable: true
  })
  return ev as KeyboardEvent
}

beforeEach(() => {
  // jsdom's document is fine — composable's onMounted call just won't fire
  // outside of a real Vue component context, which is what we want for unit
  // tests of the inner handler.
})

describe('usePlayerKeyboard — input suppression', () => {
  it('does not dispatch when target is INPUT', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: ' ', target: { tagName: 'INPUT' } }))
    expect(dispatcher.calls).toHaveLength(0)
  })

  it('does not dispatch when target is TEXTAREA', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: ' ', target: { tagName: 'TEXTAREA' } }))
    expect(dispatcher.calls).toHaveLength(0)
  })

  it('does not dispatch when target is SELECT', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: ' ', target: { tagName: 'SELECT' } }))
    expect(dispatcher.calls).toHaveLength(0)
  })

  it('does not dispatch when target is contentEditable', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: ' ', target: { tagName: 'DIV', isContentEditable: true } }))
    expect(dispatcher.calls).toHaveLength(0)
  })
})

describe('usePlayerKeyboard — episode navigation', () => {
  it('dispatches prev-episode on default Shift+ArrowLeft', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: 'ArrowLeft', shift: true }))
    expect(dispatcher.calls).toEqual(['prev-episode'])
  })

  it('dispatches next-episode on default Shift+ArrowRight', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: 'ArrowRight', shift: true }))
    expect(dispatcher.calls).toEqual(['next-episode'])
  })

  it('respects custom prev binding', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({
      shortcuts: { playerPrevEpisode: 'Alt+p' }
    })
    handleKeyDown(fakeEvent({ key: 'p', alt: true }))
    expect(dispatcher.calls).toEqual(['prev-episode'])
  })
})

describe('usePlayerKeyboard — shader bindings', () => {
  it('dispatches shader-mode-a on default Ctrl+1 when WebGPU is available', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({ webgpuAvailable: true })
    handleKeyDown(fakeEvent({ key: '1', ctrl: true }))
    expect(dispatcher.calls).toEqual(['shader-mode-a'])
  })

  it('dispatches shader-off on Ctrl+Backquote', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({ webgpuAvailable: true })
    handleKeyDown(fakeEvent({ key: 'Backquote', ctrl: true }))
    expect(dispatcher.calls).toEqual(['shader-off'])
  })

  it('skips shader bindings entirely when webgpu is unavailable', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({ webgpuAvailable: false })
    handleKeyDown(fakeEvent({ key: '1', ctrl: true }))
    expect(dispatcher.calls).toHaveLength(0)
  })

  it('respects custom shader binding override', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({
      webgpuAvailable: true,
      shortcuts: { shaderModeB: 'Alt+b' }
    })
    handleKeyDown(fakeEvent({ key: 'b', alt: true }))
    expect(dispatcher.calls).toEqual(['shader-mode-b'])
  })
})

describe('usePlayerKeyboard — built-in keys', () => {
  it('Space → play-toggle', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: ' ' }))
    expect(dispatcher.calls).toEqual(['play-toggle'])
  })

  it('k → play-toggle (lowercase + uppercase)', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: 'k' }))
    handleKeyDown(fakeEvent({ key: 'K' }))
    expect(dispatcher.calls).toEqual(['play-toggle', 'play-toggle'])
  })

  it('ArrowLeft (no shift) → seek-back', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: 'ArrowLeft' }))
    expect(dispatcher.calls).toEqual(['seek-back'])
  })

  it('ArrowRight (no shift) → seek-forward', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: 'ArrowRight' }))
    expect(dispatcher.calls).toEqual(['seek-forward'])
  })

  it('ArrowUp / ArrowDown → volume', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: 'ArrowUp' }))
    handleKeyDown(fakeEvent({ key: 'ArrowDown' }))
    expect(dispatcher.calls).toEqual(['volume-up', 'volume-down'])
  })

  it('f / F → fullscreen', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: 'f' }))
    handleKeyDown(fakeEvent({ key: 'F' }))
    expect(dispatcher.calls).toEqual(['fullscreen', 'fullscreen'])
  })

  it('m / M → mute-toggle', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: 'm' }))
    handleKeyDown(fakeEvent({ key: 'M' }))
    expect(dispatcher.calls).toEqual(['mute-toggle', 'mute-toggle'])
  })

  it('Escape → close', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: 'Escape' }))
    expect(dispatcher.calls).toEqual(['close'])
  })

  it('unhandled keys are ignored', () => {
    const { handleKeyDown, dispatcher } = makeKeyboard({})
    handleKeyDown(fakeEvent({ key: 'q' }))
    handleKeyDown(fakeEvent({ key: 'Home' }))
    expect(dispatcher.calls).toHaveLength(0)
  })
})

describe('usePlayerKeyboard — preventDefault + stopPropagation', () => {
  it('always calls stopPropagation, even when no action fires', () => {
    const { handleKeyDown } = makeKeyboard({})
    const ev = fakeEvent({ key: 'q' })
    handleKeyDown(ev)
    expect((ev.stopPropagation as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('calls preventDefault when an action matches', () => {
    const { handleKeyDown } = makeKeyboard({})
    const ev = fakeEvent({ key: 'Escape' })
    handleKeyDown(ev)
    expect((ev.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('does NOT call preventDefault on unhandled keys', () => {
    const { handleKeyDown } = makeKeyboard({})
    const ev = fakeEvent({ key: 'q' })
    handleKeyDown(ev)
    expect((ev.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('does not run handler at all when target is INPUT (returns before stop+prevent)', () => {
    const { handleKeyDown } = makeKeyboard({})
    const ev = fakeEvent({ key: 'Escape', target: { tagName: 'INPUT' } })
    handleKeyDown(ev)
    // stopPropagation always runs (it's the first line), but preventDefault doesn't.
    expect((ev.stopPropagation as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect((ev.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})
