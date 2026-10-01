import { describe, expect, it } from 'vitest'
import {
  analyzeAudio,
  bulanovMaxima,
  COMPARISON_TOLERANCES,
  compareFeatures,
  LTAS_BANDS_HZ,
  melodyMatch,
  mixToMono,
  openStringBalance,
  REFERENCE_ROWS,
  RENDER_CHECKS,
  type AudioFeatures
} from './analysis'
import { fft, nextPowerOfTwo } from './fft'
import { centsBetween, freqToMidi, midiToFreq } from './pitch'

const SR = 44100

/** 1/k amplitudes: a band-limited sawtooth. */
const SAW = Array.from({ length: 400 }, (_, k) => 1 / (k + 1))
/** Fewer partials for the long renders (quicker, still bright enough to track). */
const SAW30 = SAW.slice(0, 30)

/**
 * Additive, band-limited, phase-continuous tone following `freq(t)` (Hz, null = silence) and
 * `amp(t)`; harmonic k+1 has amplitude partials[k], partials above 0.45·SR are left out.
 */
function synth(seconds: number, freq: (t: number) => number | null, amp: (t: number) => number, partials: readonly number[] = SAW): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const f = freq(t)
    const a = amp(t)
    if (f === null || a === 0) continue
    phase = (phase + (2 * Math.PI * f) / SR) % (2 * Math.PI)
    const count = Math.min(partials.length, Math.floor((0.45 * SR) / f))
    // sin(kθ) by the Chebyshev recurrence.
    const c2 = 2 * Math.cos(phase)
    let prev = 0
    let cur = Math.sin(phase)
    let v = 0
    for (let k = 1; k <= count; k++) {
      v += partials[k - 1]! * cur
      const next = c2 * cur - prev
      prev = cur
      cur = next
    }
    out[i] = a * v
  }
  return out
}

/** Linear fade in/out of `fade` seconds inside [start, end], silence outside. */
const gate =
  (start: number, end: number, fade = 0.01, level = 0.3) =>
  (t: number) =>
    t < start || t > end ? 0 : level * Math.min(1, (t - start) / fade, (end - t) / fade)

const steady = (hz: number, start: number, end: number) => (t: number) => (t >= start && t <= end ? hz : null)

function random(seed = 1) {
  return () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
}

function noise(length: number, rms: number, seed = 1): Float32Array {
  const next = random(seed)
  return Float32Array.from({ length }, () => (next() - 0.5) * Math.sqrt(12) * rms)
}

interface Planned {
  start: number
  end: number
  midi: number
  level?: number
  /** Vibrato width (cents, 5.5 Hz), reaching full width after `ramp` seconds. */
  vib?: number
  ramp?: number
  /** Loudness moving with the vibrato: gain 1 + am·(vibrato / width). */
  am?: number
}

/** Separately bowed notes: 30 ms attack, 20 ms release, silence between them. */
function render(plan: readonly Planned[], seconds: number, partials: readonly number[] = SAW30): Float32Array {
  let cursor = 0
  const find = (t: number) => {
    while (cursor < plan.length - 1 && t >= plan[cursor]!.end) cursor++
    const n = plan[cursor]!
    return t >= n.start && t < n.end ? n : null
  }
  const vibrato = (n: Planned, t: number) => (n.vib ?? 0) * Math.min(1, n.ramp ? (t - n.start) / n.ramp : 1) * Math.sin(2 * Math.PI * 5.5 * (t - n.start))
  return synth(
    seconds,
    (t) => {
      const n = find(t)
      return n ? midiToFreq(n.midi) * 2 ** (vibrato(n, t) / 1200) : null
    },
    (t) => {
      const n = find(t)
      if (!n) return 0
      const am = n.am && n.vib ? 1 + (n.am * vibrato(n, t)) / n.vib : 1
      return (n.level ?? 0.3) * am * Math.min(1, (t - n.start) / 0.03, (n.end - t) / 0.02)
    },
    partials
  )
}

/** Consecutive notes (MIDI, seconds) with `gap` seconds of silence between them. */
function sequence(notes: readonly [number, number][], gap = 0.02): { plan: Planned[]; seconds: number } {
  const plan: Planned[] = []
  let t = 0.2
  for (const [midi, length] of notes) {
    plan.push({ start: t, end: t + length, midi })
    t += length + gap
  }
  return { plan, seconds: t + 0.3 }
}

/** One bow stroke through `notes` (MIDI, seconds) from 0.2 s, each change a raised-cosine finger transition of `transition` seconds. */
function legato(notes: readonly (readonly [number, number])[], transition: number): Float32Array {
  const starts: number[] = []
  let end = 0.2
  for (const [, length] of notes) {
    starts.push(end)
    end += length
  }
  return synth(
    end + 0.2,
    (t) => {
      if (t < 0.2 || t > end) return null
      const i = Math.max(0, starts.findLastIndex((s) => t >= s))
      const into = t - starts[i]!
      const [from, to] = [notes[Math.max(0, i - 1)]![0], notes[i]![0]]
      return midiToFreq(i > 0 && into < transition ? from + (to - from) * (0.5 - 0.5 * Math.cos((Math.PI * into) / transition)) : to)
    },
    gate(0.2, end, 0.03),
    SAW30
  )
}

/** A detached pentatonic melody (150–600 ms notes, `rest` between them, no repeated pitch). */
function melody(count: number, rest: number, seed: number): { plan: Planned[]; seconds: number } {
  const next = random(seed)
  const scale = [53, 55, 58, 60, 62, 65, 67, 70, 72, 74, 77]
  const plan: Planned[] = []
  let t = 0.2
  for (let i = 0; i < count; i++) {
    const length = 0.15 + next() * 0.45
    let midi = scale[Math.floor(next() * scale.length)]!
    if (midi === plan[i - 1]?.midi) midi = scale[(scale.indexOf(midi) + 1) % scale.length]!
    plan.push({ start: t, end: t + length, midi })
    t += length + rest
  }
  return { plan, seconds: t + 0.3 }
}

/** `beats` (in quarter notes) at `bpm`, detached by `detach` seconds, on a pentatonic scale. */
function rhythm(bpm: number, beats: readonly number[], repeats: number, seed = 1, detach = 0.03): { plan: Planned[]; seconds: number } {
  const next = random(seed)
  const scale = [53, 55, 58, 60, 62, 65, 67, 70, 72]
  const plan: Planned[] = []
  let t = 0.3
  for (let i = 0; i < repeats * beats.length; i++) {
    const length = (beats[i % beats.length]! * 60) / bpm
    let midi = scale[Math.floor(next() * scale.length)]!
    if (midi === plan[i - 1]?.midi) midi = scale[(scale.indexOf(midi) + 1) % scale.length]!
    plan.push({ start: t, end: t + length - detach, midi })
    t += length
  }
  return { plan, seconds: t + 0.3 }
}

/**
 * Convolution with a decaying-noise room response (`t60`, wet RMS `wetDb` re the dry signal) plus
 * the direct sound. `dark`: as in a real room, the highs decay twice as fast, after a few early
 * reflections.
 */
function reverb(dry: Float32Array, t60: number, wetDb: number, seed = 11, dark = false): Float32Array {
  const next = random(seed)
  const irLength = Math.round(1.2 * t60 * SR)
  const size = nextPowerOfTwo(dry.length + irLength)
  const [xr, xi, hr, hi] = [new Float64Array(size), new Float64Array(size), new Float64Array(size), new Float64Array(size)]
  xr.set(dry)
  let low = 0
  for (let i = Math.round(0.01 * SR); i < irLength; i++) {
    const n = next() - 0.5
    low = 0.85 * low + 0.15 * n
    hr[i] = dark ? 3 * low * Math.exp((-6.91 * i) / (t60 * SR)) + (n - low) * Math.exp((-13.8 * i) / (t60 * SR)) : n * Math.exp((-6.91 * i) / (t60 * SR))
  }
  if (dark) for (const [ms, g] of [[7, 0.6], [13, -0.45], [19, 0.35], [29, -0.3], [37, 0.25]] as const) hr[Math.round((ms / 1000) * SR)] += 8 * g
  fft(xr, xi)
  fft(hr, hi)
  for (let k = 0; k < size; k++) {
    const re = xr[k]! * hr[k]! - xi[k]! * hi[k]!
    const im = xr[k]! * hi[k]! + xi[k]! * hr[k]!
    // Conjugate, so a second forward FFT inverts.
    xr[k] = re
    xi[k] = -im
  }
  fft(xr, xi)
  let dryEnergy = 0
  let wetEnergy = 0
  for (let i = 0; i < dry.length; i++) {
    dryEnergy += dry[i]! ** 2
    wetEnergy += (xr[i]! / size) ** 2
  }
  const g = (10 ** (wetDb / 20) * Math.sqrt(dryEnergy)) / Math.sqrt(wetEnergy)
  return Float32Array.from({ length: dry.length + irLength }, (_, i) => (i < dry.length ? dry[i]! : 0) + (g * xr[i]!) / size)
}

const rmsOf = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length)
const cents = (a: number, b: number) => Math.abs(centsBetween(a, b))
const pitches = (f: AudioFeatures) => f.notes.map((n) => Math.round(freqToMidi(n.f0!)))

/** A morin khuur-like spectrum: H2 strongest, H1 `h1` of 0.55, a bump around H4–H6, 1/k beyond. */
const openString = (h1: number) => Array.from({ length: 30 }, (_, k) => (k === 0 ? 0.55 * h1 : k === 1 ? 0.6 : k === 2 ? 1.1 / 3 : k <= 5 ? 1.4 / (k + 1) : 1 / (k + 1)))

/** High, low, high in one bow stroke (legato), with a 12 dB bow-change dip at each note boundary (re-bowed), or detached by 20 ms rests. */
function highLowHigh(low: number, interval: number, seconds: number, bowing: 'detached' | 'rebowed' | 'legato', partials: readonly number[]): Float32Array {
  if (bowing === 'detached') {
    const plan: Planned[] = [
      { start: 0.2, end: 0.5, midi: low + interval },
      { start: 0.52, end: 0.52 + seconds, midi: low },
      { start: 0.54 + seconds, end: 0.84 + seconds, midi: low + interval }
    ]
    return render(plan, 1.2 + seconds, partials)
  }
  const [a, b, end] = [0.5, 0.5 + seconds, 0.8 + seconds]
  const dip = 10 ** (-12 / 20)
  return synth(
    end + 0.3,
    (t) => (t < 0.2 || t > end ? null : midiToFreq(t >= a && t < b ? low : low + interval)),
    (t) => {
      if (t < 0.2 || t > end) return 0
      const edges = 0.3 * Math.min(1, (t - 0.2) / 0.03, (end - t) / 0.02)
      return bowing === 'legato' ? edges : edges * (dip + (1 - dip) * Math.min(1, Math.min(Math.abs(t - a), Math.abs(t - b)) / 0.025))
    },
    partials
  )
}

describe('analyzeAudio: pitch and harmonics', () => {
  it('measures the pitch, harmonic balance, centroid and HNR of a steady tone', () => {
    const partials = [1, 0.5, 0.25, 0.2, 0.1, 0.1, 0.05, 0.05, 0.02, 0.02]
    const f0 = 233.08
    const audio = synth(1.9, steady(f0, 0.2, 1.7), gate(0.2, 1.7, 0.02), partials)
    const { notes, summary } = analyzeAudio(audio, SR)
    expect(notes).toHaveLength(1)
    const note = notes[0]!
    expect(cents(f0, note.f0!)).toBeLessThan(2)
    expect(note.start).toBeCloseTo(0.2, 1)
    expect(note.end).toBeCloseTo(1.7, 1)
    partials.forEach((a, k) => {
      if (a >= 0.05) expect(note.harmonicsDb[k]).toBeCloseTo(20 * Math.log10(a), 0)
    })
    const centroid = partials.reduce((s, a, k) => s + a * (k + 1) * f0, 0) / partials.reduce((s, a) => s + a, 0)
    expect(Math.abs(note.centroidHz! / centroid - 1)).toBeLessThan(0.03)
    expect(note.hnrDb!).toBeGreaterThan(50)
    expect(summary.harmonicsDb[0]).toBe(0)
    expect(cents(f0, summary.f0MedianHz!)).toBeLessThan(2)
  })

  it('reads a sawtooth as H2−H1 ≈ −6 dB and H3−H1 ≈ −9.5 dB', () => {
    const { summary } = analyzeAudio(synth(1.4, steady(174.61, 0.2, 1.2), gate(0.2, 1.2)), SR)
    expect(summary.harmonicsDb[1]! - summary.harmonicsDb[0]!).toBeCloseTo(-6.02, 0)
    expect(summary.harmonicsDb[2]! - summary.harmonicsDb[0]!).toBeCloseTo(-9.54, 0)
    expect(summary.harmonicsDb).toHaveLength(10)
  })

  it('keeps rests unvoiced and returns nothing for silence', () => {
    const silent = analyzeAudio(new Float32Array(SR), SR)
    expect(silent.notes).toEqual([])
    expect(silent.pitchTrack).toHaveLength(100)
    expect(silent.pitchTrack.every((p) => p.f0 === null)).toBe(true)
    expect(silent.summary).toMatchObject({ f0MedianHz: null, vibratoRateHz: null, harmonicsDb: [], noteRate: 0, glideShare: 0, tempoBpm: null, pitchClasses: [], ltasDb: [], trillCount: 0 })

    const { pitchTrack } = analyzeAudio(synth(1.2, steady(220, 0.3, 0.8), gate(0.3, 0.8)), SR)
    const at = (t: number) => pitchTrack[Math.round(t * 100)]!.f0
    expect(at(0.1)).toBeNull()
    expect(cents(220, at(0.5)!)).toBeLessThan(3)
    expect(at(1.0)).toBeNull()
  })

  it('tracks a note despite a weak fundamental', () => {
    const partials = [0.03, ...SAW.slice(1, 12)]
    const { notes } = analyzeAudio(synth(1.2, steady(174.61, 0.2, 1.0), gate(0.2, 1.0), partials), SR)
    expect(notes).toHaveLength(1)
    expect(cents(174.61, notes[0]!.f0!)).toBeLessThan(3)
  })
})

describe('analyzeAudio: vibrato', () => {
  const vibratoTone = (seconds: number, f0: number, rate: number, extentCents: number) =>
    synth(
      seconds + 0.4,
      (t) => (t < 0.2 || t > seconds + 0.2 ? null : f0 * 2 ** ((extentCents * Math.sin(2 * Math.PI * rate * (t - 0.2))) / 1200)),
      gate(0.2, seconds + 0.2, 0.02)
    )

  it.each([
    [5, 30, 2],
    [7, 20, 2],
    [5.5, 25, 3.5]
  ])('recovers %f Hz ±%f cents vibrato (%f s note)', (rate, extent, seconds) => {
    const { notes, summary } = analyzeAudio(vibratoTone(seconds, 233.08, rate, extent), SR)
    expect(notes).toHaveLength(1)
    expect(Math.abs(notes[0]!.vibratoRateHz! - rate)).toBeLessThan(0.3)
    expect(Math.abs(notes[0]!.vibratoExtentCents! - extent)).toBeLessThan(5)
    expect(cents(233.08, notes[0]!.f0!)).toBeLessThan(5)
    expect(summary.glideShare).toBe(0)
    expect(summary.trillCount).toBe(0)
  })

  it.each([4, 6, 8])('does not split a ±60 cent vibrato at %f Hz', (rate) => {
    const { notes } = analyzeAudio(vibratoTone(2, 196, rate, 60), SR)
    expect(notes).toHaveLength(1)
    expect(Math.abs(notes[0]!.vibratoRateHz! - rate)).toBeLessThan(0.4)
  })

  it('reports a straight tone as narrow, without a vibrato rate', () => {
    const { notes } = analyzeAudio(synth(1.4, steady(233.08, 0.2, 1.2), gate(0.2, 1.2)), SR)
    expect(notes[0]!.vibratoRateHz).toBeNull()
    expect(notes[0]!.vibratoExtentCents!).toBeLessThan(2)
  })

  it('counts the long notes with vibrato, times its onset and tells in-phase from anti-phase loudness', () => {
    const plan = (vib: (i: number) => number, extra: Partial<Planned> = {}) =>
      Array.from({ length: 5 }, (_, i): Planned => ({ start: 0.3 + i * 1.8, end: 1.9 + i * 1.8, midi: 58 + (i % 3) * 2, vib: vib(i), ...extra }))
    const some = analyzeAudio(render(plan((i) => (i < 3 ? 30 : 0)), 9.5), SR).summary
    expect(some.vibratoShare).toBeCloseTo(3 / 5, 5)
    // Width reaching full over 0.4 s: half width at about 0.2 s; at once, within the first cycle.
    const delayed = analyzeAudio(render(plan(() => 30, { ramp: 0.4 }), 9.5), SR).summary
    expect(delayed.vibratoOnsetMs!).toBeGreaterThan(150)
    expect(delayed.vibratoOnsetMs!).toBeLessThan(270)
    expect(analyzeAudio(render(plan(() => 30), 9.5), SR).summary.vibratoOnsetMs!).toBeLessThan(150)
    expect(analyzeAudio(render(plan(() => 30, { am: 0.3 }), 9.5), SR).summary.amPhase!).toBeGreaterThan(0.5)
    expect(analyzeAudio(render(plan(() => 30, { am: -0.3 }), 9.5), SR).summary.amPhase!).toBeLessThan(-0.5)
  })
})

describe('analyzeAudio: note segmentation', () => {
  it('splits at rests, legato pitch steps and re-bowed repeats', () => {
    // F3 · rest · B♭3→C4 legato · rest · D4, D4 re-bowed after a 20 ms break.
    const plan = [
      { start: 0.2, end: 0.7, midi: 53 },
      { start: 0.9, end: 1.4, midi: 58 },
      { start: 1.4, end: 1.9, midi: 60 },
      { start: 2.1, end: 2.49, midi: 62 },
      { start: 2.51, end: 2.9, midi: 62 }
    ]
    const at = (t: number) => plan.find((n) => t >= n.start && t < n.end) ?? null
    const envelopes = [gate(0.2, 0.7), gate(0.9, 1.9), gate(2.1, 2.49), gate(2.51, 2.9)]
    const audio = synth(
      3.1,
      (t) => {
        const n = at(t)
        return n ? midiToFreq(n.midi) : null
      },
      (t) => envelopes.reduce((s, e) => s + e(t), 0)
    )
    const { notes, summary } = analyzeAudio(audio, SR)
    expect(notes.map((n) => Math.round(freqToMidi(n.f0!)))).toEqual([53, 58, 60, 62, 62])
    notes.forEach((n, i) => {
      expect(Math.abs(n.start - plan[i]!.start)).toBeLessThan(0.04)
      expect(Math.abs(n.end - plan[i]!.end)).toBeLessThan(0.04)
    })
    expect(summary.noteRate).toBeCloseTo(5 / 2.7, 1)
    // Separately bowed notes have an attack; the legato C4 does not.
    expect(notes[0]!.attackMs).not.toBeNull()
    expect(notes[2]!.attackMs).toBeNull()
  })

  it('keeps a slow scoop into a note as one note at the target pitch', () => {
    const target = midiToFreq(58)
    const audio = synth(1.4, (t) => (t < 0.2 || t > 1.2 ? null : t < 0.4 ? midiToFreq(56 + ((t - 0.2) / 0.2) * 2) : target), gate(0.2, 1.2))
    const { notes } = analyzeAudio(audio, SR)
    expect(notes).toHaveLength(1)
    expect(cents(target, notes[0]!.f0!)).toBeLessThan(5)
    expect(notes[0]!.start).toBeCloseTo(0.2, 1)
  })

  it.each([
    [62, 1, 0.25, 'eased', 8, 0, false],
    [62, 1, 0.3, 'eased', 8, 30, false],
    [62, 1, 0.35, 'eased', 0, 30, false],
    [62, 2, 0.3, 'eased', 8, 0, false],
    [62, 3, 0.3, 'linear', 0, 25, true],
    [55, 1, 0.25, 'eased', 0, 20, true],
    [55, 1, 0.3, 'eased', 8, 30, true],
    [55, 2, 0.35, 'linear', 0, 30, true],
    [69, 2, 0.3, 'eased', 8, 30, true]
  ] as const)('keeps a scoop into MIDI %i (%f semitones over %f s, %s, %f cents jitter, ±%f cents vibrato, during it: %s) inside the note', (target, depth, seconds, shape, jitterCents, vibrato, during) => {
    // Smooth random jitter (≈ RMS `jitterCents`); the vibrato starts when the scoop arrives, or runs throughout.
    const next = random(5)
    const knots = Array.from({ length: 40 }, () => (next() - 0.5) * Math.sqrt(12) * jitterCents)
    const jitter = (t: number) => {
      const x = t * 12
      const i = Math.floor(x)
      const w = 0.5 - 0.5 * Math.cos(Math.PI * (x - i))
      return knots[i]! * (1 - w) + knots[i + 1]! * w
    }
    const audio = synth(
      1.6,
      (t) => {
        if (t < 0.2 || t > 1.4) return null
        const u = (t - 0.2) / seconds
        const reached = u >= 1 ? 1 : shape === 'linear' ? u : 0.5 - 0.5 * Math.cos(Math.PI * u)
        const wobble = during || u >= 1 ? vibrato * Math.sin(2 * Math.PI * 5.5 * (t - 0.2)) : 0
        return midiToFreq(target - depth * (1 - reached) + (jitter(t) + wobble) / 100)
      },
      gate(0.2, 1.4, 0.03),
      SAW30
    )
    const features = analyzeAudio(audio, SR)
    expect(pitches(features)).toEqual([target])
    expect(features.notes[0]!.start).toBeCloseTo(0.2, 1)
  })

  it('keeps a fall off the end of a note with vibrato inside the note', () => {
    const fall = (t: number) => (t < 1.05 ? 0 : 0.5 - 0.5 * Math.cos((Math.PI * (t - 1.05)) / 0.25))
    const audio = synth(1.6, (t) => (t < 0.2 || t > 1.3 ? null : midiToFreq(62 - fall(t) + 0.25 * Math.sin(2 * Math.PI * 5.5 * t))), gate(0.2, 1.3, 0.03), SAW30)
    expect(pitches(analyzeAudio(audio, SR))).toEqual([62])
  })

  it.each([
    [55, 2, 0.35, 6.5, 25, 0],
    [55, 2, 0.35, 6.5, 25, Math.PI / 4],
    [55, 2, 0.3, 7, 35, 1],
    [62, 2, 0.35, 7, 35, 2.32],
    [62, 3, 0.35, 7, 35, 1.75]
  ])('keeps a scoop into MIDI %i (%f semitones over %f s) with fast vibrato running through it (%f Hz, ±%f cents, phase %f) as one note', (target, depth, seconds, hz, width, phase) => {
    // The vibrato can cancel the scoop's slope for a moment and leave a staircase of short segments.
    for (const shape of ['eased', 'linear']) {
      const audio = synth(
        1.7,
        (t) => {
          if (t < 0.25 || t > 1.45) return null
          const u = (t - 0.25) / seconds
          const reached = u >= 1 ? 1 : shape === 'linear' ? u : 0.5 - 0.5 * Math.cos(Math.PI * u)
          return midiToFreq(target - depth * (1 - reached) + (width * Math.sin(2 * Math.PI * hz * (t - 0.25) + phase)) / 100)
        },
        gate(0.25, 1.45, 0.05),
        SAW30
      )
      expect(pitches(analyzeAudio(audio, SR)), shape).toEqual([target])
    }
  })

  it.each([
    ['a pentatonic run of 100 ms notes with 30 ms transitions', [[53, 0.4], ...[55, 58, 60, 62, 65, 67].map((m) => [m, 0.1]), [70, 0.4]], 0.03],
    ['a diatonic run of 100 ms notes with 30 ms transitions', [[60, 0.4], ...[62, 64, 65, 67, 69, 71].map((m) => [m, 0.1]), [72, 0.4]], 0.03],
    ['a chromatic run of 80 ms notes with instant steps', [[60, 0.4], ...[61, 62, 63, 64, 65, 66].map((m) => [m, 0.08]), [67, 0.4]], 0],
    ['an 80 ms semitone grace note', [[60, 0.5], [61, 0.08], [62, 0.5]], 0.01]
  ] as [string, [number, number][], number][])('keeps every note of %s (a staircase, not one slow slide)', (_, notes, transition) => {
    const features = analyzeAudio(legato(notes, transition), SR)
    expect(pitches(features)).toEqual(notes.map(([m]) => m))
    expect(features.summary.glideShare).toBeLessThan(0.05)
  })

  it.each([
    [[55, 0.3], [53, 0.2], [72, 0.3]],
    [[65, 0.3], [53, 0.2], [65, 0.3]],
    [[67, 0.3], [55, 0.15], [67, 0.3]],
    [[60, 0.3], [58, 0.2], [77, 0.3]],
    [[72, 0.3], [53, 0.1], [72, 0.3]]
  ] as [number, number][][])('keeps a re-bowed note an octave, a twelfth or two octaves below its neighbours (%j, %j, %j)', (...notes) => {
    const { plan, seconds } = sequence(notes)
    expect(pitches(analyzeAudio(render(plan, seconds), SR))).toEqual(notes.map(([m]) => m))
  })

  it.each([
    [72, 53],
    [65, 53],
    [70, 58],
    [77, 58]
  ])('keeps a melody note %i alternating with the open string %i: re-bowed, bowed on either note only, or legato', (high, open) => {
    // Ten notes of 150–250 ms, touching.
    const next = random(high)
    const plan: Planned[] = []
    for (let i = 0, t = 0.2; i < 10; i++) {
      const length = 0.15 + next() * 0.1
      plan.push({ start: t, end: t + length, midi: i % 2 ? open : high })
      t += length
    }
    const end = plan[plan.length - 1]!.end
    const find = (x: number) => plan.find((n) => x >= n.start && x < n.end) ?? null
    const dip = 10 ** (-12 / 20)
    // A bow change (12 dB dip) around every note, only before each melody note (the open string
    // slurred after it, as in gallop bowing), only before each open string (a re-bowed note at the
    // pitch of the one two back is no reverb copy), or none.
    for (const bowing of ['every note', 'melody note', 'open string', 'legato']) {
      const audio = synth(
        end + 0.3,
        (x) => {
          const n = find(x)
          return n ? midiToFreq(n.midi) : null
        },
        (x) => {
          const n = find(x)
          if (!n) return 0
          const edges = Math.min(1, (x - 0.2) / 0.03, (end - x) / 0.02)
          if (bowing === 'legato') return 0.3 * edges
          const [bowIn, bowOut] = bowing === 'every note' ? [true, true] : bowing === 'melody note' ? [n.midi === high, n.midi === open] : [n.midi === open, n.midi === high]
          return 0.3 * edges * (dip + (1 - dip) * Math.min(1, bowIn ? (x - n.start) / 0.025 : 1, bowOut ? (n.end - x) / 0.025 : 1))
        },
        SAW30
      )
      expect(pitches(analyzeAudio(audio, SR)), bowing).toEqual(plan.map((n) => n.midi))
    }
  })

  it.each([
    ['a sawtooth with H1 9 dB down', 53, 0.1, SAW30.map((v, k) => (k ? v : v * 10 ** (-9 / 20)))],
    ['a sawtooth with H1 9 dB down', 58, 0.2, SAW30.map((v, k) => (k ? v : v * 10 ** (-9 / 20)))],
    ['a morin khuur spectrum with H1 12 dB down', 55, 0.1, openString(0.25)],
    ['a morin khuur spectrum with H1 12 dB down', 53, 0.2, openString(0.25)],
    ['a morin khuur spectrum with H1 15 dB down', 58, 0.15, openString(0.18)]
  ] as const)('keeps a note an octave below its neighbours whose fundamental is weak (%s, MIDI %i, %f s), detached, re-bowed or legato', (_, low, seconds, partials) => {
    // The open strings' H1 lies 1–3 dB below H2 (Bulanov), and more in a room or on a phone: its own
    // period is still there (the odd partials), and a note starting at an onset is never a slip.
    for (const bowing of ['detached', 'rebowed', 'legato'] as const) {
      expect(pitches(analyzeAudio(highLowHigh(low, 12, seconds, bowing, partials), SR)), bowing).toEqual([low + 12, low, low + 12])
    }
  })

  it('keeps a re-bowed note an octave below when its onset lands a frame after the pitch change', () => {
    // The steepest rise after a 12 dB bow-change dip can come a frame late, leaving one frame of the
    // low note before the onset: that fragment is not an earlier note whose reverb the low note is.
    for (const low of [53, 55, 58]) for (const seconds of [0.15, 0.2, 0.25]) {
      expect(pitches(analyzeAudio(highLowHigh(low, 12, seconds, 'rebowed', openString(1)), SR)), `${low} ${seconds}`).toEqual([low + 12, low, low + 12])
    }
  })

  it('cuts a reverb tail off the note and keeps soft repeats bowed after a rest', () => {
    const f = midiToFreq(60)
    const note = gate(0.2, 0.8)
    // Reverb carrying on from the note's end (no silence between them).
    const tail = synth(1.8, (t) => (t < 1.6 ? f : null), (t) => note(t) + (t >= 0.79 ? 0.06 * Math.exp(-(t - 0.79) / 0.3) : 0))
    const cut = analyzeAudio(tail, SR)
    expect(cut.notes).toHaveLength(1)
    expect(cut.notes[0]!.end).toBeCloseTo(0.8, 1)
    // An echo-like repeat 11.5 dB softer after a 150 ms rest, with a 15, 40 or 60 ms attack.
    for (const attack of [0.015, 0.04, 0.06]) {
      const echo = synth(1.8, (t) => (t < 1.7 ? f : null), (t) => note(t) + (t >= 0.95 && t < 1.6 ? 0.08 * Math.min(1, (t - 0.95) / attack, (1.6 - t) / 0.02) : 0))
      expect(pitches(analyzeAudio(echo, SR))).toEqual([60, 60])
    }
  })

  it.each([
    [1.2, -10.5, 5],
    [1.2, -10.5, 10],
    [1.5, -6, 5],
    [2, -3, 5],
    [2, -3, 10],
    [2, -3, 12]
  ])('keeps the notes through a room of T60 %f s, wet %f dB (melody %i: no extra notes at note ends)', (t60, wetDb, seed) => {
    const { plan, seconds } = melody(24, 0.08, seed)
    const wet = analyzeAudio(reverb(render(plan, seconds), t60, wetDb), SR)
    expect(pitches(wet)).toEqual(plan.map((n) => n.midi))
  })

  it('does not read the tails of several notes ringing on together as more notes', () => {
    // After the last note the room holds the 65s and the 58, and the tracker hops between them.
    const { plan, seconds } = sequence(
      [
        [60, 0.5],
        [65, 0.4],
        [65, 0.21],
        [58, 0.15]
      ],
      0.08
    )
    expect(pitches(analyzeAudio(reverb(render(plan, seconds), 2, -3), SR))).toEqual([60, 65, 65, 58])
  })

  it('splits same-pitch repeats whose rest the reverb fills', () => {
    const { plan, seconds } = sequence(
      [
        [67, 0.5],
        [67, 0.3],
        [67, 0.4],
        [62, 0.3],
        [62, 0.3],
        [58, 0.5]
      ],
      0.08
    )
    expect(pitches(analyzeAudio(reverb(render(plan, seconds), 1.5, -6), SR))).toEqual([67, 67, 67, 62, 62, 58])
  })

  it.each([
    [1.2, -10, 2],
    [1.2, -10, 6],
    [1.2, -8, 3],
    [1.5, -6, 2],
    [1.5, -6, 8],
    [1.5, -6, 11]
  ])('does not read reverb recovering after a release as a note (vibrato, a room of T60 %f s, wet %f dB, with darker tails, melody %i)', (t60, wetDb, seed) => {
    // After a note's release the level drops into a null of the room's tail and recovers to it,
    // often nearly as loud as the note: only the partials that had cancelled come back, so it is no
    // attack and the copy of the note heard there is dropped. The vibrato sweeping the room's
    // resonances also swings the level inside a note: without a release that is one note.
    const { plan, seconds } = melody(24, 0.08, seed)
    for (const note of plan) note.vib = 20
    expect(pitches(analyzeAudio(reverb(render(plan, seconds), t60, wetDb, seed, true), SR))).toEqual(plan.map((n) => n.midi))
  })

  it.each([
    [53, -11.5, 0.15, 1.2, -10.5],
    [60, -11.5, 0.15, 1.2, -10.5],
    [67, -11.5, 0.15, 1.2, -10.5],
    [62, -14, 0.2, 1.2, -10.5],
    [55, -14, 0.2, 1, -12],
    [69, -14, 0.12, 1, -12]
  ])('keeps a soft same-pitch repeat heard through a room (MIDI %i, %f dB softer after a %f s rest, T60 %f s, wet %f dB)', (midi, db, rest, t60, wetDb) => {
    // It rises out of the tail and then holds, where a tail only decays.
    const f = midiToFreq(midi)
    const soft = 0.3 * 10 ** (db / 20)
    const [from, to] = [0.8 + rest, 1.4 + rest]
    const dry = synth(to + 0.45, (t) => (t < to + 0.35 ? f : null), (t) => gate(0.2, 0.8)(t) + (t >= from && t < to ? soft * Math.min(1, (t - from) / 0.025, (to - t) / 0.02) : 0), SAW30)
    expect(pitches(analyzeAudio(reverb(dry, t60, wetDb, 11, true), SR))).toEqual([midi, midi])
  })

  /** Three gallop groups on one pitch (loud 0.3 s, then two notes `db` softer), each note ending `gap` before the next, from 0.2 s + `late`. */
  const gallop = (midi: number, db: number, gap: number, late = 0, short = 0.12) => {
    const plan: Planned[] = []
    let t = 0.2 + late
    for (let r = 0; r < 3; r++) {
      for (const [length, level] of [[0.3, 0], [short, db], [short, db]] as const) {
        plan.push({ start: t, end: t + length - gap, midi, level: 0.3 * 10 ** (level / 20) })
        t += length
      }
    }
    return { plan, seconds: t + 0.3 }
  }

  it.each([
    [55, 0.025, 0],
    [55, 0.025, 0.005],
    [55, 0.025, 0.006],
    [67, 0.02, 0.003],
    [55, 0.03, 0.009],
    [67, 0.015, 0.007],
    [55, 0.04, 0.002]
  ])('keeps the soft re-bowed notes of an accented gallop on one pitch (MIDI %i, %f s apart, starting %f s late)', (midi, gap, late) => {
    // A quiet same-pitch note after a real silence is an attack, however that silence falls between
    // the analysis frames (a frame straddling it still holds the release).
    const { plan, seconds } = gallop(midi, -9, gap, late)
    expect(pitches(analyzeAudio(render(plan, seconds), SR))).toEqual(plan.map(() => midi))
  })

  it.each([
    [53, -6, 0.035, 0.1],
    [53, -9, 0.035, 0.1],
    [55, -6, 0.035, 0.1],
    [55, -9, 0.03, 0.1]
  ])('keeps the short notes of a dry gallop on the low strings (MIDI %i, %f dB, %f s apart, in slots of %f s)', (midi, db, gap, length) => {
    // Between silences the tracker locks on a frame late and lets go a frame early.
    const { plan, seconds } = gallop(midi, db, gap, 0, length)
    expect(pitches(analyzeAudio(render(plan, seconds, openString(1)), SR))).toEqual(plan.map(() => midi))
  })

  it.each([
    [0.8, -14, true, -9, 0.035, 55, 12],
    [1, -12, false, -9, 0.025, 55, 12],
    [1, -12, true, -9, 0.025, 55, 12],
    [1.2, -10.5, true, -9, 0.025, 67, 12],
    [1, -12, false, -6, 0.035, 67, 11]
  ])('keeps the soft re-bowed notes of a gallop in a room (T60 %f s, wet %f dB, dark %s: %f dB, %f s apart, MIDI %i, room %i)', (t60, wetDb, dark, db, gap, midi, seed) => {
    // Reverb fills the gaps; each soft note still excites all its partials at once.
    const { plan, seconds } = gallop(midi, db, gap, 0, 0.14)
    expect(pitches(analyzeAudio(reverb(render(plan, seconds), t60, wetDb, seed, dark), SR))).toEqual(plan.map(() => midi))
  })

  it.each([
    ['an accent, then a crescendo to −8 dB over 100 ms with ±2 dB loudness vibrato', [[0.2, 0], [0.4, 0], [0.45, -12], [0.8, -12], [0.9, -8], [1.5, -8]], 2, false],
    ['an accent, then a crescendo to −4 dB over 60 ms with ±3 dB loudness vibrato', [[0.2, 0], [0.4, 0], [0.45, -12], [0.8, -12], [0.86, -4], [1.5, -4]], 3, false],
    ['an accent, then a quick swell to −7 dB', [[0.2, 0], [0.4, 0], [0.45, -12], [0.8, -12], [0.88, -7], [1.5, -7]], 0, false],
    ['an accent, then a quick swell to −7 dB, in a room', [[0.2, 0], [0.4, 0], [0.45, -12], [0.8, -12], [0.88, -7], [1.5, -7]], 0, true],
    ['a diminuendo to −14 dB, then a swell to −9 dB, in a room', [[0.2, 0], [0.9, 0], [1.3, -14], [1.4, -9], [1.5, -9]], 0, true]
  ] as [string, [number, number][], number, boolean][])('keeps one bow stroke with %s as one note', (_, points, am, wet) => {
    // No release comes before the rise (the softer stretch holds, or never drops suddenly): it is
    // no soft repeat, however coherently the partials rise.
    const db = (t: number) => {
      let v = points[points.length - 1]![1]
      for (let i = 1; i < points.length; i++) {
        if (t > points[i]![0]) continue
        const [[t0, d0], [t1, d1]] = [points[i - 1]!, points[i]!]
        v = d0 + ((d1 - d0) * (t - t0)) / (t1 - t0)
        break
      }
      return v + (t > 0.45 ? am * Math.sin(2 * Math.PI * 5.8 * t) : 0)
    }
    for (const midi of [55, 62]) for (const vib of [0, 20]) {
      const dry = synth(
        1.9,
        (t) => (t < 0.2 || t > 1.5 ? null : midiToFreq(midi + (vib * Math.sin(2 * Math.PI * 5.8 * t)) / 100)),
        (t) => (t < 0.2 || t > 1.5 ? 0 : 0.25 * 10 ** (db(t) / 20) * Math.min(1, (t - 0.2) / 0.04, (1.5 - t) / 0.03)),
        SAW30
      )
      expect(pitches(analyzeAudio(wet ? reverb(dry, 0.8, -14, 11, true) : dry, SR)), `${midi} ±${vib}`).toEqual([midi])
    }
  })

  it('follows a new note through the reverb of the one before', () => {
    // C4 rings on under G3 (a fourth down), so the mixture repeats at a third of G3's frequency.
    const [c4, g3] = [midiToFreq(60), midiToFreq(55)]
    const before = synth(1.6, (t) => (t >= 0.2 && t < 1.4 ? c4 : null), (t) => (t < 0.2 ? 0 : t < 0.8 ? gate(0.2, 0.8)(t) : 0.24 * Math.exp(-(t - 0.8) / 0.25)))
    const after = synth(1.6, steady(g3, 0.8, 1.4), gate(0.8, 1.4, 0.02))
    const mix = before.map((v, i) => v + after[i]!)
    // Nothing at their common period (19 semitones below G3) in between.
    const { notes } = analyzeAudio(mix, SR)
    expect(notes.map((n) => Math.round(freqToMidi(n.f0!)))).toEqual([60, 55])
    expect(Math.abs(notes[1]!.start - 0.8)).toBeLessThan(0.05)
  })

  it('folds a harmonic sounded at the bow onset into the note', () => {
    const f = midiToFreq(55)
    const { notes } = analyzeAudio(synth(1.4, (t) => (t < 0.2 || t > 1.2 ? null : t < 0.27 ? 3 * f : f), gate(0.2, 1.2)), SR)
    expect(notes).toHaveLength(1)
    expect(cents(f, notes[0]!.f0!)).toBeLessThan(3)
    expect(notes[0]!.start).toBeCloseTo(0.2, 1)
  })

  it('counts a slide between two notes as gliding, and a clean step as not', () => {
    const pitch = (slide: boolean) => (t: number) => {
      if (t < 0.2 || t > 1.6) return null
      if (slide) return midiToFreq(t < 0.8 ? 58 : t < 0.95 ? 58 + ((t - 0.8) / 0.15) * 4 : 62)
      return midiToFreq(t < 0.875 ? 58 : 62)
    }
    const sliding = analyzeAudio(synth(1.8, pitch(true), gate(0.2, 1.6)), SR)
    const stepping = analyzeAudio(synth(1.8, pitch(false), gate(0.2, 1.6)), SR)
    for (const result of [sliding, stepping]) expect(result.notes.map((n) => Math.round(freqToMidi(n.f0!)))).toEqual([58, 62])
    expect(sliding.summary.glideShare).toBeGreaterThan(0.06)
    expect(sliding.summary.glideShare).toBeLessThan(0.16)
    expect(stepping.summary.glideShare).toBeLessThan(0.02)
  })

  it.each([
    [0, 2, 3, 0.45],
    [20, 2, 3, 0.45],
    [30, 2, 3, 0.45],
    [20, 1, 2, 0.35],
    [30, 1, 2, 0.35]
  ])('does not count ±%f cent vibrato next to legato finger changes (steps of %i–%i semitones, %f s notes) as sliding', (vib, small, large, length) => {
    // Ten notes with 30 ms (raised-cosine) finger transitions; the vibrato runs on through them.
    const next = random(small === 2 ? 12 : 14)
    const midis: number[] = [small === 2 ? 58 : 60]
    for (let i = 1; i < 10; i++) midis.push(midis[i - 1]! + (next() < 0.5 ? -1 : 1) * (next() < 0.5 ? small : large))
    const end = 0.2 + 10 * length
    const audio = synth(
      end + 0.2,
      (t) => {
        if (t < 0.2 || t > end) return null
        const i = Math.min(9, Math.floor((t - 0.2) / length))
        const into = t - 0.2 - i * length
        const m = i > 0 && into < 0.03 ? midis[i - 1]! + (midis[i]! - midis[i - 1]!) * (0.5 - 0.5 * Math.cos((Math.PI * into) / 0.03)) : midis[i]!
        return midiToFreq(m + (vib / 100) * Math.sin(2 * Math.PI * 5.5 * t))
      },
      gate(0.2, end, 0.03),
      SAW30
    )
    const { notes, summary } = analyzeAudio(audio, SR)
    expect(notes).toHaveLength(10)
    expect(summary.glideShare).toBeLessThan(0.02)
  })

  it.each(['straight', 'smooth'])('measures %s slides between steady notes', (shape) => {
    // 150 ms slides of 3 semitones (and 4) between 600 ms notes, linear or raised-cosine.
    const targets = [58, 61, 58, 62, 59, 62]
    const end = 0.3 + targets.length * 0.6
    const audio = synth(
      end + 0.3,
      (t) => {
        if (t < 0.3 || t > end) return null
        const i = Math.min(targets.length - 1, Math.floor((t - 0.3) / 0.6))
        const u = (t - 0.3 - i * 0.6) / 0.15
        const way = shape === 'straight' ? u : 0.5 - 0.5 * Math.cos(Math.PI * u)
        return midiToFreq(i > 0 && u < 1 ? targets[i - 1]! + (targets[i]! - targets[i - 1]!) * way : targets[i]!)
      },
      gate(0.3, end, 0.02),
      SAW30
    )
    const { summary } = analyzeAudio(audio, SR)
    expect(summary.slideCount).toBe(5)
    expect(Math.abs(summary.slideMs! - 150)).toBeLessThan(0.15 * 150)
    expect(summary.slideSemitones).toBeCloseTo(3, 0)
  })
})

describe('analyzeAudio: noise, attacks and dynamics', () => {
  it('reads bow noise as a lower HNR', () => {
    const tone = synth(1.4, steady(233.08, 0.2, 1.2), gate(0.2, 1.2), [1, 0.5, 0.3, 0.2, 0.1])
    const hiss = noise(tone.length, 0.3 * rmsOf(tone.subarray(0.3 * SR, 1.1 * SR)))
    const noisy = tone.map((v, i) => v + hiss[i]!)
    const clean = analyzeAudio(tone, SR).summary.hnrDb!
    const rough = analyzeAudio(noisy, SR).summary.hnrDb!
    expect(clean).toBeGreaterThan(25)
    expect(rough).toBeLessThan(clean - 8)
    expect(rough).toBeGreaterThan(5)
  })

  it('follows the noise level well above 30 dB HNR', () => {
    const tone = synth(1.4, steady(233.08, 0.2, 1.2), gate(0.2, 1.2), SAW30)
    const hnrAt = (snrDb: number) => {
      const hiss = noise(tone.length, rmsOf(tone.subarray(0.3 * SR, 1.1 * SR)) * 10 ** (-snrDb / 20), 3)
      return analyzeAudio(tone.map((v, i) => v + hiss[i]!), SR).summary.hnrDb!
    }
    // White noise over 0–22 kHz; HNR counts it up to 5 kHz only, about 6.5 dB less.
    const [h20, h30, h40] = [hnrAt(20), hnrAt(30), hnrAt(40)]
    expect(h30 - h20).toBeGreaterThan(8)
    expect(h40 - h30).toBeGreaterThan(8)
    expect(Math.abs(h40 - 46.5)).toBeLessThan(3)
  })

  it.each([
    [0.02, 0, 30],
    [0.2, 135, 185]
  ])('measures a %f s linear attack ramp', (ramp, min, max) => {
    const audio = synth(1.5, steady(220, 0.3, 1.3), (t) => (t < 0.3 || t > 1.3 ? 0 : 0.3 * Math.min(1, (t - 0.3) / ramp, (1.3 - t) / 0.01)))
    const { notes } = analyzeAudio(audio, SR)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.attackMs!).toBeGreaterThanOrEqual(min)
    expect(notes[0]!.attackMs!).toBeLessThanOrEqual(max)
  })

  it('measures the loudness range between notes', () => {
    const { plan, seconds } = rhythm(80, [1, 1, 2], 4, 9)
    const even = analyzeAudio(render(plan, seconds), SR).summary.dynamicRangeDb!
    const uneven = analyzeAudio(render(plan.map((n, i) => ({ ...n, level: i % 2 ? 0.3 : 0.1 })), seconds), SR).summary.dynamicRangeDb!
    expect(even).toBeLessThan(1)
    expect(Math.abs(uneven - 20 * Math.log10(3))).toBeLessThan(1)
  })

  it.each([
    [60, 1],
    [100, 0.5],
    [140, 0.25]
  ])('reads even playing as even whatever the note length or room (%i BPM, %f beats)', (bpm, beats) => {
    // Attacks, releases and reverb-lengthened note ends are articulation, not dynamics.
    const { plan, seconds } = rhythm(bpm, [beats], Math.round(16 / beats), 3, 0.02)
    const dry = render(plan, seconds)
    expect(analyzeAudio(dry, SR).summary.dynamicRangeDb!).toBeLessThan(1)
    expect(analyzeAudio(reverb(dry, 1.2, -10.5), SR).summary.dynamicRangeDb!).toBeLessThan(COMPARISON_TOLERANCES.dynamicRangeDb)
  })
})

describe('analyzeAudio: tempo, rhythm, key and trills', () => {
  it.each([72, 96, 132])('finds the tempo of a %i BPM melody and a steady pulse', (bpm) => {
    const { plan, seconds } = rhythm(bpm, [1, 0.5, 0.5, 1, 1, 2, 0.5, 0.5, 1, 1], 3, bpm)
    const { summary } = analyzeAudio(render(plan, seconds), SR)
    expect(Math.abs(summary.tempoBpm! / bpm - 1)).toBeLessThan(COMPARISON_TOLERANCES.tempoRelative)
    expect(summary.tempoVariance!).toBeLessThan(0.02)
  })

  it('sees a tempo that drifts as unsteady', () => {
    const next = random(5)
    const plan: Planned[] = []
    for (let t = 0.3; t < 20; ) {
      const length = (60 / (80 + 2 * t)) * (next() < 0.5 ? 0.5 : 1)
      plan.push({ start: t, end: t + length - 0.03, midi: 55 + Math.floor(next() * 12) })
      t += length
    }
    expect(analyzeAudio(render(plan, 20.5), SR).summary.tempoVariance!).toBeGreaterThan(0.05)
  })

  it.each([
    { name: 'a 1:1:2 gallop', beats: [0.5, 0.5, 1], ratio: 2 },
    { name: 'a 2:1 amble', beats: [2 / 3, 1 / 3], ratio: 2 },
    { name: 'a dotted 3:1 rhythm', beats: [0.75, 0.25], ratio: 3 },
    { name: 'even notes', beats: [0.5], ratio: 1 }
  ])('reads $name as a long ÷ short ratio of $ratio', ({ beats, ratio }) => {
    const { plan, seconds } = rhythm(100, beats, Math.round(36 / beats.length), 3, 0.02)
    const { summary } = analyzeAudio(render(plan, seconds), SR)
    expect(Math.abs(summary.ioiRatio! / ratio - 1)).toBeLessThan(COMPARISON_TOLERANCES.ioiRatioRelative)
    expect(summary.ioiRatioPeaks!.length).toBeGreaterThan(0)
  })

  it('builds a pitch-class histogram after removing the tuning offset', () => {
    // F major pentatonic, tuned 20 cents flat.
    const plan = [53, 55, 57, 60, 62, 65, 67, 69].map((midi, i): Planned => ({ start: 0.2 + i * 0.4, end: 0.55 + i * 0.4, midi: midi - 0.2 }))
    const { summary } = analyzeAudio(render(plan, 3.6), SR)
    expect(summary.tuningCents!).toBeCloseTo(-20, -1)
    const classes = summary.pitchClasses!
    expect(classes.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6)
    expect([5, 7, 9, 0, 2].every((pc) => classes[pc]! > 0.1)).toBe(true)
    expect(classes[1]).toBe(0)
  })

  it.each([
    [6.5, 3, 'note to note'],
    [7, 4, 'smooth']
  ] as const)('detects a %f Hz trill of %f semitones (%s)', (rate, semis, kind) => {
    const audio = synth(
      2.6,
      (t) => {
        if (t < 0.3 || t > 2.3) return null
        if (t < 0.8 || t > 1.8) return midiToFreq(62)
        const phase = 2 * Math.PI * rate * (t - 0.8)
        return midiToFreq(62 + (kind === 'smooth' ? (semis / 2) * (1 - Math.cos(phase)) : Math.sin(phase) >= 0 ? 0 : semis))
      },
      gate(0.3, 2.3, 0.02),
      SAW30
    )
    const { summary } = analyzeAudio(audio, SR)
    expect(summary.trillCount).toBe(1)
    expect(Math.abs(summary.trillRateHz! - rate)).toBeLessThan(COMPARISON_TOLERANCES.trillRateHz)
    expect(Math.abs(summary.trillExtentCents! - semis * 100)).toBeLessThan(COMPARISON_TOLERANCES.trillExtentCents)
  })

  it.each([
    [6.5, 4, 0.45, 'soft', false, 55, false],
    [6.5, 3, 0.45, 'step', true, 62, false],
    [7, 4, 0.45, 'smooth', false, 55, false],
    [7.5, 4, 0.4, 'smooth', true, 62, true],
    [8, 5, 0.45, 'smooth', true, 55, true],
    [8, 5, 0.5, 'smooth', false, 69, true]
  ] as const)('times a short trill (%f Hz, %i semitones, %f s, %s, from the upper note: %s, MIDI %i, in a room: %s) within half a hertz', (rate, semis, seconds, shape, fromUpper, base, wet) => {
    // Its swings are timed where they cross the level half-way between the two notes, so an
    // overshoot or a misread frame at one turning point moves nothing.
    const audio = synth(
      2.6 + seconds,
      (t) => {
        if (t < 0.3 || t > 1.8 + seconds) return null
        if (t < 0.8 || t > 0.8 + seconds) return midiToFreq(base)
        const p = 2 * Math.PI * rate * (t - 0.8) + (fromUpper ? Math.PI : 0)
        const s = shape === 'smooth' ? (semis / 2) * (1 - Math.cos(p)) : semis * (0.5 - 0.5 * Math.tanh((shape === 'step' ? 6 : 2.5) * Math.cos(p)))
        return midiToFreq(base + s)
      },
      gate(0.3, 1.8 + seconds, 0.04),
      SAW30
    )
    const { summary } = analyzeAudio(wet ? reverb(audio, 1, -12, 11, true) : audio, SR)
    expect(summary.trillCount).toBeGreaterThanOrEqual(1)
    expect(Math.abs(summary.trillRateHz! - rate)).toBeLessThan(COMPARISON_TOLERANCES.trillRateHz)
  })

  it('times a half-second trill within half a hertz and leaves one under three cycles untimed', () => {
    // A trill between two held notes: its first and last half-cycles are cut by the notes around it.
    const trill = (rate: number, semis: number, seconds: number, base: number) =>
      synth(
        2.6 + seconds,
        (t) => {
          if (t < 0.3 || t > 1.8 + seconds) return null
          if (t < 0.8 || t > 0.8 + seconds) return midiToFreq(base)
          return midiToFreq(base + semis * (0.5 - 0.5 * Math.tanh(6 * Math.cos(2 * Math.PI * rate * (t - 0.8) + Math.PI))))
        },
        gate(0.3, 1.8 + seconds, 0.04),
        SAW30
      )
    for (const base of [57, 62]) {
      const timed = analyzeAudio(trill(6, 4, 0.5, base), SR).summary
      expect(timed.trillCount).toBe(1)
      expect(Math.abs(timed.trillRateHz! - 6)).toBeLessThan(COMPARISON_TOLERANCES.trillRateHz)
    }
    const short = analyzeAudio(trill(6.5, 4, 0.35, 57), SR)
    expect(short.summary).toMatchObject({ trillCount: 1, trillRateHz: null })
    expect(Math.abs(short.summary.trillExtentCents! - 400)).toBeLessThan(COMPARISON_TOLERANCES.trillExtentCents)
    const row = compareFeatures(short, analyzeAudio(trill(6.5, 4, 1, 57), SR)).rows.find((r) => r.feature === 'trillRate')!
    expect(row).toMatchObject({ ok: null, sim: null })
    expect(row.hint).toContain('too short to time')
  })

  it('builds a level-normalised long-term spectrum of the sustained notes', () => {
    const { plan, seconds } = rhythm(80, [1, 1, 2], 4, 9)
    const { summary } = analyzeAudio(render(plan, seconds), SR)
    const bands = summary.ltasDb!
    expect(bands).toHaveLength(LTAS_BANDS_HZ.length)
    const valid = bands.filter((v): v is number => v !== null)
    expect(valid.reduce((s, v) => s + v, 0) / valid.length).toBeCloseTo(0, 6)
    // A sawtooth falls with frequency: the top bands sit below the middle ones.
    expect(bands[bands.length - 1]!).toBeLessThan(bands[20]!)
    // Bands above Nyquist are null.
    const low = analyzeAudio(render(plan, seconds).filter((_, i) => i % 4 === 0), SR / 4).summary.ltasDb!
    expect(low[low.length - 1]).toBeNull()
    expect(low[10]).not.toBeNull()
  })

  it('compares the long-term spectrum of the same timbre in another key', () => {
    // Around the fundamentals the spectrum follows the notes played, so those bands are left out.
    const { plan, seconds } = rhythm(80, [1, 1, 2], 6, 9)
    const [ours, higher] = [plan, plan.map((n) => ({ ...n, midi: n.midi + 2 }))].map((p) => analyzeAudio(render(p, seconds), SR))
    expect(compareFeatures(ours!, higher!).rows.find((r) => r.feature === 'ltas')!.ok).toBe(true)
  })
})

describe('melodyMatch', () => {
  it('matches a transposed melody and names the wrong notes', () => {
    expect(melodyMatch([60, 62, 64, 65, 67], [55, 57, 59, 60, 62])).toEqual({ share: 1, matched: 5, total: 5, differing: [], transposition: 5 })
    expect(melodyMatch([60, 62, 64, 65, 67, 69, 71], [60, 62, 63, 65, 67, 69, 71])).toMatchObject({ matched: 6, differing: [2], transposition: 0 })
  })

  it('treats a re-bowed repeat as the same melody but an extra passing note as a difference', () => {
    expect(melodyMatch([60, 60, 62, 64], [60, 62, 64]).differing).toEqual([])
    expect(melodyMatch([60, 62, 64], [60, 60, 62, 64]).differing).toEqual([])
    expect(melodyMatch([60, 61, 62, 64], [60, 62, 64]).differing).toEqual([1])
  })

  it('finds a missing note and a wrong note that repeats its neighbour', () => {
    const tune = [60, 62, 64, 65, 67, 65, 64, 62, 60, 67, 69, 67, 65, 64, 62, 60, 62, 64, 62, 60]
    expect(melodyMatch([...tune.slice(0, 10), ...tune.slice(11)], tune).differing).toEqual([10])
    expect(melodyMatch([72, 74, 74, 74, 72, 70, 67], [72, 74, 77, 74, 72, 70, 67])).toMatchObject({ differing: [2], transposition: 0 })
    // Ornaments in the original are missing notes (named at the note after them), its intro is not.
    expect(melodyMatch(tune, [55, 57, 59, ...tune.slice(0, 4), 69, 67, 69, ...tune.slice(4)]).differing).toEqual([4])
    // Half the melody in another key: one transposition or the other, never the mean of the two.
    const shifted = melodyMatch(
      tune.map((v, i) => (i >= 10 ? v + 2 : v)),
      tune
    )
    expect([0, 2]).toContain(shifted.transposition)
    expect(shifted.share).toBeLessThan(0.9)
  })

  it('names the bar of a note left out of a rendered melody', () => {
    const tune: [number, number][] = [60, 62, 65, 67, 69, 67, 65, 62, 60, 62, 65, 60].map((m) => [m, 0.4])
    const original = sequence(tune, 0.05)
    const ours = sequence(
      tune.filter((_, i) => i !== 4),
      0.05
    )
    const c = compareFeatures(analyzeAudio(render(ours.plan, ours.seconds), SR), analyzeAudio(render(original.plan, original.seconds), SR), { barOf: (t) => Math.floor(t / 1.8) + 1 })
    expect(c.melody!.differing).toEqual([4])
    expect(c.rows.find((r) => r.feature === 'melody')!.hint).toContain('1 of our 11 notes differs from the original\'s melody in bar 2')
  })

  it('handles empty and one-note melodies', () => {
    expect(melodyMatch([], [60])).toMatchObject({ share: 0, total: 0, transposition: null })
    expect(melodyMatch([60], [55])).toMatchObject({ share: 1, transposition: 5 })
    expect(melodyMatch([60, 62], [])).toMatchObject({ share: 0, differing: [0, 1] })
  })
})

describe('analyzeAudio: performance', () => {
  it('analyses a minute of melody in well under the time a user waits', () => {
    const next = random(3)
    const plan: Planned[] = []
    for (let t = 0.2; t < 59.5; ) {
      const length = 0.15 + next() * 0.5
      plan.push({ start: t, end: t + length, midi: 53 + Math.floor(next() * 17), vib: 25 })
      t += length + (next() < 0.3 ? 0.15 : 0)
    }
    const audio = render(plan, 60)
    const started = performance.now()
    const features = analyzeAudio(audio, SR)
    const comparison = compareFeatures(features, features)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(3000)
    expect(Math.abs(features.notes.length - plan.length) / plan.length).toBeLessThan(0.15)
    expect(features.summary.vibratoRateHz!).toBeCloseTo(5.5, 0)
    expect(comparison.melody!.share).toBe(1)
  }, 30000)
})

describe('compareFeatures', () => {
  const base: AudioFeatures['summary'] = {
    f0MedianHz: 233.08,
    vibratoRateHz: 5.5,
    vibratoExtentCents: 25,
    harmonicsDb: [0, -6, -10, -14, -18, -20, -24, -26, -30, -32],
    centroidHz: 1500,
    hnrDb: 18,
    attackMs: 60,
    noteRate: 3,
    glideShare: 0.1,
    tempoBpm: 100,
    tempoVariance: 0.04,
    tuningCents: 0,
    pitchClasses: [0.3, 0, 0.2, 0, 0, 0.2, 0, 0.2, 0, 0.1, 0, 0],
    vibratoShare: 0.5,
    vibratoOnsetMs: 200,
    amPhase: 0.4,
    trillCount: 1,
    trillRateHz: 6.5,
    trillExtentCents: 350,
    slideCount: 4,
    slideMs: 120,
    slideSemitones: 2,
    ltasDb: LTAS_BANDS_HZ.map((hz) => -6 * Math.log2(hz / 1000)),
    ioiRatioPeaks: [2, 1],
    ioiRatio: 2,
    dynamicRangeDb: 8
  }
  const features = (summary: Partial<AudioFeatures['summary']> = {}, noteCount = 10, midi = (i: number) => 60 + ((i * 2) % 7)): AudioFeatures => ({
    sampleRate: SR,
    duration: 10,
    rmsDb: -20,
    notes: Array.from({ length: noteCount }, (_, i) => ({
      start: i,
      end: i + 0.5,
      f0: midiToFreq(midi(i)),
      vibratoRateHz: null,
      vibratoExtentCents: null,
      harmonicsDb: [],
      centroidHz: null,
      hnrDb: null,
      attackMs: null
    })),
    pitchTrack: [],
    summary: { ...base, ...summary }
  })
  const rowOf = (c: ReturnType<typeof compareFeatures>, feature: string) => c.rows.find((r) => r.feature === feature)!

  it('scores identical recordings as a full match', () => {
    const c = compareFeatures(features(), features())
    expect(c.rows).toHaveLength(24)
    expect(new Set(c.rows.map((r) => r.feature)).size).toBe(24)
    expect(c.score).toBe(1)
    expect(c.rows.every((r) => r.ok === true && r.delta === 0 && r.hint.length > 0 && r.group !== undefined)).toBe(true)
    expect(c).toMatchObject({ referenceKind: 'fiddle', transposition: 0, melody: { share: 1, differingBars: null } })
  })

  it('flags a transposition and a brighter tone with plain hints', () => {
    const c = compareFeatures(features({ f0MedianHz: 233.08 * 2 ** (3 / 12), centroidHz: 1950 }), features())
    const f0 = rowOf(c, 'f0')
    expect(f0.ok).toBe(false)
    expect(f0.unit).toBe('Hz')
    expect(f0.hint).toContain('3.0 semitones higher')
    const centroid = rowOf(c, 'centroid')
    expect(centroid).toMatchObject({ ok: false, sim: 1950, ref: 1500, delta: 450, unit: 'Hz' })
    expect(centroid.tolerance).toBeCloseTo(COMPARISON_TOLERANCES.centroidRelative * 1500)
    expect(centroid.hint).toContain('brighter')
    expect(c.rows.filter((r) => r.ok === false).map((r) => r.feature)).toEqual(['f0', 'centroid'])
    expect(c.score).toBeCloseTo(22 / 24)
  })

  it('applies the tolerances at their edges', () => {
    const ok = (summary: Partial<AudioFeatures['summary']>, feature: string) => rowOf(compareFeatures(features(summary), features()), feature).ok
    expect(ok({ f0MedianHz: 233.08 * 2 ** (45 / 1200) }, 'f0')).toBe(true)
    expect(ok({ f0MedianHz: 233.08 * 2 ** (55 / 1200) }, 'f0')).toBe(false)
    expect(ok({ vibratoRateHz: 6.2 }, 'vibratoRate')).toBe(true)
    expect(ok({ vibratoRateHz: 6.4 }, 'vibratoRate')).toBe(false)
    expect(ok({ vibratoExtentCents: 36 }, 'vibratoExtent')).toBe(true)
    expect(ok({ vibratoExtentCents: 38 }, 'vibratoExtent')).toBe(false)
    expect(ok({ harmonicsDb: [0, -2.5, -10] }, 'h2h1')).toBe(true)
    expect(ok({ harmonicsDb: [0, -1.5, -10] }, 'h2h1')).toBe(false)
    expect(ok({ harmonicsDb: [0, -6, -15] }, 'h3h1')).toBe(false)
    expect(ok({ hnrDb: 14.5 }, 'hnr')).toBe(true)
    expect(ok({ hnrDb: 13.5 }, 'hnr')).toBe(false)
    expect(ok({ attackMs: 83 }, 'attack')).toBe(true)
    expect(ok({ attackMs: 85 }, 'attack')).toBe(false)
    expect(ok({ noteRate: 3.5 }, 'noteRate')).toBe(true)
    expect(ok({ noteRate: 3.7 }, 'noteRate')).toBe(false)
    expect(ok({ glideShare: 0.19 }, 'glideShare')).toBe(true)
    expect(ok({ glideShare: 0.21 }, 'glideShare')).toBe(false)
    expect(ok({ tempoBpm: 104.5 }, 'tempo')).toBe(true)
    expect(ok({ tempoBpm: 105.5 }, 'tempo')).toBe(false)
    expect(ok({ tempoVariance: 0.055 }, 'tempoVariance')).toBe(true)
    expect(ok({ tempoVariance: 0.065 }, 'tempoVariance')).toBe(false)
    expect(ok({ vibratoShare: 0.64 }, 'vibratoShare')).toBe(true)
    expect(ok({ vibratoShare: 0.66 }, 'vibratoShare')).toBe(false)
    expect(ok({ vibratoOnsetMs: 259 }, 'vibratoOnset')).toBe(true)
    expect(ok({ vibratoOnsetMs: 261 }, 'vibratoOnset')).toBe(false)
    expect(ok({ amPhase: 0.9 }, 'amPhase')).toBe(true)
    expect(ok({ amPhase: -0.4 }, 'amPhase')).toBe(false)
    expect(ok({ trillRateHz: 6.9 }, 'trillRate')).toBe(true)
    expect(ok({ trillRateHz: 7.1 }, 'trillRate')).toBe(false)
    expect(ok({ trillExtentCents: 280 }, 'trillExtent')).toBe(true)
    expect(ok({ trillExtentCents: 260 }, 'trillExtent')).toBe(false)
    expect(ok({ slideMs: 155 }, 'slideLength')).toBe(true)
    expect(ok({ slideMs: 157 }, 'slideLength')).toBe(false)
    expect(ok({ slideSemitones: 2.7 }, 'slideInterval')).toBe(false)
    expect(ok({ ioiRatio: 2.15 }, 'ioiRatio')).toBe(true)
    expect(ok({ ioiRatio: 2.25 }, 'ioiRatio')).toBe(false)
    expect(ok({ dynamicRangeDb: 10.9 }, 'dynamicRange')).toBe(true)
    expect(ok({ dynamicRangeDb: 11.1 }, 'dynamicRange')).toBe(false)
    // Long-term spectrum: a 2 dB tilt passes, a 5 dB bump in one band fails on its maximum.
    const tilted = base.ltasDb!.map((v, k) => v! + (2 * (k - 18)) / 18)
    expect(ok({ ltasDb: tilted }, 'ltas')).toBe(true)
    expect(ok({ ltasDb: base.ltasDb!.map((v, k) => v! + (k === 20 ? 7 : 0)) }, 'ltas')).toBe(false)
    expect(rowOf(compareFeatures(features({ glideShare: 0.3 }), features()), 'glideShare')).toMatchObject({ sim: 30, ref: 10, unit: '%' })
    expect(rowOf(compareFeatures(features({ noteRate: 4 }), features()), 'noteRate').hint).toContain('more notes per second')
  })

  it('explains tempo octaves, key differences, AM phase and missing trills', () => {
    expect(rowOf(compareFeatures(features({ tempoBpm: 200 }), features()), 'tempo').hint).toContain('double')
    const transposed = compareFeatures(features({}, 10, (i) => 65 + ((i * 2) % 7)), features())
    expect(transposed.transposition).toBe(5)
    // The key difference is information: reported, not scored.
    expect(rowOf(transposed, 'transposition')).toMatchObject({ ok: null, informational: true, sim: 5, ref: 0, delta: 5, unit: 'st' })
    expect(rowOf(transposed, 'transposition').hint).toContain('5 semitones higher')
    expect(rowOf(transposed, 'melody')).toMatchObject({ ok: true, sim: 100 })
    expect(rowOf(transposed, 'melody').hint).toContain('after transposing by +5 semitones')
    expect(rowOf(compareFeatures(features({ amPhase: -0.5 }), features()), 'amPhase').hint).toContain('against')
    expect(rowOf(compareFeatures(features({ amPhase: 0.05 }), features()), 'amPhase').ok).toBeNull()
    const noTrills = { trillCount: 0, trillRateHz: null, trillExtentCents: null }
    expect(rowOf(compareFeatures(features(noTrills), features(noTrills)), 'trillRate')).toMatchObject({ ok: null, hint: '' })
    expect(rowOf(compareFeatures(features(noTrills), features()), 'trillRate').hint).toContain('The original has trills')
  })

  it('scores a rendering in another key or octave as the same performance', () => {
    // The pitch row compares the tuning once the original is moved into our key.
    const fourth = 233.08 * 2 ** (5 / 12)
    const higher = compareFeatures(features({ f0MedianHz: fourth }, 10, (i) => 65 + ((i * 2) % 7)), features())
    expect(higher.score).toBe(1)
    expect(rowOf(higher, 'f0')).toMatchObject({ ok: true, sim: fourth })
    expect(rowOf(higher, 'f0').ref).toBeCloseTo(fourth, 6)
    expect(rowOf(higher, 'f0').hint).toContain('once the original is transposed by +5 semitones')
    // A tuning difference still shows after transposing.
    const sharp = compareFeatures(features({ f0MedianHz: fourth * 2 ** (60 / 1200) }, 10, (i) => 65 + ((i * 2) % 7)), features())
    expect(rowOf(sharp, 'f0')).toMatchObject({ ok: false })
    expect(rowOf(sharp, 'f0').hint).toContain('60 cents sharper')
    // A fiddle a fourth below: its brightness lies between the original's as recorded and scaled
    // into our key. A fifth or more away the brightness and the bow noise change with the
    // register (low notes with vibrato read a lower HNR): reported, not scored.
    const fifth = compareFeatures(features({ f0MedianHz: 233.08 * 2 ** (7 / 12), centroidHz: 3000 }, 10, (i) => 67 + ((i * 2) % 7)), features())
    expect(fifth.transposition).toBe(7)
    expect(rowOf(fifth, 'centroid')).toMatchObject({ ok: null, informational: true })
    const fourthUp = compareFeatures(features({ f0MedianHz: fourth, centroidHz: 2100 }, 10, (i) => 65 + ((i * 2) % 7)), features())
    expect(rowOf(fourthUp, 'centroid').ok).toBe(true)
    expect(rowOf(fourthUp, 'centroid').hint).toContain('between the original')
    expect(rowOf(compareFeatures(features({ centroidHz: 1900 }), features()), 'centroid').ok).toBe(false)
    for (const octaves of [1, 2]) {
      const low = compareFeatures(features({ centroidHz: 9000, hnrDb: 30, ltasDb: base.ltasDb!.map((v, k) => v! + (k > 20 ? 4 : 0)) }), features({ f0MedianHz: 233.08 / 2 ** octaves }, 10, (i) => 60 - 12 * octaves + ((i * 2) % 7)))
      expect(low.transposition).toBe(12 * octaves)
      expect(low.score).toBe(1)
      for (const feature of ['centroid', 'hnr']) expect(rowOf(low, feature), feature).toMatchObject({ ok: null, informational: true })
      expect(rowOf(low, 'hnr').hint).toContain('not scored')
    }
    // A voice or piano an octave below: no timbre rows, nothing against the score.
    for (const referenceKind of ['voice', 'piano'] as const) {
      const c = compareFeatures(features(), features({ f0MedianHz: 233.08 / 2, centroidHz: 900, ltasDb: base.ltasDb!.map((v, k) => v! + (k > 20 ? 6 : 0)) }, 10, (i) => 48 + ((i * 2) % 7)), { referenceKind })
      expect(c.transposition).toBe(12)
      expect(c.score).toBe(1)
      expect(c.rows.some((r) => r.feature === 'centroid' || r.feature === 'ltas')).toBe(false)
    }
  })

  it('scores a rendered melody a fourth above its original as the same performance', () => {
    const tune = [62, 65, 67, 69, 67, 65, 62, 60, 62, 65, 69, 72, 69, 67, 65, 62, 60, 57, 60, 62]
    const play = (shift: number) => {
      const plan: Planned[] = []
      let t = 0.3
      tune.forEach((midi, i) => {
        const length = 0.3 + (i % 3) * 0.1
        plan.push({ start: t, end: t + length - 0.03, midi: midi + shift, vib: 18 })
        t += length
      })
      return analyzeAudio(render(plan, t + 0.4, openString(1)), SR)
    }
    const ours = play(0)
    for (const referenceKind of ['fiddle', 'voice', 'piano'] as const) {
      const c = compareFeatures(ours, play(-5), { referenceKind })
      expect(c.transposition).toBe(5)
      expect(c.rows.filter((r) => r.ok === false).map((r) => r.feature)).toEqual([])
      expect(c.score).toBe(1)
    }
  })

  it('tells a 1:1:2 gallop from a 2:1 amble, explains tempo readings in threes and names the side a feature is missing on', () => {
    const gallop = compareFeatures(features({ ioiRatioPeaks: [2, 1] }), features({ ioiRatioPeaks: [2] }))
    expect(rowOf(gallop, 'ioiRatio')).toMatchObject({ ok: false, delta: 0 })
    expect(rowOf(gallop, 'ioiRatio').hint).toContain('gallop')
    expect(rowOf(compareFeatures(features({ ioiRatioPeaks: [2, 1] }), features({ ioiRatioPeaks: [1.02, 1.98] })), 'ioiRatio').ok).toBe(true)
    expect(rowOf(compareFeatures(features({ tempoBpm: 133 }), features()), 'tempo').hint).toContain('4/3')
    expect(rowOf(compareFeatures(features({ tempoBpm: 67 }), features()), 'tempo').hint).toContain('2/3')
    expect(rowOf(compareFeatures(features(), features({ ltasDb: [] })), 'ltas').hint).toBe('Could not measure the long-term spectrum (it needs notes of at least 0.4 s) in the original.')
    expect(rowOf(compareFeatures(features({}, 0), features()), 'melody').hint).toBe('Could not measure the melody in our version.')
  })

  it('names the bars where the melody differs', () => {
    const wrong = new Set([3, 11, 12])
    const c = compareFeatures(features({}, 20, (i) => 60 + ((i * 3) % 8) + (wrong.has(i) ? 1 : 0)), features({}, 20, (i) => 60 + ((i * 3) % 8)), { barOf: (t) => Math.floor(t / 4) + 1 })
    expect(c.melody!.differing).toEqual([3, 11, 12])
    expect(c.melody!.differingBars).toEqual([1, 3, 4])
    expect(rowOf(c, 'melody').hint).toContain('bars 1, 3–4')
  })

  it('keeps only the rows that apply to the kind of original', () => {
    const weaker = { hnrDb: 5, centroidHz: 3000 }
    for (const kind of ['voice', 'piano', 'ensemble'] as const) {
      const c = compareFeatures(features(weaker), features(), { referenceKind: kind })
      expect(c.rows.map((r) => r.feature)).toEqual(REFERENCE_ROWS[kind])
      expect(c.score).toBe(1)
      expect(c.referenceKind).toBe(kind)
    }
    expect(compareFeatures(features(weaker), features()).score).toBeLessThan(1)
    expect(REFERENCE_ROWS.ensemble!.some((f) => ['h2h1', 'centroid', 'hnr', 'ltas', 'vibratoRate'].includes(f))).toBe(false)
  })

  it('leaves missing features out of the score', () => {
    const c = compareFeatures(features({ vibratoRateHz: 5.2 }), features({ vibratoRateHz: null, attackMs: null }))
    const rate = rowOf(c, 'vibratoRate')
    expect(rate.ok).toBeNull()
    expect(rate.delta).toBeNull()
    expect(rate.hint).toContain('no regular vibrato')
    expect(rowOf(c, 'attack').ok).toBeNull()
    expect(c.score).toBe(1)
  })

  it('has no score when nothing is comparable', () => {
    const empty: Partial<AudioFeatures['summary']> = {
      f0MedianHz: null,
      vibratoRateHz: null,
      vibratoExtentCents: null,
      harmonicsDb: [],
      centroidHz: null,
      hnrDb: null,
      attackMs: null,
      noteRate: 0,
      glideShare: 0,
      tempoBpm: null,
      tempoVariance: null,
      tuningCents: null,
      pitchClasses: [],
      vibratoShare: null,
      vibratoOnsetMs: null,
      amPhase: null,
      trillCount: 0,
      trillRateHz: null,
      trillExtentCents: null,
      slideCount: 0,
      slideMs: null,
      slideSemitones: null,
      ltasDb: [],
      ioiRatioPeaks: [],
      ioiRatio: null,
      dynamicRangeDb: null
    }
    const c = compareFeatures(features(empty, 0), features(empty, 0))
    expect(c.score).toBeNull()
    expect(c.rows.every((r) => r.ok === null)).toBe(true)
    expect(c.melody).toBeNull()
  })

  it('accepts summaries without the newer fields', () => {
    const { tempoBpm, ltasDb, pitchClasses, ...old } = base
    void [tempoBpm, ltasDb, pitchClasses]
    const c = compareFeatures({ ...features(), summary: old }, { ...features(), summary: old })
    expect(rowOf(c, 'tempo').ok).toBeNull()
    expect(rowOf(c, 'ltas').ok).toBeNull()
    expect(c.score).toBe(1)
  })
})

describe('checks of our own render', () => {
  /** Noise through two-pole resonators of equal peak gain at `centres` (Q 10). */
  function resonances(centres: readonly number[], seconds = 3): Float32Array {
    const white = noise(Math.round(seconds * SR), 0.3, 7)
    const out = new Float32Array(white.length)
    for (const fc of centres) {
      const w = (2 * Math.PI * fc) / SR
      const r = Math.exp(-w / 20)
      const gain = (1 - r) * 2 * Math.sin(w)
      let [y1, y2] = [0, 0]
      for (let i = 0; i < white.length; i++) {
        const y = gain * white[i]! + 2 * r * Math.cos(w) * y1 - r * r * y2
        ;[y2, y1] = [y1, y]
        out[i] = out[i]! + y
      }
    }
    return out
  }

  it("finds Bulanov's soundbox maxima in a matching response and not in white noise", () => {
    const body = bulanovMaxima({ samples: resonances(RENDER_CHECKS.bulanovMaximaHz), sampleRate: SR })
    expect(body).toMatchObject({ found: 8, method: 'spectrum', sampled: 8 })
    expect(body.midSpreadDb!).toBeLessThan(RENDER_CHECKS.bulanovMidSpreadDb)
    expect(body.ok).toBe(true)
    body.maxima.forEach((m) => expect(Math.abs(Math.log2(m.foundHz! / m.targetHz))).toBeLessThan(RENDER_CHECKS.bulanovSearchOctaves))
    const flat = bulanovMaxima({ samples: noise(3 * SR, 0.3, 9), sampleRate: SR })
    expect(flat.found).toBeLessThan(RENDER_CHECKS.bulanovMinFound)
    expect(flat.ok).toBe(false)
    // From analysed features: peaks in the 1/6-octave long-term spectrum.
    const ltasDb = LTAS_BANDS_HZ.map((hz) => (RENDER_CHECKS.bulanovMaximaHz.some((t) => Math.abs(Math.log2(hz / t)) < 1 / 12) ? 3 : 0))
    const fromFeatures = bulanovMaxima({ sampleRate: SR, duration: 1, rmsDb: -20, notes: [], pitchTrack: [], summary: { ...analyzeAudio(new Float32Array(10), SR).summary, ltasDb } })
    expect(fromFeatures.found).toBeGreaterThanOrEqual(RENDER_CHECKS.bulanovMinFound)
  })

  it("reads Bulanov's maxima from a chromatic scale through a soundbox, not from the bare string", () => {
    // A modal body (the wooden top's principal modes: Hz, Q, peak dB) under a sawtooth scale F3–F5.
    const modes = [
      [170, 8, -12],
      [280, 5, -1],
      [440, 5, 0],
      [780, 5, -1],
      [1200, 10, -3],
      [1800, 10, -1],
      [2300, 10, -3],
      [3500, 10, -6]
    ]
    const body = new Float64Array(Math.round(0.3 * SR))
    modes.forEach(([f, q, db], i) => {
      const decay = Math.exp((-Math.PI * f!) / (q! * SR))
      for (let n = 0, env = (2 * 10 ** (db! / 20) * 2 * Math.PI * f!) / q! / SR; n < body.length && env > 1e-7; n++, env *= decay) {
        body[n] = body[n]! + env * Math.sin((2 * Math.PI * f! * n) / SR + (i % 2) * Math.PI)
      }
    })
    const scale = Array.from({ length: 25 }, (_, i): Planned => ({ start: 0.2 + i * 0.35, end: 0.5 + i * 0.35, midi: 53 + i }))
    const bare = render(scale, 9.2, SAW.slice(0, 80))
    const size = nextPowerOfTwo(bare.length + body.length)
    const [xr, xi, hr, hi] = [new Float64Array(size), new Float64Array(size), new Float64Array(size), new Float64Array(size)]
    xr.set(bare)
    hr.set(body)
    fft(xr, xi)
    fft(hr, hi)
    for (let k = 0; k < size; k++) [xr[k], xi[k]] = [xr[k]! * hr[k]! - xi[k]! * hi[k]!, -(xr[k]! * hi[k]! + xi[k]! * hr[k]!)]
    fft(xr, xi)
    const played = Float32Array.from({ length: bare.length }, (_, i) => xr[i]! / size)
    const withBody = bulanovMaxima({ samples: played, sampleRate: SR })
    expect(withBody).toMatchObject({ method: 'harmonics', ok: true, measurable: true })
    expect(withBody.found).toBeGreaterThanOrEqual(RENDER_CHECKS.bulanovMinFound)
    expect(withBody.midSpreadDb!).toBeLessThan(2)
    expect(withBody.sampled).toBeGreaterThanOrEqual(7)
    expect(bulanovMaxima({ samples: bare, sampleRate: SR })).toMatchObject({ method: 'harmonics', found: 0, ok: false, measurable: true })
    // The body's impulse response alone is read from its spectrum.
    const impulse = new Float32Array(SR)
    impulse.set(body)
    expect(bulanovMaxima({ samples: impulse, sampleRate: SR })).toMatchObject({ method: 'spectrum', ok: true, measurable: true })
    // A pentatonic melody samples the response too sparsely below 1 kHz to judge the body at all.
    const next = random(5)
    const tune: Planned[] = []
    for (let i = 0, t = 0.2; i < 40; i++) {
      const length = 0.3 + next() * 0.3
      tune.push({ start: t, end: t + length, midi: [53, 55, 58, 60, 62, 65, 67, 70, 72, 74, 77][Math.floor(next() * 11)]!, vib: 20 })
      t += length + 0.05
    }
    const melodic = render(tune, tune[tune.length - 1]!.end + 0.3, openString(1))
    const n = nextPowerOfTwo(melodic.length + body.length)
    const [yr, yi, br, bi] = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)]
    yr.set(melodic)
    br.set(body)
    fft(yr, yi)
    fft(br, bi)
    for (let k = 0; k < n; k++) [yr[k], yi[k]] = [yr[k]! * br[k]! - yi[k]! * bi[k]!, -(yr[k]! * bi[k]! + yi[k]! * br[k]!)]
    fft(yr, yi)
    const through = (dry: Float32Array) => {
      const size = nextPowerOfTwo(dry.length + body.length)
      const [ar, ai, cr, ci] = [new Float64Array(size), new Float64Array(size), new Float64Array(size), new Float64Array(size)]
      ar.set(dry)
      cr.set(body)
      fft(ar, ai)
      fft(cr, ci)
      for (let k = 0; k < size; k++) [ar[k], ai[k]] = [ar[k]! * cr[k]! - ai[k]! * ci[k]!, -(ar[k]! * ci[k]! + ai[k]! * cr[k]!)]
      fft(ar, ai)
      return Float32Array.from({ length: dry.length }, (_, i) => ar[i]! / size)
    }
    const pentatonic = bulanovMaxima({ samples: Float32Array.from({ length: melodic.length }, (_, i) => yr[i]! / n), sampleRate: SR })
    expect(pentatonic).toMatchObject({ method: 'harmonics', measurable: false, ok: null })
    expect(pentatonic.sampled).toBeLessThan(RENDER_CHECKS.bulanovMinFound)
    // A melody over F3–F5 leaving out C4–E4 has no harmonics on one side of 280 Hz: the maximum
    // there cannot be seen, so the render cannot be judged (it was a false fail).
    const gappy = random(8)
    const wide: Planned[] = []
    const skipping = Array.from({ length: 25 }, (_, i) => 53 + i).filter((m) => m < 60 || m > 64)
    for (let i = 0, t = 0.2; i < 40; i++) {
      const length = 0.3 + gappy() * 0.3
      wide.push({ start: t, end: t + length, midi: skipping[Math.floor(gappy() * skipping.length)]!, vib: 20 })
      t += length + 0.05
    }
    const unseen = bulanovMaxima({ samples: through(render(wide, wide[wide.length - 1]!.end + 0.3, openString(1))), sampleRate: SR })
    expect(unseen.maxima[1]!.foundHz).toBeNull()
    expect(unseen).toMatchObject({ method: 'harmonics', measurable: false, ok: null })
  })

  it('measures the open male string fundamental against its strongest overtone', () => {
    const open = analyzeAudio(synth(1.4, steady(174.61, 0.2, 1.2), gate(0.2, 1.2), [0.8, 1, 0.7, 0.5, 0.3]), SR)
    const balance = openStringBalance(open)
    expect(balance.notes).toBe(1)
    expect(balance.balanceDb!).toBeCloseTo(20 * Math.log10(0.8), 0)
    expect(balance.ok).toBe(true)
    expect(openStringBalance(analyzeAudio(synth(1.4, steady(174.61, 0.2, 1.2), gate(0.2, 1.2)), SR)).ok).toBe(false)
    expect(openStringBalance(analyzeAudio(synth(1.4, steady(233.08, 0.2, 1.2), gate(0.2, 1.2)), SR))).toEqual({ notes: 0, balanceDb: null, ok: null })
  })
})

describe('mixToMono', () => {
  it('averages channels and zero-pads shorter ones', () => {
    expect(Array.from(mixToMono([new Float32Array([1, 0.5, 0.25]), new Float32Array([0, 0.5])]))).toEqual([0.5, 0.5, 0.125])
    const mono = new Float32Array([0.1, 0.2])
    const copy = mixToMono([mono])
    expect(copy).not.toBe(mono)
    expect(Array.from(copy)).toEqual(Array.from(mono))
    expect(mixToMono([])).toHaveLength(0)
  })
})
