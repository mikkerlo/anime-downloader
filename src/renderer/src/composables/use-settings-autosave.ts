// Settings autosave (Phase 5 slice 5a, #118).
//
// Shared across every tab in `components/settings/`. Module-level state keeps
// the "Saved" toast a singleton — any tab's autoSave triggers the same visible
// flash in SettingsShell.vue.

import { ref } from 'vue'

const savedVisible = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

function showSaved(): void {
  savedVisible.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    savedVisible.value = false
  }, 1500)
}

function autoSave(key: string, value: unknown): void {
  void window.api.setSetting(key, value as never)
  showSaved()
}

export function useSettingsAutosave(): {
  savedVisible: typeof savedVisible
  showSaved: typeof showSaved
  autoSave: typeof autoSave
} {
  return { savedVisible, showSaved, autoSave }
}
