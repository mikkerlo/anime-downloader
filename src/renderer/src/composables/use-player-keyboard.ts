// PlayerView keyboard dispatch (Phase 5 slice 5d.2.a, #118).
//
// Owns the `document`-level keydown listener that powers in-player shortcuts:
// space/k toggles playback, arrows seek + adjust volume, f / m / Escape, and
// the configurable bindings for prev/next episode + Anime4K shader presets.
// The composable dispatches via an `onAction` callback rather than reaching
// into PlayerView state directly — keeps it testable + matches the
// `keyboard-shortcuts.ts` precedent for App-level shortcuts.
//
// `document` not `window` because PlayerView is a modal-style overlay and
// expects to swallow keys even when focus isn't strictly inside the player.

import { onBeforeUnmount, onMounted, type Ref } from 'vue'
import { matchesBinding } from './keyboard-shortcuts'

export type PlayerAction =
  | 'prev-episode'
  | 'next-episode'
  | 'shader-mode-a'
  | 'shader-mode-b'
  | 'shader-mode-c'
  | 'shader-off'
  | 'play-toggle'
  | 'seek-back'
  | 'seek-forward'
  | 'volume-up'
  | 'volume-down'
  | 'fullscreen'
  | 'mute-toggle'
  | 'close'

export type PlayerKeyboardDeps = {
  /** Resolved shortcut bindings (action name → "CmdOrCtrl+1" etc.). */
  shortcuts: Ref<Record<string, string>>
  /** Gate shader actions — when false, they're skipped entirely. */
  webgpuAvailable: Ref<boolean>
  /** Action dispatcher — receives the action plus the original event. */
  onAction: (action: PlayerAction, event: KeyboardEvent) => void
}

const SHADER_BINDING_DEFAULTS: Record<string, string> = {
  shaderModeA: 'CmdOrCtrl+1',
  shaderModeB: 'CmdOrCtrl+2',
  shaderModeC: 'CmdOrCtrl+3',
  shaderOff: 'CmdOrCtrl+Backquote'
}

const SHADER_ACTION_FOR: Record<string, PlayerAction> = {
  shaderModeA: 'shader-mode-a',
  shaderModeB: 'shader-mode-b',
  shaderModeC: 'shader-mode-c',
  shaderOff: 'shader-off'
}

export function usePlayerKeyboard({ shortcuts, webgpuAvailable, onAction }: PlayerKeyboardDeps): {
  handleKeyDown: (e: KeyboardEvent) => void
} {
  function handleKeyDown(event: KeyboardEvent): void {
    event.stopPropagation()
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable)
      return

    const prevBinding = shortcuts.value.playerPrevEpisode || 'Shift+ArrowLeft'
    const nextBinding = shortcuts.value.playerNextEpisode || 'Shift+ArrowRight'
    if (matchesBinding(event, prevBinding)) {
      event.preventDefault()
      onAction('prev-episode', event)
      return
    }
    if (matchesBinding(event, nextBinding)) {
      event.preventDefault()
      onAction('next-episode', event)
      return
    }

    if (webgpuAvailable.value) {
      for (const key of Object.keys(SHADER_ACTION_FOR)) {
        const binding = shortcuts.value[key] || SHADER_BINDING_DEFAULTS[key]
        if (matchesBinding(event, binding)) {
          event.preventDefault()
          onAction(SHADER_ACTION_FOR[key], event)
          return
        }
      }
    }

    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        event.preventDefault()
        onAction('play-toggle', event)
        break
      case 'ArrowLeft':
        event.preventDefault()
        onAction('seek-back', event)
        break
      case 'ArrowRight':
        event.preventDefault()
        onAction('seek-forward', event)
        break
      case 'ArrowUp':
        event.preventDefault()
        onAction('volume-up', event)
        break
      case 'ArrowDown':
        event.preventDefault()
        onAction('volume-down', event)
        break
      case 'f':
      case 'F':
        event.preventDefault()
        onAction('fullscreen', event)
        break
      case 'm':
      case 'M':
        event.preventDefault()
        onAction('mute-toggle', event)
        break
      case 'Escape':
        event.preventDefault()
        onAction('close', event)
        break
    }
  }

  onMounted(() => {
    document.addEventListener('keydown', handleKeyDown)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('keydown', handleKeyDown)
  })

  return { handleKeyDown }
}
