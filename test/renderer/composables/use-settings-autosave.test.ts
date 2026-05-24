import { describe, it, expect, beforeEach, vi } from 'vitest'

let setSetting: ReturnType<typeof vi.fn>

function installApi(): void {
  setSetting = vi.fn(async () => undefined)
  ;(globalThis as { window?: { api: unknown } }).window = {
    api: { setSetting }
  }
}

beforeEach(() => {
  installApi()
  vi.useFakeTimers()
  vi.resetModules()
})

describe('useSettingsAutosave', () => {
  it('exposes a falsy savedVisible by default', async () => {
    const { useSettingsAutosave } =
      await import('../../../src/renderer/src/composables/use-settings-autosave')
    const { savedVisible } = useSettingsAutosave()
    expect(savedVisible.value).toBe(false)
  })

  it('autoSave persists the value via IPC and flashes savedVisible', async () => {
    const { useSettingsAutosave } =
      await import('../../../src/renderer/src/composables/use-settings-autosave')
    const { savedVisible, autoSave } = useSettingsAutosave()
    autoSave('theme', 'dark')
    expect(setSetting).toHaveBeenCalledWith('theme', 'dark')
    expect(savedVisible.value).toBe(true)
  })

  it('savedVisible auto-clears after 1500ms', async () => {
    const { useSettingsAutosave } =
      await import('../../../src/renderer/src/composables/use-settings-autosave')
    const { savedVisible, showSaved } = useSettingsAutosave()
    showSaved()
    expect(savedVisible.value).toBe(true)
    vi.advanceTimersByTime(1499)
    expect(savedVisible.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect(savedVisible.value).toBe(false)
  })

  it('repeated showSaved() resets the timer (debounce-like)', async () => {
    const { useSettingsAutosave } =
      await import('../../../src/renderer/src/composables/use-settings-autosave')
    const { savedVisible, showSaved } = useSettingsAutosave()
    showSaved()
    vi.advanceTimersByTime(1000)
    showSaved() // resets the timer
    vi.advanceTimersByTime(1000) // 2000ms total, but only 1000ms since last reset
    expect(savedVisible.value).toBe(true)
    vi.advanceTimersByTime(500)
    expect(savedVisible.value).toBe(false)
  })

  it('savedVisible state is shared across multiple consumers (module-level ref)', async () => {
    const { useSettingsAutosave } =
      await import('../../../src/renderer/src/composables/use-settings-autosave')
    const a = useSettingsAutosave()
    const b = useSettingsAutosave()
    a.showSaved()
    expect(b.savedVisible.value).toBe(true)
  })
})
