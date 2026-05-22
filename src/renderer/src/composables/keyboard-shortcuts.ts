// Global keyboard-shortcut composable (Phase 4 slice 4e, #111).
//
// Subscribes a window-level keydown listener that matches `settingsStore.shortcuts`
// (resolved bindings from the user's preferences) and dispatches a small set of
// app-wide actions: "back" (close the open AnimeDetailView), "focusSearch"
// (navigate to search + focus its input), "goDownloads".
//
// Lives outside App.vue so the routing root can stay short. The caller passes
// the actions object so the composable doesn't have to reach into stores
// directly — keeping the composable independently testable.

import { onBeforeUnmount, onMounted } from 'vue'
import type { Ref } from 'vue'

const isMac = navigator.platform.toUpperCase().includes('MAC')

function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase())

  const needCtrl = mods.includes('ctrl')
  const needMeta = mods.includes('meta')
  const needCmdOrCtrl = mods.includes('cmdorctrl')
  const needShift = mods.includes('shift')
  const needAlt = mods.includes('alt')

  const wantCtrl = needCtrl || (needCmdOrCtrl && !isMac)
  const wantMeta = needMeta || (needCmdOrCtrl && isMac)

  if (e.ctrlKey !== wantCtrl) return false
  if (e.metaKey !== wantMeta) return false
  if (e.shiftKey !== needShift) return false
  if (e.altKey !== needAlt) return false

  return e.key.toLowerCase() === key.toLowerCase()
}

export type ShortcutAction = 'back' | 'focusSearch' | 'goDownloads'

export type ShortcutContext = {
  /** Resolved binding map from settings (action name → "Ctrl+Shift+K" form). */
  bindings: Ref<Record<string, string>>
  /** When non-null, the keyboard handler is bypassed entirely (e.g. player overlay). */
  suppressWhen: Ref<unknown>
  /** Action dispatcher — `back` is suppressed inside <input>/<textarea>/<select>. */
  onAction: (action: ShortcutAction) => void
}

export function useKeyboardShortcuts({ bindings, suppressWhen, onAction }: ShortcutContext): void {
  function handleKeydown(e: KeyboardEvent): void {
    if (suppressWhen.value) return

    const tag = (e.target as HTMLElement).tagName
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

    for (const [action, binding] of Object.entries(bindings.value)) {
      if (!binding) continue
      if (!matchesBinding(e, binding)) continue
      if (action === 'back' && isInput) continue
      e.preventDefault()
      onAction(action as ShortcutAction)
      return
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleKeydown)
  })
}
