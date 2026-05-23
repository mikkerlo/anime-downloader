// Anime4K WebGPU upscaling pipeline for PlayerView (Phase 5 slice 5d.2.a, #118).
//
// Owns the WebGPU device + pipeline lifecycle that runs the `anime4k-webgpu`
// compute shaders against the active <video> frame and presents the result on
// a `<canvas>`. The preset ref drives which mode the pipeline uses; consumers
// drive start/stop via the preset watcher + lifecycle hooks (so the
// composable is testable without a Vue runtime / GPU adapter).
//
// Does NOT own: the preset-changed `watch` (caller persists to settings +
// drives start/stop), the menu UI state (`showPresetMenu`), or the keyboard
// dispatch for shader presets (that lives in `usePlayerKeyboard`).

import { computed, ref, type ComputedRef, type Ref } from 'vue'

const FULLSCREEN_QUAD_VERT = `
@vertex
fn vert_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
    vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1)
  );
  return vec4f(pos[idx], 0, 1);
}
`

const FULLSCREEN_QUAD_FRAG = `
@group(0) @binding(0) var mySampler: sampler;
@group(0) @binding(1) var myTexture: texture_2d<f32>;

@fragment
fn main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(myTexture));
  let tc = coord.xy / dims;
  // Flip Y so video isn't upside down
  return textureSample(myTexture, mySampler, vec2f(tc.x, tc.y));
}
`

export type Anime4KPreset = 'off' | 'mode-a' | 'mode-b' | 'mode-c'

export function useAnime4K(deps: {
  /** Live <video> element getter — re-resolved at start time, not captured. */
  getVideoEl: () => HTMLVideoElement | null
  /** Live <canvas> element getter — the WebGPU pipeline output sink. */
  getCanvasEl: () => HTMLCanvasElement | null
}): {
  anime4kPreset: Ref<Anime4KPreset>
  webgpuAvailable: Ref<boolean>
  gpuName: Ref<string>
  anime4kActive: ComputedRef<boolean>
  presetLabel: ComputedRef<string>
  initWebGPU: () => Promise<void>
  startPipeline: () => Promise<void>
  stopPipeline: () => void
  destroy: () => void
} {
  const anime4kPreset = ref<Anime4KPreset>('off')
  const webgpuAvailable = ref(false)
  const gpuName = ref('')

  const anime4kActive = computed(() => webgpuAvailable.value && anime4kPreset.value !== 'off')

  const presetLabel = computed(() => {
    const labels: Record<string, string> = {
      off: 'A4K Off',
      'mode-a': 'A4K: A',
      'mode-b': 'A4K: B',
      'mode-c': 'A4K: C'
    }
    return labels[anime4kPreset.value] || 'A4K'
  })

  let gpuDevice: GPUDevice | null = null
  let pipelineActive = false

  async function initWebGPU(): Promise<void> {
    try {
      if (!navigator.gpu) return
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) return
      const info = adapter.info
      gpuName.value = info.device || info.description || info.vendor || 'Unknown GPU'
      gpuDevice = await adapter.requestDevice()
      webgpuAvailable.value = true
    } catch (e) {
      console.warn('[player] WebGPU init failed:', e)
    }
  }

  async function startPipeline(): Promise<void> {
    stopPipeline()

    const video = deps.getVideoEl()
    const canvas = deps.getCanvasEl()
    if (!video || !canvas || !gpuDevice || anime4kPreset.value === 'off') return
    if (!video.videoWidth || !video.videoHeight) return

    try {
      const { ModeA, ModeB, ModeC } = await import('anime4k-webgpu')
      const device = gpuDevice

      const PresetClass = {
        'mode-a': ModeA,
        'mode-b': ModeB,
        'mode-c': ModeC
      }[anime4kPreset.value]
      if (!PresetClass) return

      const WIDTH = video.videoWidth
      const HEIGHT = video.videoHeight

      const videoFrameTexture = device.createTexture({
        size: [WIDTH, HEIGHT, 1],
        format: 'rgba16float',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT
      })

      // Cap upscale at screen resolution so GPU load stays bounded.
      const screenW = Math.round(window.screen.width * window.devicePixelRatio)
      const screenH = Math.round(window.screen.height * window.devicePixelRatio)
      const targetW = Math.min(screenW, WIDTH * 2)
      const targetH = Math.min(screenH, HEIGHT * 2)

      const pipeline = new PresetClass({
        device,
        inputTexture: videoFrameTexture,
        nativeDimensions: { width: WIDTH, height: HEIGHT },
        targetDimensions: { width: targetW, height: targetH }
      })

      const outputTex = pipeline.getOutputTexture()
      canvas.width = outputTex.width
      canvas.height = outputTex.height

      const context = canvas.getContext('webgpu') as GPUCanvasContext
      const presentationFormat = navigator.gpu.getPreferredCanvasFormat()
      context.configure({ device, format: presentationFormat, alphaMode: 'premultiplied' })

      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }
        ]
      })

      const renderPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        vertex: {
          module: device.createShaderModule({ code: FULLSCREEN_QUAD_VERT }),
          entryPoint: 'vert_main'
        },
        fragment: {
          module: device.createShaderModule({ code: FULLSCREEN_QUAD_FRAG }),
          entryPoint: 'main',
          targets: [{ format: presentationFormat }]
        },
        primitive: { topology: 'triangle-list' }
      })

      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
      const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: outputTex.createView() }
        ]
      })

      pipelineActive = true

      function frame(): void {
        if (!pipelineActive) return

        try {
          device.queue.copyExternalImageToTexture(
            { source: video! },
            { texture: videoFrameTexture },
            [WIDTH, HEIGHT]
          )

          const commandEncoder = device.createCommandEncoder()
          pipeline.pass(commandEncoder)

          const passEncoder = commandEncoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store'
              }
            ]
          })
          passEncoder.setPipeline(renderPipeline)
          passEncoder.setBindGroup(0, bindGroup)
          passEncoder.draw(6)
          passEncoder.end()

          device.queue.submit([commandEncoder.finish()])
        } catch (e) {
          console.warn('[player] Anime4K frame error:', e)
          pipelineActive = false
          return
        }

        video!.requestVideoFrameCallback(frame)
      }

      video.requestVideoFrameCallback(frame)
    } catch (e) {
      console.error('[player] Anime4K pipeline error:', e)
    }
  }

  function stopPipeline(): void {
    pipelineActive = false
  }

  function destroy(): void {
    stopPipeline()
    if (gpuDevice) {
      try {
        gpuDevice.destroy()
      } catch {
        /* ignore */
      }
      gpuDevice = null
    }
  }

  return {
    anime4kPreset,
    webgpuAvailable,
    gpuName,
    anime4kActive,
    presetLabel,
    initWebGPU,
    startPipeline,
    stopPipeline,
    destroy
  }
}
