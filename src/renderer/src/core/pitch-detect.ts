/**
 * YIN fundamental-frequency estimator (de Cheveigné & Kawahara, 2002), used by the song tester's
 * acoustic check: render a note offline, detect its pitch, compare against the expected frequency.
 */

export interface PitchEstimate {
  freq: number
  /** 0–1, where 1 is a perfectly periodic signal. */
  confidence: number
}

export function detectPitch(
  samples: Float32Array,
  sampleRate: number,
  { minFreq = 60, maxFreq = 2000, threshold = 0.12 }: { minFreq?: number; maxFreq?: number; threshold?: number } = {}
): PitchEstimate | null {
  const maxLag = Math.min(Math.floor(sampleRate / minFreq), Math.floor(samples.length / 2))
  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq))
  if (maxLag <= minLag + 2) return null
  const window = samples.length - maxLag

  // Difference function d(τ) and its cumulative-mean-normalised form d'(τ).
  const diff = new Float32Array(maxLag + 1)
  for (let tau = 1; tau <= maxLag; tau++) {
    let sum = 0
    for (let i = 0; i < window; i++) {
      const delta = samples[i]! - samples[i + tau]!
      sum += delta * delta
    }
    diff[tau] = sum
  }
  const cmnd = new Float32Array(maxLag + 1)
  cmnd[0] = 1
  let running = 0
  for (let tau = 1; tau <= maxLag; tau++) {
    running += diff[tau]!
    cmnd[tau] = running === 0 ? 1 : (diff[tau]! * tau) / running
  }

  // First dip below the threshold, walked down to its local minimum; else the global minimum.
  let tauEstimate = -1
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau]! < threshold) {
      while (tau + 1 <= maxLag && cmnd[tau + 1]! < cmnd[tau]!) tau++
      tauEstimate = tau
      break
    }
  }
  if (tauEstimate === -1) {
    let best = minLag
    for (let tau = minLag; tau <= maxLag; tau++) if (cmnd[tau]! < cmnd[best]!) best = tau
    if (cmnd[best]! > 0.5) return null
    tauEstimate = best
  }

  const dipNear = (centre: number) => {
    let best = Math.round(centre)
    for (let tau = Math.max(minLag, Math.round(centre) - 2); tau <= Math.min(maxLag, Math.round(centre) + 2); tau++) if (cmnd[tau]! < cmnd[best]!) best = tau
    return best
  }

  // Noisy notes (bow noise, flautando): the cumulative-mean normalisation favours longer lags, so
  // the first dip under the threshold can be a multiple of the true period. A longer period is
  // real only if the spectrum has energy between the shorter period's harmonics.
  // (The fallback minimum can be several periods long, so keep dividing while the spectrum allows.)
  for (let reduced = true; reduced; ) {
    reduced = false
    for (const k of [8, 7, 6, 5, 4, 3, 2]) {
      const centre = tauEstimate / k
      if (centre < minLag) continue
      const best = dipNear(centre)
      if (cmnd[best]! < 0.5 && subharmonicDb(samples, sampleRate, sampleRate / best, k) < SUBHARMONIC_FLOOR_DB) {
        tauEstimate = best
        reduced = true
        break
      }
    }
  }

  // Weak fundamental ("missing fundamental", e.g. a low note through a body that radiates little
  // bass): the signal nearly repeats every half period, so the first dip is an octave too high.
  // A true period repeats markedly better at its multiples than a spurious one does, and its
  // spectrum has energy between the shorter period's harmonics; a clean period (or a real octave
  // jump) already has a near-zero dip and is left alone.
  for (const k of cmnd[tauEstimate]! > 0.02 ? [2, 3] : []) {
    const centre = tauEstimate * k
    if (centre + 1 > maxLag) break
    const best = dipNear(centre)
    if (cmnd[best]! < cmnd[tauEstimate]! * 0.35 && subharmonicDb(samples, sampleRate, sampleRate / tauEstimate, k) >= SUBHARMONIC_FLOOR_DB) {
      tauEstimate = best
      break
    }
  }

  const parabolic = (curve: Float32Array, tau: number) => {
    if (tau <= 1 || tau >= maxLag) return tau
    const a = curve[tau - 1]!
    const b = curve[tau]!
    const c = curve[tau + 1]!
    const denom = a - 2 * b + c
    return denom === 0 ? tau : tau + (a - c) / (2 * denom)
  }
  let refined = parabolic(cmnd, tauEstimate)

  // Short periods (high notes) span few samples, so interpolation error is large relative to the
  // period. Re-locate the dip at the largest multiple of the period that fits and divide back.
  const multiple = Math.min(8, Math.floor((maxLag - 2) / refined))
  if (multiple >= 2) {
    const centre = Math.round(refined * multiple)
    let best = centre
    for (let tau = Math.max(minLag, centre - 2); tau <= Math.min(maxLag - 1, centre + 2); tau++) {
      if (diff[tau]! < diff[best]!) best = tau
    }
    refined = parabolic(diff, best) / multiple
  }
  return { freq: sampleRate / refined, confidence: 1 - Math.min(1, cmnd[tauEstimate]!) }
}

/**
 * Below this, the partials between a frequency's harmonics (at f/k, 2f/k, …) are too weak for the
 * k-times-longer period to be the real one: the ear hears f, and so does this detector.
 */
const SUBHARMONIC_FLOOR_DB = -25

/**
 * Mean level of the partials a k-times-lower fundamental would add between the harmonics of
 * `freq` (at j·freq/k, j not a multiple of k), relative to the mean level of those harmonics, in
 * dB — Goertzel over the Hann-windowed samples, up to four harmonics of `freq` and below 5 kHz.
 * Means, not sums, so that noise does not grow with the number of in-between slots.
 */
function subharmonicDb(samples: Float32Array, sampleRate: number, freq: number, k: number): number {
  const n = samples.length
  const level = (f: number) => {
    const w = (2 * Math.PI * f) / sampleRate
    const coeff = 2 * Math.cos(w)
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < n; i++) {
      const s0 = samples[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))) + coeff * s1 - s2
      s2 = s1
      s1 = s0
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2
  }
  let between = 0
  let on = 0
  let nBetween = 0
  let nOn = 0
  const top = Math.min(4 * k, Math.floor((Math.min(5000, sampleRate / 2) * k) / freq))
  for (let j = 1; j <= top; j++) {
    const p = level((j * freq) / k)
    if (j % k === 0) {
      on += p
      nOn++
    } else {
      between += p
      nBetween++
    }
  }
  return on > 0 && nBetween > 0 ? 10 * Math.log10(between / nBetween / (on / nOn) + 1e-12) : 0
}

export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / Math.max(1, samples.length))
}
