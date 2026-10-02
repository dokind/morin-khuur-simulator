/// <reference types="vite/client" />
// (the reference types `?raw` for the tests' Node config, which reaches this module)
import bowedStringSource from './bowed-string.worklet.js?raw'
import { TECHNIQUES } from '@renderer/core/techniques'
import { midiToFreq } from '@renderer/core/pitch'
import type { Song, VerificationReport } from '@renderer/core/notation'
import type { StringId } from '@renderer/core/instrument'
import type { StyleId } from '@renderer/core/performance'
import { eventsDuration, songEvents, type TimedEvent } from '../song-events'
import { VARIANT, soundboxImpulse, type Soundboard } from '../soundbox-ir'

// Renders a song in Node through the same bowed-string AudioWorklet the app plays, with the worklet
// globals stubbed exactly as bowed-string.test.ts does, then through the SOUNDBOX the app puts
// after it (body.ts: the 90 Hz high-pass, the modal impulse response with a trace of the dry
// bridge signal, the air low-pass), rebuilt here in plain arithmetic. Still no room and no limiter,
// no plucks or percussion, and the bow is driven per note rather than by BowedVoice's full
// automation (no vibrato or ornament curves). `body: 'none'` is the dry string alone. It exists so a song can leave the simulator as a file without a browser
// (scripts/render-song.mjs), and so its pitch can be tested in CI.

const BLOCK = 128
type Params = Record<string, Float32Array>
interface Processor {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Params): boolean
}

/** The worklet's processor class, compiled for one sample rate. */
export function loadBowedString(sampleRate: number): new () => Processor {
  const source = bowedStringSource
  let registered: (new () => Processor) | null = null
  const register = (_name: string, cls: new () => Processor) => {
    registered = cls
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(class {}, register, sampleRate)
  if (!registered) throw new Error('bowed-string.worklet.js registered no processor')
  return registered
}

export interface NodeRenderOptions {
  sampleRate?: number
  /** Playing style (default 'as-written': the notes and nothing else). */
  style?: StyleId
  /** Peak level of the output, linear (default 0.89, about −1 dBFS). */
  peak?: number
  /** Seconds of bow rise and release at a bow change (defaults 0.03 / 0.06). */
  rise?: number
  release?: number
  /** Soundbox after the strings (default 'wood'); 'none' leaves the dry string. */
  body?: Soundboard | 'none'
}

export interface NodeRender {
  sampleRate: number
  samples: Float32Array
  /** The pitched, bowed events that were rendered. */
  events: TimedEvent[]
  /** Events skipped because the dry string cannot play them (plucks, percussion, gestures). */
  skipped: TimedEvent[]
  /** Gain applied to reach `peak`. */
  gain: number
}

/** Bow speed and force for a note velocity: BowedVoice.stroke's mapping (bowTimbre, pressure 0.4 + 0.4 v). */
export function bowFor(velocity: number, freq: number, openFreq: number, harmonic: boolean): { speed: number; force: number } {
  const speed = 0.4 + 0.6 * velocity
  const p = 0.4 + 0.4 * velocity
  const base = harmonic ? 0.4 + 0.15 * p + 0.3 * speed : 0.3 + 0.3 * p + 0.4 * speed
  return { speed, force: Math.min(0.97, Math.min(0.95, base) + 0.08 * Math.log2(Math.max(1, freq / openFreq))) }
}

interface Lane {
  freq: Float32Array
  speed: Float32Array
  force: Float32Array
}

export function renderSongNode(song: Song, report: VerificationReport, opts: NodeRenderOptions = {}): NodeRender {
  const sampleRate = opts.sampleRate ?? 48000
  const rise = opts.rise ?? 0.03
  const release = opts.release ?? 0.06
  const all = songEvents(song, report, song.tempoBpm, { style: opts.style ?? 'as-written' })
  const playable = (e: TimedEvent) => {
    const kind = TECHNIQUES[e.event.technique]?.kind
    return e.event.freq !== null && e.event.string !== null && (kind === 'stopped' || kind === 'harmonic')
  }
  const events = all.filter(playable)
  const skipped = all.filter((e) => !playable(e))
  const length = Math.ceil((eventsDuration(all) + release + 0.5) * sampleRate)
  const open: Record<StringId, number> = { male: midiToFreq(song.tuning.male), female: midiToFreq(song.tuning.female) }
  const lane = (): Lane => ({ freq: new Float32Array(length).fill(open.male), speed: new Float32Array(length), force: new Float32Array(length).fill(0.5) })
  const lanes: Record<StringId, Lane> = { male: lane(), female: lane() }

  const stroke = (s: StringId, start: number, dur: number, freq: number, velocity: number, harmonic: boolean, slur: boolean) => {
    const { speed, force } = bowFor(velocity, freq, open[s], harmonic)
    const a = Math.max(0, Math.round(start * sampleRate))
    const b = Math.min(length, Math.round((start + dur) * sampleRate))
    const l = lanes[s]
    const riseN = slur ? 0 : Math.max(1, Math.round(rise * sampleRate))
    const relN = Math.max(1, Math.round(release * sampleRate))
    for (let i = a; i < b; i++) {
      l.freq[i] = freq
      // Force is pressed at once on landing (easing it in locks the male string onto its octave).
      l.force[i] = force
      const fromStart = i - a
      const toEnd = b - i
      l.speed[i] = speed * Math.min(1, riseN ? fromStart / riseN : 1, toEnd / relN)
    }
    // Keep the last pitch while the string rings out after the bow leaves it.
    for (let i = b; i < length && lanes[s].speed[i] === 0; i++) l.freq[i] = freq
  }

  for (const e of events) {
    const n = e.event
    const harmonic = TECHNIQUES[n.technique]?.kind === 'harmonic'
    stroke(n.string!, e.start, n.duration, n.freq!, n.velocity, harmonic, !!n.slur)
    if (n.droneFreq) {
      const other: StringId = n.string === 'male' ? 'female' : 'male'
      stroke(other, e.start, n.duration, n.droneFreq, n.velocity * 0.8, false, false)
    }
  }

  const Processor = loadBowedString(sampleRate)
  const mix = new Float32Array(length)
  for (const s of ['male', 'female'] as const) {
    const l = lanes[s]
    if (!l.speed.some((v) => v > 0)) continue
    const p = new Processor()
    const block = new Float32Array(BLOCK)
    const params: Params = {
      detune: new Float32Array([0]),
      beta: new Float32Array([0.13]),
      roughness: new Float32Array([s === 'male' ? 0.35 : 0.3]),
      damping: new Float32Array([0.94])
    }
    for (let i = 0; i + BLOCK <= length; i += BLOCK) {
      params.frequency = l.freq.subarray(i, i + BLOCK)
      params.velocity = l.speed.subarray(i, i + BLOCK)
      params.force = l.force.subarray(i, i + BLOCK)
      block.fill(0)
      p.process([], [[block]], params)
      for (let k = 0; k < BLOCK; k++) mix[i + k]! += block[k]!
    }
  }
  const body = opts.body ?? 'wood'
  const out = body === 'none' ? mix : soundbox(mix, sampleRate, body)
  let max = 0
  for (const v of out) max = Math.max(max, Math.abs(v))
  const gain = max > 0 ? (opts.peak ?? 0.89) / max : 1
  for (let i = 0; i < length; i++) out[i]! *= gain
  return { sampleRate, samples: out, events, skipped, gain }
}

/**
 * body.ts's Soundbox in arithmetic: high-pass 90 Hz, then the impulse response plus `dry` of the
 * high-passed signal, then the air low-pass. The level gain is left out (the render is
 * peak-normalised after). Same length as the input: the render already carries a release tail.
 */
export function soundbox(input: Float32Array, sampleRate: number, soundboard: Soundboard = 'wood'): Float32Array {
  const v = VARIANT[soundboard]
  const hp = biquad(input, sampleRate, 'highpass', 90, 0.6)
  const wet = convolve(hp, soundboxImpulse(sampleRate, soundboard))
  for (let i = 0; i < wet.length; i++) wet[i]! += v.dry * hp[i]!
  return biquad(wet, sampleRate, 'lowpass', Math.min(v.airHz, 0.45 * sampleRate), 0.5)
}

/**
 * A Web Audio BiquadFilterNode, low- or high-pass: the Audio EQ Cookbook coefficients with Q read
 * in dB, as the Web Audio spec reads it for these two types (Tone.Filter hands Q straight through).
 */
export function biquad(x: Float32Array, sampleRate: number, type: 'lowpass' | 'highpass', freq: number, qDb: number): Float32Array {
  const w0 = (2 * Math.PI * freq) / sampleRate
  const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20))
  const cos = Math.cos(w0)
  const a0 = 1 + alpha
  const b0 = (type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2) / a0
  const b1 = (type === 'lowpass' ? 1 - cos : -(1 + cos)) / a0
  const b2 = b0
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  const y = new Float32Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = xi
    y2 = y1
    y1 = yi
    y[i] = yi
  }
  return y
}

/** Linear convolution by FFT overlap-add, truncated to the input's length. */
export function convolve(x: Float32Array, h: Float32Array): Float32Array {
  let n = 1
  while (n < 2 * h.length) n <<= 1
  const step = n - h.length + 1
  const hr = new Float64Array(n)
  const hi = new Float64Array(n)
  hr.set(h)
  fft(hr, hi, false)
  const y = new Float32Array(x.length)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let at = 0; at < x.length; at += step) {
    re.fill(0)
    im.fill(0)
    const count = Math.min(step, x.length - at)
    for (let k = 0; k < count; k++) re[k] = x[at + k]!
    fft(re, im, false)
    for (let k = 0; k < n; k++) {
      const r = re[k]! * hr[k]! - im[k]! * hi[k]!
      im[k] = re[k]! * hi[k]! + im[k]! * hr[k]!
      re[k] = r
    }
    fft(re, im, true)
    const end = Math.min(n, x.length - at)
    for (let k = 0; k < end; k++) y[at + k]! += re[k]!
  }
  return y
}

/** In-place radix-2 complex FFT (length a power of two); the inverse is scaled by 1/n. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!
      re[i] = re[j]!
      re[j] = tr
      const ti = im[i]!
      im[i] = im[j]!
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const br = re[b]! * cr - im[b]! * ci
        const bi = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - br
        im[b] = im[a]! - bi
        re[a] = re[a]! + br
        im[a] = im[a]! + bi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n
      im[i] = im[i]! / n
    }
  }
}
