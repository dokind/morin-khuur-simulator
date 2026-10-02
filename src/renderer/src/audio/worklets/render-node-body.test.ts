import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSong, verifySong } from '@renderer/core/notation'
import { detectPitch } from '@renderer/core/pitch-detect'
import { centsBetween } from '@renderer/core/pitch'
import { RENDER_CHECKS, bulanovMaxima } from '@renderer/core/analysis'
import { convolve, renderSongNode } from './render-node'

// The Node render's soundbox (render-node.ts `soundbox`, body.ts's chain in arithmetic). The dry
// string leaves the simulator without the instrument's body; with it, the render shows Bulanov's
// measured radiated maxima (the same check the app's own renders are held to) and every note still
// lands within the Song Tester's 5 cents.
const PITCH_TOLERANCE_CENTS = 5
const songAt = (name: string) => parseSong(JSON.parse(readFileSync(join(__dirname, '../../../../../songs', name), 'utf8'))).song!

describe('convolve', () => {
  it('matches direct convolution', () => {
    let s = 7
    const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1
    const x = Float32Array.from({ length: 3001 }, rand)
    const h = Float32Array.from({ length: 257 }, rand)
    const y = convolve(x, h)
    expect(y.length).toBe(x.length)
    for (const i of [0, 1, 256, 257, 1000, 2047, 2048, 3000]) {
      let direct = 0
      for (let k = 0; k < h.length && k <= i; k++) direct += h[k]! * x[i - k]!
      expect(y[i]!).toBeCloseTo(direct, 4)
    }
  })
})

describe('renderSongNode soundbox', () => {
  const song = songAt('02-first-position-scale.mkhuur.json')
  const report = verifySong(song)
  const wet = renderSongNode(song, report)
  const dry = renderSongNode(song, report, { body: 'none' })

  // Read off each note's own harmonic levels (the scale steps through enough pitches for the
  // 'harmonics' method; the envelope fallback finds peaks in the dry string too, so it proves
  // nothing here). Measured 2026-10-02: wet 5 of 8 maxima (280, 440, 780, 1200, 2300 Hz) with the
  // 280–780 Hz levels 1.4 dB apart; dry none. Five, not the six `ok` asks for: the scale only
  // samples six of the eight regions.
  it('shows the soundbox maxima Bulanov measured, which the dry string does not', () => {
    const w = bulanovMaxima({ samples: wet.samples, sampleRate: wet.sampleRate })
    const d = bulanovMaxima({ samples: dry.samples, sampleRate: dry.sampleRate })
    expect(w.method).toBe('harmonics')
    expect(w.found).toBeGreaterThanOrEqual(5)
    expect(w.midSpreadDb!).toBeLessThanOrEqual(RENDER_CHECKS.bulanovMidSpreadDb)
    expect(d.found).toBeLessThanOrEqual(1)
  })

  it('keeps every single note within 5 cents', () => {
    const sr = wet.sampleRate
    const singles = wet.events.filter((e) => !e.event.droneFreq)
    expect(singles.length).toBeGreaterThanOrEqual(6)
    for (const e of singles) {
      const from = e.start + Math.min(0.25, e.event.duration * 0.35)
      const to = e.start + e.event.duration * 0.85
      const est = detectPitch(wet.samples.subarray(Math.floor(from * sr), Math.floor(to * sr)), sr, { maxFreq: 2500 })
      expect(est, `pitch at ${e.start.toFixed(2)} s`).not.toBeNull()
      expect(Math.abs(centsBetween(e.event.freq!, est!.freq)), `note at ${e.start.toFixed(2)} s`).toBeLessThan(PITCH_TOLERANCE_CENTS)
    }
  })
})
