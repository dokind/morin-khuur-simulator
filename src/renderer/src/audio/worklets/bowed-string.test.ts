import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectPitch } from '@renderer/core/pitch-detect'
import { centsBetween } from '@renderer/core/pitch'

// Runs the bowed-string AudioWorklet processor in Node: the worklet globals are stubbed and the
// processor is driven block by block, so pitch accuracy is regression-tested without a browser.
const SR = 44100
const BLOCK = 128
type Params = Record<string, Float32Array>
interface Processor {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Params): boolean
}

function loadProcessor(): new () => Processor {
  const source = readFileSync(join(__dirname, 'bowed-string.worklet.js'), 'utf8')
  let registered: (new () => Processor) | null = null
  const register = (_name: string, cls: new () => Processor) => {
    registered = cls
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(class {}, register, SR)
  return registered!
}

const Processor = loadProcessor()

function render(
  freq: number,
  {
    seconds = 0.8,
    velocity = 0.75,
    force = 0.6,
    beta = 0.127,
    roughness = 0.3,
    damping = 0.94,
    rise = 0.03,
    envelope,
    forceAt,
    betaAt,
    detune,
    frequency,
    start = 0,
    seed
  }: {
    seconds?: number
    velocity?: number
    force?: number
    beta?: number
    roughness?: number
    damping?: number
    /** Seconds for the bow to come up to speed (linear). */
    rise?: number
    /** Bow speed as a fraction of `velocity` over time (overrides `rise`). */
    envelope?: (t: number) => number
    /** Bow force over time (overrides `force`; a-rate, as in the worklet). */
    forceAt?: (t: number) => number
    /** Contact point over time (overrides `beta`; a-rate). */
    betaAt?: (t: number) => number
    detune?: (t: number) => number
    /** Per-sample frequency, Hz (overrides `freq`), for ornaments that step the pitch. */
    frequency?: (t: number) => number
    /**
     * Seconds of silence before the bow lands; the functions above take the time since then. A
     * song's notes start anywhere within a render quantum.
     */
    start?: number
    /** State of the hair-noise generator: a song's notes find it anywhere. */
    seed?: number
  } = {}
): Float32Array {
  const p = new Processor()
  if (seed !== undefined) (p as unknown as { seed: number }).seed = seed >>> 0 || 1
  const out = new Float32Array(Math.floor(seconds * SR))
  const params: Params = {
    frequency: new Float32Array([freq]),
    detune: new Float32Array([0]),
    velocity: new Float32Array([velocity]),
    force: new Float32Array([force]),
    beta: new Float32Array([beta]),
    roughness: new Float32Array([roughness]),
    damping: new Float32Array([damping])
  }
  // The bow comes in over ~30 ms, as BowedVoice's envelope does (an instant start is unphysical).
  const ramp = Math.floor(rise * SR)
  const lead = Math.round(start * SR)
  const time = (n: number) => (n - lead) / SR
  for (let i = 0; i + BLOCK <= out.length; i += BLOCK) {
    if (envelope) params.velocity = Float32Array.from({ length: BLOCK }, (_, k) => (i + k < lead ? 0 : velocity * envelope(time(i + k))))
    else params.velocity = i - lead < ramp ? Float32Array.from({ length: BLOCK }, (_, k) => (velocity * Math.max(0, Math.min(ramp, i + k - lead))) / ramp) : new Float32Array([velocity])
    if (forceAt) params.force = Float32Array.from({ length: BLOCK }, (_, k) => forceAt(time(i + k)))
    if (betaAt) params.beta = Float32Array.from({ length: BLOCK }, (_, k) => betaAt(time(i + k)))
    if (detune) params.detune = Float32Array.from({ length: BLOCK }, (_, k) => detune(time(i + k)))
    if (frequency) params.frequency = Float32Array.from({ length: BLOCK }, (_, k) => frequency(time(i + k)))
    const block = new Float32Array(BLOCK)
    p.process([], [[block]], params)
    out.set(block, i)
  }
  return out
}

const pitchCents = (freq: number, samples: Float32Array, from = 0.4, to = 0.75) => {
  const est = detectPitch(samples.subarray(Math.floor(from * SR), Math.floor(to * SR)), SR, { maxFreq: 2500 })
  return est ? centsBetween(freq, est.freq) : NaN
}

/** Magnitude of the component at `f` (Hann-windowed DFT bin). */
const level = (x: Float32Array, f: number) => {
  const w = (2 * Math.PI * f) / SR
  let re = 0
  let im = 0
  for (let i = 0; i < x.length; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (x.length - 1))
    re += x[i]! * win * Math.cos(w * i)
    im -= x[i]! * win * Math.sin(w * i)
  }
  return Math.hypot(re, im)
}

/** Second harmonic relative to the fundamental, dB: above 0 the string has flipped to its octave (double slip). */
const h2OverH1 = (x: Float32Array, f: number) => 20 * Math.log10(level(x, 2 * f) / level(x, f))

/** Bow speed and force for a note velocity, as BowedVoice.stroke maps them (bowTimbre, pressure 0.4 + 0.4 v). */
const strokeBow = (v: number, freq: number, open: number) => {
  const speed = 0.4 + 0.6 * v
  return { velocity: speed, force: Math.min(0.97, Math.min(0.95, 0.3 + 0.3 * (0.4 + 0.4 * v) + 0.4 * speed) + 0.08 * Math.log2(Math.max(1, freq / open))) }
}

const seg = (x: Float32Array, from: number, to: number) => x.subarray(Math.floor(from * SR), Math.floor(to * SR))

/** Normalised autocorrelation at half the period: about −0.5 in Helmholtz motion, near 1 in double slip. */
const halfPeriodCorrelation = (x: Float32Array, f: number) => {
  const lag = Math.round(SR / f / 2)
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i + lag < x.length; i++) {
    ab += x[i]! * x[i + lag]!
    aa += x[i]! ** 2
    bb += x[i + lag]! ** 2
  }
  return ab / Math.sqrt(aa * bb)
}

/** An octave flip of a stroke that landed at `start`: the octave dominating as it settles, or double slip after. */
const flipped = (x: Float32Array, f: number, start: number) =>
  h2OverH1(seg(x, start + 0.1, start + 0.2), f) > 6 || halfPeriodCorrelation(seg(x, start + 0.2, start + 0.42), f) > 0.4

/** Landing times spread over a render quantum, after 17 quanta of silence. */
const offsets = (n: number) => Array.from({ length: n }, (_, k) => (17 * BLOCK + Math.round((k * BLOCK) / n)) / SR)

/** Hair-noise states to land in (the generator's seed; any nonzero value). */
const SEEDS = [0x2545f491, 0x9e3779b9, 0x1234567, 0xdeadbeef, 0x7f4a7c15, 0x51ed270b]

/**
 * Seconds of 40 ms windows (10 ms apart) from `from` to `to` in which harmonic `n` rises more than
 * 3 dB above the fundamental: the octave regime (n = 2) or the twelfth (n = 3). The census of every
 * song in every style uses the same measure.
 */
const regimeSeconds = (x: Float32Array, f: number, from: number, to: number, n = 2) => {
  let s = 0
  for (let t = from; t + 0.04 <= to + 1e-9; t += 0.01) {
    const w = seg(x, t, t + 0.04)
    if (20 * Math.log10(level(w, n * f) / level(w, f)) > 3) s += 0.01
  }
  return s
}

/** A setTargetAtTime approach from `from` to `to` (time constant `tc`), `t` seconds after it starts. */
const approach = (from: number, to: number, t: number, tc: number) => to + (from - to) * Math.exp(-Math.max(0, t) / tc)

/**
 * Web Audio automation as BowedVoice schedules it: [time, value, time constant] steps, where a
 * time constant of 0 is setValueAtTime and anything else setTargetAtTime.
 */
const automation = (initial: number, steps: readonly (readonly [number, number, number])[]) => (t: number) => {
  let value = initial
  let target = initial
  let since = 0
  let tc = 0
  for (const [time, to, c] of steps) {
    if (time > t) break
    value = tc > 0 ? approach(value, target, time - since, tc) : target
    since = time
    target = to
    tc = c
    if (c === 0) value = to
  }
  return tc > 0 ? approach(value, target, t - since, tc) : target
}

/** Bow speed of a fresh stroke of length `d` as BowedVoice draws it (fraction of the peak). */
const strokeEnvelope = (profile: 'swell' | 'accent-release', pull: boolean, d: number) => {
  const tc = pull ? 0.025 : 0.018
  const [relaxTo, relaxAt, relaxTc] = profile === 'accent-release' ? [0.7, 3 * tc, 0.3 * d] : [0.85, 4 * tc, Math.max(0.05, 0.6 * d)]
  return (t: number) => (t < relaxAt ? approach(0, 1, t, tc) : approach(approach(0, 1, relaxAt, tc), relaxTo, t - relaxAt, relaxTc))
}

/**
 * Bow force pressed at the landing with a push on top, held while the bow catches the string
 * (BowedVoice PUSH_HOLD) and then eased back (to `after`). Before the landing it is BowedVoice's
 * initial 0.85.
 */
const heldPush = (base: number, amount: number, hold: number, tc: number, after = base) => (t: number) =>
  t < 0 ? 0.85 : t < hold ? Math.min(0.97, base + amount) : approach(Math.min(0.97, base + amount), after, t - hold, tc)

describe('bowed-string worklet', () => {
  // Force as BowedVoice maps it (pressure 0.55) for the given bow speed and stopping height.
  const force = (velocity: number, freq: number, open = 233.08) => Math.min(0.97, 0.3 + 0.3 * 0.55 + 0.4 * velocity + 0.08 * Math.log2(Math.max(1, freq / open)))

  it.each([174.61, 233.08, 293.66, 392, 466.16, 587.33, 698.46, 932.33])('bows %f Hz in tune (< 5 cents)', (freq) => {
    const cents = pitchCents(freq, render(freq, { force: force(0.75, freq) }))
    expect(Math.abs(cents)).toBeLessThan(5)
  })

  it.each([174.61, 196, 220, 261.63, 293.66])('bows the rough, lossy male string at %f Hz in tune', (freq) => {
    const cents = pitchCents(freq, render(freq, { roughness: 0.42, damping: 0.93, force: force(0.75, freq, 174.61) }))
    expect(Math.abs(cents)).toBeLessThan(5)
  })

  it.each([0.4, 0.75, 1])('stays in tune across bow speeds (velocity %f)', (velocity) => {
    expect(Math.abs(pitchCents(466.16, render(466.16, { velocity, force: force(velocity, 466.16) })))).toBeLessThan(5)
  })

  it('stays in tune bowed sul tasto (far from the bridge)', () => {
    for (const beta of [0.19]) expect(Math.abs(pitchCents(349.23, render(349.23, { beta, force: force(0.75, 349.23) })))).toBeLessThan(5)
  })

  // The lock times the whole waveform. Locking the band-passed fundamental instead made low notes
  // start up to 15 cents sharp, because it runs flat of the waveform while the motion builds up.
  it.each([
    [174.61, 0.42, 0.93, 174.61],
    [233.08, 0.32, 0.945, 233.08],
    [698.46, 0.32, 0.945, 233.08]
  ])('is in tune from the start of the stroke at %f Hz', (freq, roughness, damping, open) => {
    const stroke = render(freq, { force: force(0.88, freq, open), velocity: 0.88, beta: 0.13, roughness, damping })
    expect(Math.abs(pitchCents(freq, stroke, 0.08, 0.2))).toBeLessThan(2)
    expect(Math.abs(pitchCents(freq, stroke, 0.2, 0.35))).toBeLessThan(2)
  })

  it.each([174.61, 466.16, 932.33])('lands in tune after sliding into %f Hz', (freq) => {
    // Two semitones up over 0.2 s, then held.
    const slide = (t: number) => (t < 0.25 ? -200 : t < 0.45 ? -200 + (200 * (t - 0.25)) / 0.2 : 0)
    const stroke = render(freq, { seconds: 0.95, force: force(0.88, freq), velocity: 0.88, beta: 0.13, detune: slide })
    expect(Math.abs(pitchCents(freq, stroke, 0.6, 0.9))).toBeLessThan(2)
  })

  // Double slip keeps the period (odd harmonics survive) so the pitch tests pass, but the string
  // sounds an octave up. Force is fully applied as the bow lands, as BowedVoice does.
  it.each([
    [174.61, 0.42, 0.93],
    [233.08, 0.32, 0.945],
    [261.63, 0.42, 0.93]
  ])('speaks the fundamental of %f Hz, not the octave, at every stroke speed', (freq, roughness, damping) => {
    for (const v of [0.5, 0.8, 1]) {
      const speed = 0.4 + 0.6 * v
      const stroke = render(freq, { velocity: speed, force: Math.min(0.95, 0.3 + 0.3 * (0.4 + 0.4 * v) + 0.4 * speed), beta: 0.13, roughness, damping })
      expect(h2OverH1(seg(stroke, 0.4, 0.75), freq)).toBeLessThan(0)
    }
  })

  // Performance ornaments move the pitch while the bow keeps going. The lock holds its trim while
  // the pitch moves and re-times the waveform on each held note, so a trill must land on both of its
  // notes each time, without the string falling into double slip.
  it.each([
    ['female', 311.13, 233.08, 0.32, 0.945],
    ['male', 196, 174.61, 0.42, 0.93]
  ] as const)('trills a major third at 6.5 Hz on the %s string, in tune on both notes', (_string, main, open, roughness, damping) => {
    const upper = main * 2 ** (4 / 12)
    const rate = 6.5
    const half = 1 / (2 * rate)
    const step = 0.013
    const start = 0.3
    const halves = 14
    const end = start + halves * half
    // Main note first, then alternating halves (upper first); each change is a 13 ms glide (the
    // finger's travel). An even number of halves ends back on the main note, which is then held.
    const pitchAt = (t: number) => {
      if (t < start || t >= end) return main
      const phase = ((t - start) / half) % 2
      const into = (phase % 1) * half
      const [from, to] = phase < 1 ? [main, upper] : [upper, main]
      return into < step ? from * (to / from) ** (into / step) : to
    }
    const bow = strokeBow(0.8, main, open)
    const x = render(main, { seconds: end + 0.45, ...bow, beta: 0.13, roughness, damping, frequency: pitchAt })
    for (let k = 0; k < halves; k++) {
      const target = k % 2 === 0 ? upper : main
      const w = seg(x, start + k * half + step + 0.012, start + (k + 1) * half - 0.002)
      const est = detectPitch(w, SR, { minFreq: 60, maxFreq: 2500 })
      expect(est, `half ${k}`).not.toBeNull()
      expect(Math.abs(centsBetween(target, est!.freq)), `half ${k} (${target.toFixed(1)} Hz)`).toBeLessThan(10)
      expect(h2OverH1(w, target), `half ${k}`).toBeLessThan(0)
    }
    // The note held after the trill is in tune: the lock was not dragged off by the steps.
    expect(Math.abs(pitchCents(main, x, end + 0.15, end + 0.45))).toBeLessThan(5)
  })

  // Abrupt (огцом) strokes land the bow fast with the force pressed at once. A 10 ms rise at full
  // stroke speed keeps the heavy male string in Helmholtz motion from the start.
  it('keeps an abrupt stroke with a 10 ms rise on the male F3 in Helmholtz motion (velocity 0.95)', () => {
    const x = render(174.61, { seconds: 0.5, ...strokeBow(0.95, 174.61, 174.61), rise: 0.01, beta: 0.13, roughness: 0.42, damping: 0.93 })
    expect(h2OverH1(seg(x, 0.05, 0.2), 174.61)).toBeLessThan(0)
    expect(h2OverH1(seg(x, 0.2, 0.45), 174.61)).toBeLessThan(0)
    expect(Math.abs(pitchCents(174.61, x, 0.15, 0.45))).toBeLessThan(5)
  })

  // The same linear 10 ms rise flips the male string to its octave at medium velocities (+10–25 dB
  // of H2 for the first 0.1–0.2 s), and so do raised-cosine rises; an exponential rise with a 12 ms
  // time constant (63% in 12 ms, as BowedVoice's detached and abrupt strokes use) never does, from
  // any start within a render quantum. Every bow landing on the male string starts with H2 up to
  // ~2 dB over H1 for 0.2–0.3 s before settling at −6 dB; an octave flip is 8 dB or more.
  it.each([0, 2, 5, 9])('lands the abrupt stroke on the male string (stop %i) without an octave flip at any velocity or start', (stop) => {
    const freq = 174.61 * 2 ** (stop / 12)
    for (const v of [0.5, 0.7, 0.85, 1]) {
      const bow = strokeBow(v, freq, 174.61)
      for (const start of offsets(8)) {
        const at = `v ${v}, start ${Math.round(start * SR)}`
        const x = render(freq, { seconds: start + 0.6, ...bow, forceAt: (t) => (t < 0 ? 0.85 : bow.force), envelope: (t) => 1 - Math.exp(-t / 0.012), beta: 0.13, roughness: 0.42, damping: 0.93, start })
        expect(h2OverH1(seg(x, start + 0.04, start + 0.12), freq), at).toBeLessThan(8)
        expect(h2OverH1(seg(x, start + 0.1, start + 0.3), freq), at).toBeLessThan(3)
        expect(h2OverH1(seg(x, start + 0.35, start + 0.6), freq), at).toBeLessThan(0)
      }
    }
  })

  // Landings. A bow set on a quiet string takes it straight into Helmholtz motion (the worklet's
  // takeover, once the bow is up to speed): no octave as the attack builds and none later, in any
  // hair-noise state, at every rise BowedVoice uses (abrupt and gallop 12 ms, push 18 ms, pull
  // 25 ms). Left to the friction model, the default contact point spent 50–100 ms of every attack in
  // double slip, and a few percent of the notes never left it.
  it.each([
    ['male', 174.61, 174.61, 0.42, 0.93],
    ['male', 220, 174.61, 0.42, 0.93],
    ['male', 261.63, 174.61, 0.42, 0.93],
    ['female', 233.08, 233.08, 0.32, 0.945],
    ['female', 349.23, 233.08, 0.32, 0.945],
    ['female', 466.16, 233.08, 0.32, 0.945]
  ] as const)('lands on the %s string at %f Hz in Helmholtz motion from the first periods, in any hair-noise state', (_string, freq, open, roughness, damping) => {
    for (const [tc, share] of [
      [0.012, 1],
      [0.018, 0.88],
      [0.025, 1]
    ] as const)
      for (const [k, seed] of SEEDS.slice(0, 4).entries()) {
        const v = [0.3, 0.55, 0.8, 1][k]!
        const bow = strokeBow(v, freq, open)
        const start = offsets(4)[k]!
        const x = render(freq, { seconds: start + 0.6, velocity: bow.velocity * share, forceAt: (t) => (t < 0 ? 0.85 : bow.force), envelope: (t) => 1 - Math.exp(-t / tc), beta: 0.13, roughness, damping, start, seed })
        expect(regimeSeconds(x, freq, start, start + 0.55), `rise ${tc * 1000} ms, v ${v}`).toBe(0)
      }
  })

  // The regime measure itself: drawn far too lightly for its speed (force 0 at full speed, speed ×
  // slope 2.75), the string settles into double slip and the octave dominates.
  it('detects the octave regime of a stroke drawn far too lightly', () => {
    const x = render(174.61, { seconds: 0.9, velocity: 1, force: 0, envelope: (t) => 1 - Math.exp(-t / 0.025), beta: 0.13, roughness: 0.42, damping: 0.93, start: 0.05 })
    expect(regimeSeconds(x, 174.61, 0.3, 0.85)).toBeGreaterThan(0.3)
  })

  // Bow changes. BowedVoice slows the bow towards half its speed (8 ms) as the hair turns, and the
  // new note's finger arrives over 3 ms; the string keeps its Helmholtz motion through both. The
  // first turn (to 25% within 4 ms) broke the stick phase, and a finger change that jumped the loop
  // length replayed part of the travelling wave: each flipped a few percent of bow changes.
  it.each([
    [196, 174.61, 174.61, 0.42, 0.93],
    [233.08, 174.61, 174.61, 0.42, 0.93],
    [174.61, 196, 174.61, 0.42, 0.93],
    [174.61, 174.61, 174.61, 0.42, 0.93],
    [220, 196, 174.61, 0.42, 0.93],
    [293.66, 233.08, 233.08, 0.32, 0.945],
    [349.23, 293.66, 233.08, 0.32, 0.945],
    [233.08, 311.13, 233.08, 0.32, 0.945]
  ])('keeps Helmholtz motion through a bow change from %f to %f Hz', (from, to, open, roughness, damping) => {
    for (const [k, seed] of SEEDS.entries()) {
      const pull = k % 2 === 0
      const v = [0.4, 0.6, 0.8, 1, 0.7, 0.5][k]!
      const a = strokeBow(v, from, open)
      const b = strokeBow(v, to, open)
      const [pa, pb] = [a.velocity * (pull ? 1 : 0.88), b.velocity * (pull ? 0.88 : 1)]
      const [tca, tcb] = pull ? [0.025, 0.018] : [0.018, 0.025]
      // The bow change falls anywhere within a render quantum.
      const t1 = 0.35 + (k * 17) / SR
      const first: [number, number, number][] = [
        [0, pa, tca],
        [4 * tca, 0.85 * pa, 0.3]
      ]
      const now = automation(0, first)(t1)
      const velocity = automation(0, [...first, [t1, 0.5 * Math.max(now, pb), 0.008], [t1 + 0.02, pb, tcb], [t1 + 0.02 + 4 * tcb, 0.85 * pb, 0.3]])
      const bite = to * 2 ** (-6 / 1200)
      const frequency = (t: number) => (t < t1 ? from : t < t1 + 0.003 ? from * (bite / from) ** ((t - t1) / 0.003) : to + (bite - to) * Math.exp(-(t - t1 - 0.003) / 0.015))
      const forceAt = (t: number) => (t < 0 ? 0.85 : t < t1 ? a.force : approach(a.force, b.force, t - t1, 0.02))
      const x = render(to, { seconds: 0.05 + t1 + 0.5, velocity: 1, envelope: velocity, frequency, forceAt, beta: 0.13, roughness, damping, start: 0.05, seed })
      const at = `v ${v} ${pull ? 'pull' : 'push'} first`
      expect(regimeSeconds(x, from, 0.05, 0.05 + t1 - 0.01), at).toBe(0)
      expect(regimeSeconds(x, to, 0.05 + t1, 0.05 + t1 + 0.45), at).toBe(0)
    }
  })

  // Re-landing a ringing string. Abrupt strokes lift the bow fast (15 ms) after 80% of their length,
  // and the next one lands while the string still rings. BowedVoice lands every stroke that finds
  // the bow below 30% of its speed from zero, and the takeover replaces the ringing wave with the new
  // note's Helmholtz motion. Caught by the quick rise instead, the moving string flipped to its
  // octave on up to half of these re-attacks; the 30 ms string stop first used held for one
  // hair-noise state only.
  it.each([0, 2, 4])('re-lands a ringing male string (stop %i) after an abrupt stroke without an octave', (stop) => {
    const tc = 0.012
    const main = 174.61 * 2 ** (stop / 12)
    for (const d of [0.25, 0.577])
      for (const semitones of [2, -3, 5, 0]) {
        const prev = main * 2 ** (semitones / 12)
        for (const [k, pull] of [true, false].entries()) {
          const first = strokeBow(0.8, prev, 174.61)
          const second = strokeBow(0.8, main, 174.61)
          const peak1 = first.velocity * (pull ? 0.88 : 1)
          const peak2 = second.velocity * (pull ? 1 : 0.88)
          const velocity = automation(0, [
            [0, peak1, tc],
            [4 * tc, 0.9 * peak1, Math.max(0.03, 0.4 * d)],
            [0.8 * d, 0, 0.015],
            [d, 0, 0],
            [d, peak2, tc],
            [d + 4 * tc, 0.9 * peak2, Math.max(0.03, 0.4 * d)]
          ])
          const forceAt = automation(0.85, [
            [0, first.force, 0],
            [d, second.force, 0]
          ])
          const frequency = automation(prev, [
            [0, prev * 2 ** (-6 / 1200), 0],
            [0, prev, 0.015],
            [d, main * 2 ** (-6 / 1200), 0],
            [d, main, 0.015]
          ])
          for (const [j, start] of offsets(3).entries()) {
            const x = render(main, { seconds: start + d + 0.5, velocity: 1, envelope: velocity, forceAt, frequency, beta: 0.13, roughness: 0.42, damping: 0.93, start, seed: SEEDS[(2 * k + j) % SEEDS.length] })
            const at = `d ${d}, from ${semitones > 0 ? '+' : ''}${semitones}, ${pull ? 'pull' : 'push'}, start ${Math.round(start * SR)}`
            expect(regimeSeconds(x, main, start + d, start + d + Math.min(0.4, 0.8 * d - 0.01)), at).toBe(0)
          }
        }
      }
  })

  // A bow slowing to a stop leaves the string, which rings down on its own: the hair presses no
  // harder than the bow's speed allows (FORCE_LIMIT). Gripping fully down to a crawl, it pinned the
  // string at the bow: the short bridge side squeaked 20–30 dB below the note, and the nut side,
  // which has no losses of its own, kept its energy until the crawl ended 0.2–0.35 s after the
  // release and came back as a pop 8 dB below the note.
  it.each([
    [174.61, 0.03, 0.42, 0.93],
    [174.61, 0.015, 0.42, 0.93],
    [233.08, 0.03, 0.32, 0.945],
    [466.16, 0.03, 0.32, 0.945]
  ])('dies away after a release at %f Hz (time constant %f s) without a squeak or a pop', (freq, tc, roughness, damping) => {
    const bow = strokeBow(0.75, freq, freq)
    const release = 0.5
    const held = approach(0, 1, release, 0.025)
    const envelope = (t: number) => (t < release ? approach(0, 1, t, 0.025) : approach(held, 0, t - release, tc))
    const x = render(freq, { seconds: 1.6, velocity: bow.velocity, force: bow.force, envelope, beta: 0.13, roughness, damping, start: 0.05 })
    // 20 ms levels without the offset the loop can carry (the soundbox's high-pass removes it).
    const rms = (from: number) => {
      const w = seg(x, from, from + 0.02)
      const mean = w.reduce((a, b) => a + b, 0) / w.length
      return Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / w.length)
    }
    const note = rms(0.05 + release - 0.04)
    const levels: number[] = []
    for (let t = 0.05 + release + 0.02; t + 0.02 <= 1.6; t += 0.02) levels.push(rms(t))
    for (let k = 1; k < levels.length; k++) expect(levels[k]!, `${(k + 1) * 20} ms after the release`).toBeLessThan(levels[k - 1]! * 1.12)
    expect(20 * Math.log10(Math.max(...levels.slice(7)) / note)).toBeLessThan(-30)
  })

  // Slow bows. Drawn slowly, the bow sustains the same Helmholtz motion as a faster one, scaled down
  // with its speed and in tune, at any hair pressure: it presses no harder than its speed allows
  // (FORCE_LIMIT), as a player lightens a slow bow. The grip that first faded below a tenth of full
  // speed (against the pinned crawl above) silenced every slower bow: 35–240 dB below this.
  const liveForce = (speed: number, pressure: number, freq: number, open: number) => Math.min(0.97, 0.3 + 0.3 * pressure + 0.4 * speed + 0.08 * Math.log2(Math.max(1, freq / open)))
  const rmsDb = (x: Float32Array) => 10 * Math.log10(x.reduce((a, b) => a + b * b, 0) / x.length)
  it.each([
    [174.61, 174.61, 0.42, 0.93],
    [220, 174.61, 0.42, 0.93],
    [233.08, 233.08, 0.32, 0.945],
    [349.23, 233.08, 0.32, 0.945]
  ])('sustains a slow bow at %f Hz in tune, on the fundamental, as loud as its speed', (freq, open, roughness, damping) => {
    const bowed = (speed: number, pressure: number) =>
      render(freq, { seconds: 1.2, velocity: speed, force: liveForce(speed, pressure, freq, open), envelope: (t) => 1 - Math.exp(-t / 0.02), beta: 0.13, roughness, damping, start: 0.05 })
    const reference = rmsDb(seg(bowed(0.2, 0.55), 0.5, 1.15))
    for (const speed of [0.02, 0.04, 0.08])
      for (const pressure of [0.2, 0.9]) {
        const x = bowed(speed, pressure)
        const at = `speed ${speed}, pressure ${pressure}`
        expect(Math.abs(rmsDb(seg(x, 0.5, 1.15)) - reference - 20 * Math.log10(speed / 0.2)), at).toBeLessThan(1)
        expect(Math.abs(pitchCents(freq, x, 0.5, 1.15)), at).toBeLessThan(2)
        expect(regimeSeconds(x, freq, 0.3, 1.15), at).toBe(0)
      }
  })

  // The moving bow slowing to 5–10% of full speed (a diminuendo on the bow pad) keeps the note
  // sounding at the slow bow's own level, and a crescendo from a crawl rises smoothly on the
  // fundamental. With the fading grip the diminuendo died away (−46 to −55 dB, no pitch). Pressed at
  // its full force while it speeds up, as also tried, the crawling bow pinned the string and the
  // crescendo broke into the octave (up to +15 dB).
  it.each([
    [174.61, 174.61, 0.42, 0.93],
    [293.66, 233.08, 0.32, 0.945]
  ])('keeps a slowing and a slowly quickening bow at %f Hz sounding, on the fundamental', (freq, open, roughness, damping) => {
    const draw = (steps: [number, number][], seconds: number) =>
      render(freq, {
        seconds,
        velocity: 1,
        envelope: automation(0, steps.map(([t, v]) => [t, v, 0.02] as const)),
        forceAt: automation(0.85, [[0, liveForce(steps[0]![1], 0.55, freq, open), 0] as const, ...steps.slice(1).map(([t, v]) => [t, liveForce(v, 0.55, freq, open), 0.02] as const)]),
        beta: 0.13,
        roughness,
        damping,
        start: 0.05
      })
    for (const slow of [0.05, 0.1]) {
      const x = draw([[0, 0.4], [0.75, slow]], 2)
      const steady = draw([[0, slow]], 2)
      expect(Math.abs(rmsDb(seg(x, 1.4, 1.9)) - rmsDb(seg(steady, 1.4, 1.9))), `to ${slow}`).toBeLessThan(1)
      expect(Math.abs(pitchCents(freq, x, 1.4, 1.9)), `to ${slow}`).toBeLessThan(2)
      expect(regimeSeconds(x, freq, 0.9, 1.9), `to ${slow}`).toBe(0)
    }
    // From 2% of full speed to 12% over 1.2 s, in 20 steps (the bow pad re-sends its speed).
    const steps: [number, number][] = [[0, 0.02], ...Array.from({ length: 20 }, (_, k): [number, number] => [0.5 + k * 0.06, 0.02 + (0.1 * (k + 1)) / 20])]
    const x = draw(steps, 1.9)
    expect(regimeSeconds(x, freq, 0.35, 1.8)).toBe(0)
    let last = -Infinity
    for (let t = 0.4; t + 0.1 <= 1.8; t += 0.1) {
      const db = rmsDb(seg(x, t, t + 0.1))
      expect(db, `at ${t.toFixed(1)} s`).toBeGreaterThan(last - 0.5)
      last = db
    }
  })

  // A bow drawn up to speed slowly from rest (the bow pad, its speed re-sent every frame) is taken
  // over once it reaches LAND_MIN, LAND_WAIT later. Taken over 6 ms after it began to move, still at
  // a crawl, a quarter of the male string's strokes drawn up over 80 ms started in the octave.
  it.each([
    [174.61, 174.61, 0.42, 0.93],
    [196, 174.61, 0.42, 0.93],
    [220, 174.61, 0.42, 0.93],
    [246.94, 233.08, 0.32, 0.945]
  ])('lands a stroke drawn up slowly from rest at %f Hz in Helmholtz motion', (freq, open, roughness, damping) => {
    for (const [k, seed] of SEEDS.entries()) {
      const [ramp, top] = [[0.08, 0.9], [0.08, 0.6], [0.2, 0.9], [0.2, 0.3], [0.08, 0.75], [0.03, 0.9]][k]!
      const frame = k % 2 ? 1 / 120 : 1 / 60
      const frames = Array.from({ length: Math.ceil((ramp + 0.35) / frame) }, (_, j) => [j * frame, Math.min(top, (top * (j + 1) * frame) / ramp)] as const)
      const envelope = automation(0, frames.map(([t, v]) => [t, v, 0.02] as const))
      const start = offsets(6)[k]!
      const x = render(freq, { seconds: start + ramp + 0.4, velocity: 1, envelope, forceAt: (t) => liveForce(envelope(t), 0.55, freq, open), beta: 0.13, roughness, damping, start, seed })
      expect(regimeSeconds(x, freq, start, start + ramp + 0.35), `over ${ramp * 1000} ms to ${top}`).toBe(0)
    }
  })

  // The tasto contact point. At 0.19 the string holds Helmholtz motion at every bow speed and force
  // strokes use, the shurankhai's lighter one included, and its pitch measures true.
  it.each([0.19])('stays on the fundamental bowed sul tasto at %f (no octave, no twelfth)', (beta) => {
    for (const [freq, open, roughness, damping] of [
      [174.61, 174.61, 0.42, 0.93],
      [220, 174.61, 0.42, 0.93],
      [233.08, 233.08, 0.32, 0.945],
      [293.66, 233.08, 0.32, 0.945],
      [349.23, 233.08, 0.32, 0.945]
    ] as const)
      for (const [k, lighter] of [0, -0.15].entries())
        for (const [j, v] of [0.4, 0.9].entries()) {
          const bow = strokeBow(v, freq, open)
          const x = render(freq, { seconds: 0.9, velocity: bow.velocity, force: bow.force + lighter, envelope: (t) => 1 - Math.exp(-t / 0.025), beta, roughness, damping, start: 0.05, seed: SEEDS[2 * k + j] })
          expect(regimeSeconds(x, freq, 0.25, 0.85, 2), `${freq} Hz v ${v} force ${lighter}`).toBe(0)
          expect(regimeSeconds(x, freq, 0.25, 0.85, 3), `${freq} Hz v ${v} force ${lighter}`).toBe(0)
          expect(Math.abs(pitchCents(freq, x, 0.35, 0.85)), `${freq} Hz v ${v} force ${lighter}`).toBeLessThan(2)
        }
  })

  // Further from the bridge the model's regimes are unreliable: the far tasto point first used, 0.29,
  // sounds the twelfth (H3 above H1) at the grip strokes have.
  it('sounds the twelfth bowed at the 0.29 contact point first used', () => {
    const bow = strokeBow(0.75, 233.08, 233.08)
    const x = render(233.08, { seconds: 0.9, velocity: bow.velocity, force: bow.force, envelope: (t) => 1 - Math.exp(-t / 0.025), beta: 0.29, roughness: 0.32, damping: 0.945, start: 0.05 })
    expect(regimeSeconds(x, 233.08, 0.25, 0.85, 3)).toBeGreaterThan(0.3)
  })

  // A landing at a new contact point. Force and contact point are a-rate, so the stroke's own values
  // hold from the sample the bow lands on. Read once per render quantum, a landing a few samples into
  // a quantum took the string over at the previous stroke's contact point, which then jumped at the
  // next quantum: the scrambled motion stayed an octave up through a whole shurankhai note.
  it.each([
    [0.13, 0.19],
    [0.19, 0.13],
    [0.13, 0.109]
  ])('lands at its own contact point when the stroke before used another (%f → %f)', (before, after) => {
    for (const [freq, open, roughness, damping] of [
      [233.08, 233.08, 0.32, 0.945],
      [349.23, 233.08, 0.32, 0.945],
      [174.61, 174.61, 0.42, 0.93]
    ] as const)
      for (const [k, start] of offsets(4).entries()) {
        const bow = strokeBow(0.8, freq, open)
        const lighter = after > 0.15 ? -0.15 : 0
        const x = render(freq, {
          seconds: start + 0.8,
          velocity: bow.velocity,
          forceAt: (t) => (t < 0 ? 0.85 : bow.force + lighter),
          betaAt: (t) => (t < 0 ? before : after),
          envelope: (t) => 1 - Math.exp(-t / 0.025),
          roughness,
          damping,
          start,
          seed: SEEDS[k]
        })
        expect(regimeSeconds(x, freq, start, start + 0.75), `${freq} Hz, start ${Math.round(start * SR)}`).toBe(0)
        expect(regimeSeconds(x, freq, start + 0.1, start + 0.75, 3), `${freq} Hz, start ${Math.round(start * SR)}`).toBe(0)
      }
  })

  // Accents (+0.15 force, 15% more bow speed) and accent-release strokes (+0.12, then the bow
  // relaxes to 70% and lightens by 0.08) push the force up as the bow lands. Eased back within 40 ms, as first planned,
  // the push falls while the bow is still catching the string and locks the male string onto its
  // octave on a third to a half of all starts within a render quantum. Held for 200 ms (BowedVoice
  // PUSH_HOLD), it never does.
  it.each([
    ['accent-release', 174.61, 174.61, 0.42, 0.93],
    ['accent-release', 196, 174.61, 0.42, 0.93],
    ['accent-release', 220, 174.61, 0.42, 0.93],
    ['accent-release', 233.08, 233.08, 0.32, 0.945],
    ['accent-release', 261.63, 233.08, 0.32, 0.945],
    ['accent', 174.61, 174.61, 0.42, 0.93],
    ['accent', 220, 174.61, 0.42, 0.93]
  ] as const)('holds the %s force push through the landing at %f Hz: no octave flip at any start', (kind, freq, open, roughness, damping) => {
    const d = 0.577
    for (const v of [0.6, 0.8])
      for (const pull of [true, false]) {
        const bow = strokeBow(v, freq, open)
        const peak = Math.min(1, bow.velocity * (pull ? 1 : 0.88) * (kind === 'accent' ? 1.15 : 1))
        const envelope = strokeEnvelope(kind === 'accent' ? 'swell' : 'accent-release', pull, d)
        const forceAt = kind === 'accent' ? heldPush(bow.force, 0.15, 0.2, 0.04) : heldPush(bow.force, 0.12, 0.2, 0.04, bow.force - 0.08)
        const bite = (t: number) => freq * 2 ** ((-6 / 1200) * Math.exp(-t / 0.015))
        for (const start of offsets(16)) {
          const x = render(freq, { seconds: start + 0.5, velocity: peak, force: bow.force, forceAt, envelope, frequency: bite, beta: 0.13, roughness, damping, start })
          expect(flipped(x, freq, start), `v ${v} ${pull ? 'pull' : 'push'}, start ${Math.round(start * SR)}`).toBe(false)
        }
      }
  })

  // A hammer at the stroke start: the bow lands on the struck upper note, which lifts to the main note
  // after 50 ms; the strike pushes the force 0.1 up. Released after 3 ms with a 20 ms time constant,
  // as first planned, that push flipped stops 2–5 of the male string on up to half of all starts;
  // held while the bow catches the string, never — as for grace notes, which push nothing.
  it.each([2, 3, 4, 5])('lands a hammered upper note on the male string (stop %i) without an octave flip at any start', (stop) => {
    const main = 174.61 * 2 ** (stop / 12)
    for (const semitones of [3, 4]) {
      const upper = main * 2 ** (semitones / 12)
      const frequency = (t: number) => (t < 0.05 ? upper : upper * (main / upper) ** Math.min(1, (t - 0.05) / 0.006))
      for (const v of [0.6, 0.8])
        for (const pull of [true, false]) {
          const bow = strokeBow(v, main, 174.61)
          const envelope = strokeEnvelope('swell', pull, 0.577)
          for (const start of offsets(12)) {
            const x = render(main, { seconds: start + 0.5, velocity: bow.velocity * (pull ? 1 : 0.88), force: bow.force, forceAt: heldPush(bow.force, 0.1, 0.2, 0.02), envelope, frequency, beta: 0.13, roughness: 0.42, damping: 0.93, start })
            expect(flipped(x, main, start), `+${semitones}, v ${v} ${pull ? 'pull' : 'push'}, start ${Math.round(start * SR)}`).toBe(false)
          }
        }
    }
  })

  // Shurankhai colour: 0.15 less force, bowed at the tasto point (0.19), where the lighter stroke
  // still holds Helmholtz motion on both strings.
  it.each([
    [349.23, 233.08],
    [466.16, 233.08],
    [587.33, 233.08],
    [698.46, 233.08],
    [233.08, 174.61],
    [293.66, 174.61]
  ])('bows the lighter shurankhai colour at %f Hz in tune, on the fundamental', (freq, open) => {
    const male = open < 200
    for (const v of [0.6, 0.8, 1]) {
      const bow = strokeBow(v, freq, open)
      const x = render(freq, { ...bow, force: bow.force - 0.15, beta: 0.19, roughness: male ? 0.42 : 0.32, damping: male ? 0.93 : 0.945 })
      expect(h2OverH1(seg(x, 0.4, 0.75), freq), `v ${v}`).toBeLessThan(0)
      expect(Math.abs(pitchCents(freq, x)), `v ${v}`).toBeLessThan(5)
    }
  })

  // Tsokhilt: the wide (±50 cents), rough long-song vibrato, with extra hair roughness while it lasts.
  it.each([
    [196, 174.61, 0.42 + 0.08, 0.93],
    [349.23, 233.08, 0.32 + 0.08, 0.945]
  ])('keeps a wide, rough tsokhilt vibrato at %f Hz centred and on the fundamental', (freq, open, roughness, damping) => {
    const rate = 5.2
    const x = render(freq, { seconds: 1.4, ...strokeBow(0.8, freq, open), beta: 0.13, roughness, damping, detune: (t) => (t < 0.3 ? 0 : 50 * Math.sin(2 * Math.PI * rate * (t - 0.3))) })
    // Short frames over three whole cycles: centred on the note and swinging the full width.
    const cents: number[] = []
    for (let t = 0.5; t + 0.025 < 0.5 + 3 / rate; t += 0.005) {
      const est = detectPitch(seg(x, t, t + 0.025), SR, { minFreq: 60, maxFreq: 2500 })
      if (est) cents.push(centsBetween(freq, est.freq))
    }
    expect(cents.length).toBeGreaterThan(80)
    expect(Math.abs(cents.reduce((a, b) => a + b, 0) / cents.length)).toBeLessThan(5)
    expect(Math.max(...cents)).toBeGreaterThan(35)
    expect(Math.min(...cents)).toBeLessThan(-35)
    expect(Math.max(...cents.map(Math.abs))).toBeLessThan(65)
    expect(h2OverH1(seg(x, 0.5, 1.4), freq)).toBeLessThan(0)
  })

  // Onset ornaments step the pitch while the string is still building up its motion: the main note
  // must still settle in tune and on its fundamental. On the male string they can prolong the
  // landing transient (H2 ≈ H1) by a few tenths of a second, but never flip it to the octave.
  it.each([
    ['grace from a tone below', -2, 0.06, false],
    ['grace from a minor third above', 3, 0.06, false],
    ['hammered major third', 4, 0.05, true],
    ['mordent with the tone above', 2, 0.08, false]
  ] as const)('settles in tune after a %s', (name, semitones, seconds, hammer) => {
    for (const [main, open, roughness, damping] of [
      [311.13, 233.08, 0.32, 0.945],
      [196, 174.61, 0.42, 0.93]
    ] as const) {
      const orn = main * 2 ** (semitones / 12)
      const glide = (t: number, t0: number, from: number, to: number, len: number) => from * (to / from) ** Math.min(1, Math.max(0, (t - t0) / len))
      // Mordent: main, neighbour, main (each half the gesture); grace and hammer: neighbour, then main.
      const pitchAt = name.startsWith('mordent')
        ? (t: number) => (t < seconds / 2 ? main : t < seconds ? glide(t, seconds / 2, main, orn, 0.008) : glide(t, seconds, orn, main, 0.008))
        : (t: number) => (t < seconds ? orn : glide(t, seconds, orn, main, 0.008))
      const bow = strokeBow(0.8, main, open)
      const x = render(main, {
        seconds: 1,
        ...bow,
        ...(hammer ? { forceAt: heldPush(bow.force, 0.1, 0.2, 0.02) } : {}),
        beta: 0.13,
        roughness,
        damping,
        frequency: pitchAt
      })
      expect(Math.abs(pitchCents(main, x, 0.25, 0.75)), `${main} Hz`).toBeLessThan(5)
      expect(h2OverH1(seg(x, 0.1, 0.5), main), `${main} Hz`).toBeLessThan(3)
      expect(h2OverH1(seg(x, 0.65, 1), main), `${main} Hz`).toBeLessThan(0)
    }
  })

  it('produces Helmholtz motion rich in harmonics, not a sine', () => {
    const out = render(233.08)
    let peak = 0
    let sumSq = 0
    for (let i = Math.floor(0.4 * SR); i < out.length; i++) {
      peak = Math.max(peak, Math.abs(out[i]!))
      sumSq += out[i]! ** 2
    }
    const rms = Math.sqrt(sumSq / (out.length - Math.floor(0.4 * SR)))
    expect(rms).toBeGreaterThan(0.005)
    // A sine has crest factor √2; a bowed-string velocity wave is spikier.
    expect(peak / rms).toBeGreaterThan(1.6)
  })

  it('falls silent after the bow lifts, and idles at zero cost', () => {
    const p = new Processor()
    const params: Params = {
      frequency: new Float32Array([233]),
      detune: new Float32Array([0]),
      velocity: new Float32Array([0.8]),
      force: new Float32Array([0.6]),
      beta: new Float32Array([0.127]),
      roughness: new Float32Array([0.3]),
      damping: new Float32Array([0.94])
    }
    const block = new Float32Array(BLOCK)
    for (let i = 0; i < 200; i++) p.process([], [[block]], params)
    params.velocity = new Float32Array([0])
    for (let i = 0; i < 4000; i++) p.process([], [[block]], params)
    expect(Math.max(...block.map(Math.abs))).toBe(0)
  })
})
