// Renderer dev server without HMR, for long-running audio measurements in the browser pane that
// must not be interrupted by reloads when other files change. Not part of the app build.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { rendererConfig } from '../electron.vite.config'

export default defineConfig({
  ...rendererConfig,
  root: resolve(__dirname, '../src/renderer'),
  server: { port: 5174, strictPort: true, hmr: false, watch: null }
})
