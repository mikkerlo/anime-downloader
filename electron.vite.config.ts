import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        'anime4k-webgpu': resolve('node_modules/anime4k-webgpu')
      }
    },
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    },
    worker: {
      format: 'es'
    },
    plugins: [
      vue(),
      // Prevent Vite from detecting and bundling jassub's internal Worker() call
      {
        name: 'jassub-worker-fix',
        transform(code, id) {
          if (id.includes('jassub') && id.endsWith('.js') && code.includes('new Worker(new URL(')) {
            return code.replace(
              /new Worker\(new URL\([^)]+\),\s*\{[^}]*\}\)/g,
              'new Worker(opts.workerUrl, { name: "jassub-worker", type: "module" })'
            )
          }
        }
      }
    ]
  }
})
