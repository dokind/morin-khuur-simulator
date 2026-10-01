/**
 * Radix-2 FFT and analysis windows for the recording analysis (`analysis.ts`). Pure TypeScript;
 * twiddle and window tables are plain data cached per size.
 */

interface FftTable {
  cos: Float64Array
  sin: Float64Array
  reverse: Uint32Array
}

const tables = new Map<number, FftTable>()
const hannWindows = new Map<number, Float64Array>()
const blackmanHarrisWindows = new Map<number, Float64Array>()

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0
}

/** Smallest power of two ≥ n (1 for n ≤ 1). */
export function nextPowerOfTwo(n: number): number {
  let p = 1
  while (p < n) p *= 2
  return p
}

function table(n: number): FftTable {
  let t = tables.get(n)
  if (!t) {
    const cos = new Float64Array(n / 2)
    const sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n)
      sin[i] = -Math.sin((2 * Math.PI * i) / n)
    }
    const bits = Math.round(Math.log2(n))
    const reverse = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1)
      reverse[i] = r
    }
    t = { cos, sin, reverse }
    tables.set(n, t)
  }
  return t
}

/** In-place forward DFT, X[k] = Σ x[j]·e^(−2πijk/n), for power-of-two lengths. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (im.length !== n || !isPowerOfTwo(n)) throw new Error(`fft: length must be a power of two (got ${n}/${im.length})`)
  if (n === 1) return
  const { cos, sin, reverse } = table(n)
  for (let i = 0; i < n; i++) {
    const j = reverse[i]!
    if (j > i) {
      const r = re[i]!
      re[i] = re[j]!
      re[j] = r
      const m = im[i]!
      im[i] = im[j]!
      im[j] = m
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2
    const step = n / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!
        const wi = sin[k * step]!
        const a = start + k
        const b = a + half
        const tr = re[b]! * wr - im[b]! * wi
        const ti = re[b]! * wi + im[b]! * wr
        re[b] = re[a]! - tr
        im[b] = im[a]! - ti
        re[a] = re[a]! + tr
        im[a] = im[a]! + ti
      }
    }
  }
}

/** Periodic Hann window (main lobe ±2 bins, first sidelobe −31 dB). Cached; do not mutate. */
export function hannWindow(size: number): Float64Array {
  let w = hannWindows.get(size)
  if (!w) {
    w = new Float64Array(size)
    for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
    hannWindows.set(size, w)
  }
  return w
}

/**
 * Periodic 4-term Blackman–Harris window (main lobe ±4 bins, sidelobes below −92 dB), for
 * measuring the noise between harmonics without their leakage. Cached; do not mutate.
 */
export function blackmanHarrisWindow(size: number): Float64Array {
  let w = blackmanHarrisWindows.get(size)
  if (!w) {
    w = new Float64Array(size)
    for (let i = 0; i < size; i++) {
      const x = (2 * Math.PI * i) / size
      w[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x)
    }
    blackmanHarrisWindows.set(size, w)
  }
  return w
}
