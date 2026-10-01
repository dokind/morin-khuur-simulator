import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = {
  '@renderer': resolve(__dirname, 'src/renderer/src'),
  '@shared': resolve(__dirname, 'src/shared')
}

/**
 * Strict Content-Security-Policy for packaged builds only; the dev server needs inline React
 * Refresh preambles and websocket HMR. `blob:` covers Tone.js' clock worker.
 */
const productionCsp = (): Plugin => ({
  name: 'mkhuur-production-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content:
          "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob: data:"
      },
      injectTo: 'head-prepend'
    }
  ]
})

/** Shared with vite.web.config.ts, which serves the renderer alone in a normal browser. */
export const rendererConfig = {
  resolve: { alias },
  plugins: [react(), tailwindcss(), productionCsp()],
  server: { port: 5173, strictPort: true }
}

export default defineConfig({
  main: {
    resolve: { alias }
  },
  preload: {
    resolve: { alias }
  },
  renderer: rendererConfig
})
