import { describe, expect, it } from 'vitest'
import { blackmanHarrisWindow, fft, hannWindow, isPowerOfTwo, nextPowerOfTwo } from './fft'

describe('fft', () => {
  it('matches a direct DFT', () => {
    const n = 64
    let seed = 7
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647 - 0.5
    }
    const x = Array.from({ length: n }, random)
    const re = Float64Array.from(x)
    const im = new Float64Array(n)
    fft(re, im)
    for (let k = 0; k < n; k++) {
      let dr = 0
      let di = 0
      for (let j = 0; j < n; j++) {
        dr += x[j]! * Math.cos((2 * Math.PI * j * k) / n)
        di -= x[j]! * Math.sin((2 * Math.PI * j * k) / n)
      }
      expect(re[k]).toBeCloseTo(dr, 9)
      expect(im[k]).toBeCloseTo(di, 9)
    }
  })

  it('puts a bin-centred cosine in its bin', () => {
    const n = 1024
    const re = Float64Array.from({ length: n }, (_, j) => Math.cos((2 * Math.PI * 37 * j) / n))
    const im = new Float64Array(n)
    fft(re, im)
    expect(re[37]).toBeCloseTo(n / 2, 6)
    expect(re[n - 37]).toBeCloseTo(n / 2, 6)
    expect(Math.hypot(re[36]!, im[36]!)).toBeLessThan(1e-6)
  })

  it('rejects lengths that are not powers of two', () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow()
  })
})

describe('fft helpers', () => {
  it('rounds up to powers of two', () => {
    expect(nextPowerOfTwo(1000)).toBe(1024)
    expect(nextPowerOfTwo(1024)).toBe(1024)
    expect(nextPowerOfTwo(0.5)).toBe(1)
    expect(isPowerOfTwo(4096)).toBe(true)
    expect(isPowerOfTwo(3000)).toBe(false)
  })

  it('builds a periodic Hann window', () => {
    const w = hannWindow(8)
    expect(w[0]).toBe(0)
    expect(w[4]).toBeCloseTo(1, 12)
    expect(w[2]).toBeCloseTo(0.5, 12)
    expect(hannWindow(8)).toBe(w)
  })

  it('builds a periodic Blackman–Harris window with sidelobes below −90 dB', () => {
    const w = blackmanHarrisWindow(1024)
    expect(w[0]).toBeCloseTo(6e-5, 6)
    expect(w[512]).toBeCloseTo(1, 12)
    expect(w[100]).toBeCloseTo(w[924]!, 12)
    expect(blackmanHarrisWindow(1024)).toBe(w)
    // A tone halfway between bins, zero-padded ×4: nothing above −90 dB beyond ±4 bins.
    const re = new Float64Array(4096)
    const im = new Float64Array(4096)
    for (let j = 0; j < 1024; j++) re[j] = Math.cos((2 * Math.PI * 100.5 * j) / 1024) * w[j]!
    fft(re, im)
    const power = Array.from({ length: 2048 }, (_, k) => Math.hypot(re[k]!, im[k]!))
    const peak = Math.max(...power)
    const far = power.filter((_, k) => Math.abs(k / 4 - 100.5) > 4.5)
    expect(20 * Math.log10(Math.max(...far) / peak)).toBeLessThan(-90)
  })
})
