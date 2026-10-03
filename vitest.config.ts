import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The DSP tests render seconds of audio sample by sample through the bowed-string worklet:
    // ~2.5 s locally for the slowest, about three times that on a hosted Windows CI runner.
    testTimeout: 30_000
  }
})
