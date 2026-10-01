import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSong, verifySong } from '@renderer/core/notation'
import { detectPitch } from '@renderer/core/pitch-detect'
import { centsBetween } from '@renderer/core/pitch'
import { encodeWav } from '@renderer/core/wav'
import { renderSongNode } from './render-node'

// The offline Node render (scripts/render-song.mjs) of the first etude: every bowed single note
// lands within the Song Tester's tolerance, measured with the same YIN helper.
const PITCH_TOLERANCE_CENTS = 5
const song = parseSong(JSON.parse(readFileSync(join(__dirname, '../../../../../songs/01-open-strings.mkhuur.json'), 'utf8'))).song!
const report = verifySong(song)
const out = renderSongNode(song, report)

describe('renderSongNode', () => {
  it('renders 01-open-strings at 48 kHz, every note bowed, peak at −1 dBFS', () => {
    expect(out.sampleRate).toBe(48000)
    expect(out.events.length).toBe(song.notes.length)
    expect(out.skipped.filter((e) => e.order >= 0)).toEqual([])
    let peak = 0
    for (const v of out.samples) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeCloseTo(0.89, 5)
    expect(out.samples.every(Number.isFinite)).toBe(true)
  })

  it('each single note sounds its written pitch', () => {
    const sr = out.sampleRate
    const singles = out.events.filter((e) => !e.event.droneFreq)
    expect(singles.length).toBeGreaterThanOrEqual(8)
    for (const e of singles) {
      // The steady middle of the stroke: past the landing, before the release.
      const from = e.start + Math.min(0.25, e.event.duration * 0.35)
      const to = e.start + e.event.duration * 0.85
      const est = detectPitch(out.samples.subarray(Math.floor(from * sr), Math.floor(to * sr)), sr, { maxFreq: 2500 })
      expect(est, `pitch at ${e.start.toFixed(2)} s`).not.toBeNull()
      expect(Math.abs(centsBetween(e.event.freq!, est!.freq)), `note at ${e.start.toFixed(2)} s`).toBeLessThan(PITCH_TOLERANCE_CENTS)
    }
  })

  it('encodes to a 48 kHz 16-bit mono WAV', () => {
    const wav = encodeWav({ sampleRate: out.sampleRate, channels: [out.samples] })
    const view = new DataView(wav.buffer)
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(wav.length).toBe(44 + out.samples.length * 2)
  })
})
