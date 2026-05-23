import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAnime4K } from '../../../src/renderer/src/composables/use-anime4k'

function makeDeps(overrides: Partial<Parameters<typeof useAnime4K>[0]> = {}) {
  return {
    getVideoEl: () => null,
    getCanvasEl: () => null,
    ...overrides
  } as Parameters<typeof useAnime4K>[0]
}

function stubGpu(gpu: unknown): void {
  const g = globalThis as { navigator?: { gpu?: unknown } }
  if (typeof g.navigator === 'undefined') {
    g.navigator = { gpu }
    return
  }
  Object.defineProperty(g.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true
  })
}

beforeEach(() => {
  // Ensure WebGPU is unavailable by default. Vitest runs under
  // `environment: 'node'` where `navigator` may not exist at all.
  stubGpu(undefined)
})

describe('useAnime4K — initial state', () => {
  it('starts with preset off, no WebGPU, no GPU name', () => {
    const a = useAnime4K(makeDeps())
    expect(a.anime4kPreset.value).toBe('off')
    expect(a.webgpuAvailable.value).toBe(false)
    expect(a.gpuName.value).toBe('')
    expect(a.anime4kActive.value).toBe(false)
  })
})

describe('useAnime4K — anime4kActive computed', () => {
  it('is false while webgpuAvailable is false even if preset is set', () => {
    const a = useAnime4K(makeDeps())
    a.anime4kPreset.value = 'mode-a'
    expect(a.anime4kActive.value).toBe(false)
  })

  it('becomes true once webgpuAvailable + non-off preset', () => {
    const a = useAnime4K(makeDeps())
    a.webgpuAvailable.value = true
    a.anime4kPreset.value = 'mode-b'
    expect(a.anime4kActive.value).toBe(true)
  })

  it('flips back to false when preset returns to off', () => {
    const a = useAnime4K(makeDeps())
    a.webgpuAvailable.value = true
    a.anime4kPreset.value = 'mode-c'
    expect(a.anime4kActive.value).toBe(true)
    a.anime4kPreset.value = 'off'
    expect(a.anime4kActive.value).toBe(false)
  })
})

describe('useAnime4K — presetLabel computed', () => {
  it('formats each preset label', () => {
    const a = useAnime4K(makeDeps())
    expect(a.presetLabel.value).toBe('A4K Off')
    a.anime4kPreset.value = 'mode-a'
    expect(a.presetLabel.value).toBe('A4K: A')
    a.anime4kPreset.value = 'mode-b'
    expect(a.presetLabel.value).toBe('A4K: B')
    a.anime4kPreset.value = 'mode-c'
    expect(a.presetLabel.value).toBe('A4K: C')
  })
})

describe('useAnime4K — initWebGPU', () => {
  it('leaves webgpuAvailable false when navigator.gpu is missing', async () => {
    const a = useAnime4K(makeDeps())
    await a.initWebGPU()
    expect(a.webgpuAvailable.value).toBe(false)
    expect(a.gpuName.value).toBe('')
  })

  it('leaves webgpuAvailable false when adapter request returns null', async () => {
    stubGpu({ requestAdapter: vi.fn().mockResolvedValue(null) })
    const a = useAnime4K(makeDeps())
    await a.initWebGPU()
    expect(a.webgpuAvailable.value).toBe(false)
  })

  it('captures gpu name + sets webgpuAvailable when adapter + device resolve', async () => {
    const fakeDevice = { destroy: vi.fn() }
    stubGpu({
      requestAdapter: vi.fn().mockResolvedValue({
        info: { device: 'NVIDIA RTX 9999' },
        requestDevice: vi.fn().mockResolvedValue(fakeDevice)
      })
    })
    const a = useAnime4K(makeDeps())
    await a.initWebGPU()
    expect(a.webgpuAvailable.value).toBe(true)
    expect(a.gpuName.value).toBe('NVIDIA RTX 9999')
  })

  it('swallows exceptions and stays unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubGpu({ requestAdapter: vi.fn().mockRejectedValue(new Error('boom')) })
    const a = useAnime4K(makeDeps())
    await a.initWebGPU()
    expect(a.webgpuAvailable.value).toBe(false)
    warn.mockRestore()
  })
})

describe('useAnime4K — startPipeline guards', () => {
  it('is a no-op when video element is null', async () => {
    const a = useAnime4K(makeDeps({ getVideoEl: () => null }))
    await expect(a.startPipeline()).resolves.toBeUndefined()
  })

  it('is a no-op when canvas element is null', async () => {
    const a = useAnime4K(
      makeDeps({ getVideoEl: () => ({ videoWidth: 1920, videoHeight: 1080 }) as HTMLVideoElement })
    )
    await expect(a.startPipeline()).resolves.toBeUndefined()
  })

  it('is a no-op when preset is off', async () => {
    const a = useAnime4K(makeDeps())
    a.anime4kPreset.value = 'off'
    await expect(a.startPipeline()).resolves.toBeUndefined()
  })
})

describe('useAnime4K — destroy', () => {
  it('is safe to call without ever calling initWebGPU', () => {
    const a = useAnime4K(makeDeps())
    expect(() => a.destroy()).not.toThrow()
  })

  it('destroys the GPU device after init', async () => {
    const destroySpy = vi.fn()
    stubGpu({
      requestAdapter: vi.fn().mockResolvedValue({
        info: { vendor: 'TestVendor' },
        requestDevice: vi.fn().mockResolvedValue({ destroy: destroySpy })
      })
    })
    const a = useAnime4K(makeDeps())
    await a.initWebGPU()
    a.destroy()
    expect(destroySpy).toHaveBeenCalledTimes(1)
  })
})

describe('useAnime4K — stopPipeline', () => {
  it('is safe to call when no pipeline is running', () => {
    const a = useAnime4K(makeDeps())
    expect(() => a.stopPipeline()).not.toThrow()
  })

  it('is idempotent', () => {
    const a = useAnime4K(makeDeps())
    a.stopPipeline()
    a.stopPipeline()
    a.stopPipeline()
    expect(true).toBe(true)
  })
})
