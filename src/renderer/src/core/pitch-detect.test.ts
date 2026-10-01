import { describe, expect, it } from 'vitest'
import { detectPitch } from './pitch-detect'
import { centsBetween } from './pitch'

const SR = 44100

/** Band-limited (additive) sawtooth, like the PeriodicWave oscillators Tone.js renders. */
function sawtooth(freq: number, seconds: number, detuneCents = 0): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds))
  const f = freq * 2 ** (detuneCents / 1200)
  const partials = Math.floor(SR / 2 / f)
  for (let i = 0; i < out.length; i++) {
    let v = 0
    for (let k = 1; k <= partials; k++) v += Math.sin((2 * Math.PI * k * f * i) / SR) / k
    out[i] = (2 / Math.PI) * v
  }
  return out
}

describe('detectPitch (YIN)', () => {
  it.each([174.61, 233.08, 466.16, 1165.4])('finds %f Hz within 1 cent on a sawtooth', (freq) => {
    const est = detectPitch(sawtooth(freq, 0.2), SR, { maxFreq: 2500 })!
    expect(Math.abs(centsBetween(freq, est.freq))).toBeLessThan(1)
    expect(est.confidence).toBeGreaterThan(0.9)
  })

  it('tracks the centre of a chorus of detuned strings (horsehair bundles)', () => {
    const a = sawtooth(233.08, 0.3, -6)
    const b = sawtooth(233.08, 0.3)
    const c = sawtooth(233.08, 0.3, 6)
    const mix = a.map((v, i) => (v + b[i]! + c[i]!) / 3)
    const est = detectPitch(mix, SR)!
    expect(Math.abs(centsBetween(233.08, est.freq))).toBeLessThan(5)
  })

  it('finds the true pitch when the fundamental is very weak (missing fundamental)', () => {
    const f = 174.61
    const out = new Float32Array(Math.floor(SR * 0.25))
    for (let i = 0; i < out.length; i++) {
      let v = 0.03 * Math.sin((2 * Math.PI * f * i) / SR) // fundamental ~26 dB down
      for (let k = 2; k <= 12; k++) v += Math.sin((2 * Math.PI * k * f * i) / SR + k) / k
      out[i] = v
    }
    const est = detectPitch(out, SR)!
    expect(Math.abs(centsBetween(f, est.freq))).toBeLessThan(2)
  })

  it('still reports a genuine octave (the signal really repeats at half the period)', () => {
    const est = detectPitch(sawtooth(349.23, 0.25), SR)!
    expect(Math.abs(centsBetween(349.23, est.freq))).toBeLessThan(2)
  })

  it('does not halve the pitch of a noisy high note (bow noise, flautando)', () => {
    // Band-limited sawtooth plus seeded white noise: YIN's normalisation then dips lower at twice
    // the period, but nothing sounds between the harmonics, so the note is still C5.
    let seed = 7
    const noise = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1
    for (const level of [0.1, 0.25, 0.4]) {
      const tone = sawtooth(523.25, 0.4).map((v) => v * 0.5 + level * noise())
      const est = detectPitch(tone, SR, { minFreq: 60, maxFreq: 2500 })
      expect(est, `noise ${level}`).not.toBeNull()
      expect(Math.abs(centsBetween(523.25, est!.freq)), `noise ${level}`).toBeLessThan(5)
    }
  })

  it('returns null for silence-free noise', () => {
    let seed = 1
    const noise = new Float32Array(8192).map(() => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647 - 0.5
    })
    expect(detectPitch(noise, SR)).toBeNull()
  })
})
