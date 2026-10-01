import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { rendererConfig } from './electron.vite.config'

// `npm run dev:web`: the renderer in a plain browser (no Electron). The preload bridge is absent,
// so file dialogs fall back to browser downloads/uploads (see src/renderer/src/platform.ts).
export default defineConfig({
  ...rendererConfig,
  root: resolve(__dirname, 'src/renderer')
})
