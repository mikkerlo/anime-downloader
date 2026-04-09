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
      // Fix jassub for Electron: strip type: "module" from Worker constructor
      // since module workers don't work with file:// protocol
      {
        name: 'jassub-electron-fix',
        transform(code, id) {
          if (id.includes('jassub') && id.endsWith('.js') && code.includes('new Worker(new URL(')) {
            let patched = code.replace(
              /new Worker\(new URL\([^)]+\),\s*\{[^}]*\}\)/g,
              'new Worker(opts.workerUrl, { name: "jassub-worker" })'
            )
            patched = patched.replace(
              /new Worker\(opts\.workerUrl,\s*\{\s*name:\s*["']jassub-worker["'],\s*type:\s*["']module["']\s*\}\)/g,
              'new Worker(opts.workerUrl, { name: "jassub-worker" })'
            )
            return patched
          }
        }
      }
    ]
  }
})
