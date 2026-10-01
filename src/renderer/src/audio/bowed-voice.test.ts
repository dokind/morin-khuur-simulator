import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// BowedVoice's scheduled strokes rendered through the real bowed-string worklet in Node: Tone is
// replaced by automation-only stand-ins with Web Audio timing semantics, and the worklet is driven
// block by block with the voice's scheduled bow speed, pitch, force, contact point and roughness.
// Strokes land at many absolute times, so every note meets the string in a different hair-noise
// state and render-quantum phase. (The song-by-song census of every style lives outside the repo;
// this keeps a small one.)

vi.mock('tone', () => {
  type Kind = 'set' | 'linear' | 'exp' | 'target'
  interface Event {
    kind: Kind
    time: number
    value: number
    tc: number
  }
  /** An AudioParam's automation timeline, evaluated as Web Audio does. */
  class Param {
    events: Event[] = []
    constructor(private initial = 0) {}
    private add(e: Event) {
      let i = this.events.length
      while (i > 0 && this.events[i - 1]!.time > e.time) i--
      this.events.splice(i, 0, e)
      return this
    }
    setValueAtTime(value: number, time: number) {
      return this.add({ kind: 'set', time, value, tc: 0 })
    }
    linearRampToValueAtTime(value: number, time: number) {
      return this.add({ kind: 'linear', time, value, tc: 0 })
    }
    exponentialRampToValueAtTime(value: number, time: number) {
      return this.add({ kind: 'exp', time, value, tc: 0 })
    }
    setTargetAtTime(value: number, time: number, tc: number) {
      return this.add({ kind: 'target', time, value, tc })
    }
    cancelScheduledValues(time: number) {
      this.events = this.events.filter((e) => e.time < time)
      return this
    }
    cancelAndHoldAtTime(time: number) {
      const value = this.getValueAtTime(time)
      this.cancelScheduledValues(time)
      return this.setValueAtTime(value, time)
    }
    getValueAtTime(time: number): number {
      let value = this.initial
      let from = 0
      let target: Event | null = null
      for (const e of this.events) {
        if (e.kind === 'linear' || e.kind === 'exp') {
          // A ramp runs from the previous event (a pending target is replaced by it).
          const x = e.time > from ? Math.min(1, (time - from) / (e.time - from)) : 1
          if (time < e.time) return e.kind === 'linear' ? value + (e.value - value) * x : value > 0 && e.value > 0 ? value * (e.value / value) ** x : value
          target = null
          value = e.value
          from = e.time
          continue
        }
        if (e.time > time) break
        if (target) value = target.value + (value - target.value) * Math.exp(-(e.time - target.time) / target.tc)
        target = e.kind === 'target' ? e : null
        if (e.kind === 'set') value = e.value
        from = e.time
      }
      return target ? target.value + (value - target.value) * Math.exp(-(time - target.time) / target.tc) : value
    }
    get value() {
      return this.getValueAtTime(0)
    }
    set value(v: number) {
      this.initial = v
    }
  }
  const context = {
    sampleRate: 44100,
    createAudioWorkletNode: () => ({
      parameters: new Map(['frequency', 'detune', 'velocity', 'force', 'beta', 'roughness', 'damping'].map((n) => [n, new Param()])),
      port: { postMessage() {} },
      disconnect() {}
    })
  }
  class Node {
    context = context
    connect() {
      return this
    }
    chain() {
      return this
    }
    disconnect() {
      return this
    }
    start() {
      return this
    }
    dispose() {
      return this
    }
  }
  class Signal extends Param {
    context = context
    constructor({ value = 0 }: { value?: number } = {}) {
      super(value)
    }
    connect() {
      return this
    }
    dispose() {
      return this
    }
  }
  class Gain extends Node {
    gain: Param
    constructor(value = 1) {
      super()
      this.gain = new Param(value)
    }
  }
  class LFO extends Node {
    frequency: Param
    constructor({ frequency = 1 }: { frequency?: number } = {}) {
      super()
      this.frequency = new Param(frequency)
    }
  }
  class Filter extends Node {
    frequency = new Param(1000)
    gain = new Param(0)
  }
  class Oscillator extends Node {
    frequency = new Param(440)
    detune = new Param(0)
  }
  class CrossFade extends Node {
    a = new Gain()
    b = new Gain()
    fade = new Param(0)
  }
  class Meter extends Node {
    getValue() {
      return 0
    }
  }
  return { Signal, Gain, LFO, Filter, Oscillator, CrossFade, Meter, Noise: Node, Multiply: Node, connect() {} }
})
vi.mock('./dsp', () => ({ BOWED_STRING: 'mkhuur-bowed-string', isDspReady: () => true, loadDsp: async () => {} }))

const SR = 44100
const BLOCK = 128

interface Automation {
  getValueAtTime(time: number): number
}
interface Voice {
  openFreq: number
  stroke(o: Record<string, unknown>): void
  bowLive(input: { speed: number; pressure: number; position: number }, direction: 'tatakh' | 'tülekhe', time: number): void
  bowChange(time: number): void
  setPitch(freq: number, time: number, glideSeconds?: number): void
  release(time: number, timeConstant?: number): void
  // Private fields of BowedVoice, read to drive the worklet.
  freq: Automation
  bow: Automation
  force: Automation
  beta: Automation
  rough: Automation
  vibDepth: { gain: Automation }
  vibLfo: { frequency: Automation }
}
type Processor = { process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean; seed: number }

function loadProcessor(): new () => Processor {
  const source = readFileSync(join(__dirname, 'worklets/bowed-string.worklet.js'), 'utf8')
  let registered: (new () => Processor) | null = null
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(class {}, (_name: string, cls: new () => Processor) => (registered = cls), SR)
  return registered!
}
const Processor = loadProcessor()

// Imported through a variable so that the Node type-check (no DOM library) does not follow it
// into the Web Audio types BowedVoice uses; vitest resolves it, with Tone and the DSP loader mocked.
const VOICE_MODULE = './bowed-voice'
const { BowedVoice } = (await import(/* @vite-ignore */ VOICE_MODULE)) as { BowedVoice: new (output: unknown, o: { hair: 'male' | 'female' }) => Voice }

/** The voice's scheduled automation, rendered through the worklet; also the phase of the pitch it asks for. */
function renderVoice(voice: Voice, seconds: number, seed: number): { out: Float32Array; phase: Float64Array } {
  const n = Math.floor((seconds * SR) / BLOCK) * BLOCK
  const p = new Processor()
  p.seed = seed
  const out = new Float32Array(n)
  const phase = new Float64Array(n)
  const block = new Float32Array(BLOCK)
  let lfo = 0
  let ph = 0
  for (let i = 0; i < n; i += BLOCK) {
    const params: Record<string, Float32Array> = {
      frequency: new Float32Array(BLOCK),
      detune: new Float32Array(BLOCK),
      velocity: new Float32Array(BLOCK),
      force: new Float32Array(BLOCK),
      beta: new Float32Array(BLOCK),
      roughness: new Float32Array([voice.rough.getValueAtTime(i / SR)]),
      damping: new Float32Array([voice.openFreq < 200 ? 0.93 : 0.945])
    }
    for (let k = 0; k < BLOCK; k++) {
      const t = (i + k) / SR
      const f = voice.freq.getValueAtTime(t)
      const detune = voice.vibDepth.gain.getValueAtTime(t) * Math.sin(lfo)
      lfo += (2 * Math.PI * voice.vibLfo.frequency.getValueAtTime(t)) / SR
      params.frequency![k] = f
      params.detune![k] = detune
      params.velocity![k] = Math.min(1, Math.max(0, voice.bow.getValueAtTime(t)))
      params.force![k] = Math.min(1, Math.max(0, voice.force.getValueAtTime(t)))
      params.beta![k] = voice.beta.getValueAtTime(t)
      phase[i + k] = ph
      ph += (2 * Math.PI * f * 2 ** (detune / 1200)) / SR
    }
    p.process([], [[block]], params)
    out.set(block, i)
  }
  return { out, phase }
}

/** Harmonic `n` over the fundamental (dB) in a Hann window from `a` to `b` (samples), on the scheduled phase. */
function harmonicDb(x: Float32Array, phase: Float64Array, a: number, b: number, n: number): number {
  const amp = (k: number) => {
    let re = 0
    let im = 0
    for (let i = a; i < b; i++) {
      const w = (0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (b - a - 1))) * x[i]!
      re += w * Math.cos(k * phase[i]!)
      im -= w * Math.sin(k * phase[i]!)
    }
    return Math.hypot(re, im)
  }
  return 20 * Math.log10(amp(n) / amp(1))
}

interface Note {
  at: number
  d: number
  freq: number
  string?: 'male' | 'female'
  v?: number
  profile?: 'abrupt' | 'accent-release'
  detached?: boolean
  shurankhai?: boolean
  slur?: boolean
}

// A phrase that meets each case the census found: landings on a quiet string, bow changes with the
// finger moving up and down, abrupt strokes re-landing a ringing string, detached (gallop) strokes,
// a leap wider than a fifth, a slur, accent-release strokes and a shurankhai landing on the far
// tasto point after an ordinary stroke.
const PHRASE: Note[] = [
  { at: 0, d: 0.6, freq: 174.61 },
  { at: 0.6, d: 0.45, freq: 196 },
  { at: 1.05, d: 0.45, freq: 174.61 },
  { at: 1.5, d: 0.3, freq: 220, profile: 'accent-release' },
  { at: 1.8, d: 0.3, freq: 196, profile: 'accent-release' },
  { at: 2.1, d: 0.25, freq: 174.61, profile: 'abrupt' },
  { at: 2.35, d: 0.25, freq: 196, profile: 'abrupt' },
  { at: 2.6, d: 0.25, freq: 174.61, profile: 'abrupt' },
  { at: 2.85, d: 0.23, freq: 174.61, detached: true },
  { at: 3.08, d: 0.23, freq: 174.61, detached: true },
  { at: 3.31, d: 0.5, freq: 261.63 },
  { at: 3.81, d: 0.5, freq: 293.66, slur: true },
  { at: 4.31, d: 0.6, freq: 174.61 },
  { at: 0.3, d: 0.9, freq: 293.66, string: 'female', v: 0.7 },
  { at: 1.2, d: 0.9, freq: 233.08, string: 'female', v: 0.7 },
  { at: 2.6, d: 1.4, freq: 233.08, string: 'female', v: 0.8, shurankhai: true },
  { at: 4.0, d: 0.9, freq: 349.23, string: 'female', v: 0.6 }
]

describe('BowedVoice strokes through the bowed-string worklet', () => {
  it('never leaves a note in the octave, and attacks stay clean, at any landing time', () => {
    let seed = 0x5eed
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
    for (let run = 0; run < 6; run++) {
      const offset = 0.05 + random() * 2
      for (const string of ['male', 'female'] as const) {
        const voice = new BowedVoice({}, { hair: string })
        voice.openFreq = string === 'male' ? 174.61 : 233.08
        const notes = PHRASE.filter((n) => (n.string ?? 'male') === string)
        notes.forEach((n, i) =>
          voice.stroke({
            time: offset + n.at,
            duration: n.d,
            freq: n.freq,
            velocity: n.v ?? 0.8,
            direction: i % 2 ? 'tülekhe' : 'tatakh',
            vibrato: 0,
            bowProfile: n.profile,
            detached: n.detached,
            shurankhai: n.shurankhai,
            slur: n.slur
          })
        )
        const end = offset + Math.max(...notes.map((n) => n.at + n.d)) + 0.1
        const { out, phase } = renderVoice(voice, end, Math.floor(random() * 2 ** 32) >>> 0 || 1)
        for (const n of notes) {
          const sounding = n.d * (n.detached ? 0.7 : n.profile === 'abrupt' ? 0.8 : 1) - 0.01
          let octave = 0
          let late = 0
          for (let t = 0; t + 0.04 <= sounding; t += 0.01) {
            const a = Math.floor((offset + n.at + t) * SR)
            const b = a + Math.floor(0.04 * SR)
            const db2 = harmonicDb(out, phase, a, b, 2)
            if (db2 > 3) octave += 0.01
            if (db2 > 3 && t >= 0.06) late += 0.01
            if (t >= 0.1) expect(harmonicDb(out, phase, a, b, 3), `${string} ${n.freq} Hz at ${n.at} s: twelfth at ${t.toFixed(2)} s`).toBeLessThan(3)
          }
          const at = `${string} ${n.freq} Hz at ${n.at} s, offset ${offset.toFixed(3)}`
          // An attack transient of at most ~30 ms (two overlapping 40 ms windows), and nothing after.
          expect(octave, at).toBeLessThanOrEqual(0.02 + 1e-9)
          expect(late, at).toBe(0)
        }
      }
    }
  })
})

/**
 * Seconds of 40 ms windows (10 ms apart) over `length` from `from` (seconds) in which the octave
 * rises more than 3 dB above the fundamental, and of those starting 60 ms or more after `from`.
 */
function octaveAfter(x: Float32Array, phase: Float64Array, from: number, length: number): { octave: number; late: number } {
  let octave = 0
  let late = 0
  for (let t = 0; t + 0.04 <= length; t += 0.01) {
    const a = Math.floor((from + t) * SR)
    if (harmonicDb(x, phase, a, a + Math.floor(0.04 * SR), 2) <= 3) continue
    octave += 0.01
    if (t >= 0.06) late += 0.01
  }
  return { octave, late }
}

const rmsDb = (x: Float32Array, from: number, to: number) => {
  const w = x.subarray(Math.floor(from * SR), Math.floor(to * SR))
  return 10 * Math.log10(w.reduce((a, b) => a + b * b, 0) / w.length)
}

// Live bowing as LivePerformer drives it: the keyboard's auto-bow, and the bow pad re-sending its
// speed with every frame.
describe('BowedVoice live bowing through the bowed-string worklet', () => {
  const pad = (speed: number) => ({ speed, pressure: 0.55, position: 0 })

  // Keyboard notes played detached. At the key-up the finger lifts (the pitch glides back to the
  // open string) and the bow is released with a 70 ms time constant; the next key stops the string,
  // turns the bow and draws it again. The released bow still creeps on the string at 3–10% of its
  // speed 0.1–0.3 s after the key-up, and re-bowed from there the string started in its octave on
  // up to 22 of 24 notes (up to 110 ms, and one female note for 0.49 s of its 0.59). A stroke drawn
  // after a release now lands from zero, as a scheduled one does.
  it('re-bows detached keyboard notes in Helmholtz motion after any gap', () => {
    let seed = 0x1ce5eed
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
    for (const string of ['male', 'female'] as const)
      for (const gap of [0.03, 0.1, 0.15, 0.2, 0.25, 0.35])
        for (let k = 0; k < 2; k++) {
          const open = string === 'male' ? 174.61 : 233.08
          const voice = new BowedVoice({}, { hair: string })
          voice.openFreq = open
          const speed = 0.35 + 0.55 * (0.3 + 0.7 * random())
          const from = open * 2 ** (Math.floor(random() * 6) / 12)
          const to = open * 2 ** (Math.floor(random() * 8) / 12)
          const pull = random() < 0.5
          const t0 = 0.05 + random()
          // Key down: the finger stops the string, the bow turns (if still moving) and is drawn.
          voice.setPitch(from, t0)
          voice.bowChange(t0)
          voice.bowLive(pad(speed), pull ? 'tatakh' : 'tülekhe', t0)
          // Key up: the finger lifts while the bow is released.
          const t1 = t0 + 0.3 + 0.4 * random()
          voice.setPitch(open, t1, 0.02)
          voice.release(t1, 0.07)
          const t2 = t1 + gap
          voice.setPitch(to, t2)
          voice.bowChange(t2)
          voice.bowLive(pad(speed), pull ? 'tülekhe' : 'tatakh', t2)
          voice.setPitch(open, t2 + 0.6, 0.02)
          voice.release(t2 + 0.6, 0.07)
          const { out, phase } = renderVoice(voice, t2 + 0.65, Math.floor(random() * 2 ** 32) >>> 0 || 1)
          const { octave, late } = octaveAfter(out, phase, t2, 0.59)
          const at = `${string} ${from.toFixed(1)} → ${to.toFixed(1)} Hz after ${gap} s`
          expect(octave, at).toBeLessThanOrEqual(0.02 + 1e-9)
          expect(late, at).toBe(0)
        }
  })

  // The bow pad: strokes drawn up from rest over 30–200 ms, and drawn on fast from a crawl (the
  // pointer barely moving, 2% of full speed) within 60 ms, where the hair digs in and the stroke
  // lands again (CRAWL). Drawn on from the crawl's tiny motion instead, the string started in its
  // octave for 30–95 ms on a third of the male strokes.
  it('lands bow-pad strokes drawn up from rest or from a crawl in Helmholtz motion', () => {
    let seed = 0x9ad
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
    for (const string of ['male', 'female'] as const)
      for (const [crawl, ramp, top] of [
        [0, 0.03, 0.9],
        [0, 0.08, 0.9],
        [0, 0.2, 0.3],
        [0.02, 0.03, 0.6],
        [0.02, 0.06, 0.9],
        [0.05, 0.03, 0.8]
      ] as const) {
        const open = string === 'male' ? 174.61 : 233.08
        const voice = new BowedVoice({}, { hair: string })
        voice.openFreq = open
        voice.setPitch(open * 2 ** (Math.floor(random() * 7) / 12), 0)
        const frame = random() < 0.5 ? 1 / 60 : 1 / 120
        let t = 0.05 + random()
        // Pointer down (no speed), or a crawl, then drawn up to speed.
        for (const until = t + (crawl ? 0.4 : frame); t < until; t += frame) voice.bowLive(pad(crawl), 'tatakh', t)
        const from = t
        for (; t < from + ramp + 0.5; t += frame) voice.bowLive(pad(Math.min(top, crawl + ((top - crawl) * (t - from + frame)) / ramp)), 'tatakh', t)
        const { out, phase } = renderVoice(voice, t + 0.05, Math.floor(random() * 2 ** 32) >>> 0 || 1)
        const { octave, late } = octaveAfter(out, phase, from, t - from)
        const at = `${string} from ${crawl} to ${top} over ${ramp} s`
        expect(octave, at).toBeLessThanOrEqual(0.02 + 1e-9)
        expect(late, at).toBe(0)
      }
  })

  // A slow live bow sustains the note, quieter in proportion to its speed; and the auto-bow's
  // run-out (a bow change on its own, every 3.2 s of a held key) turns the bow and draws it on at
  // its speed, where it used to stay at the turn's half speed.
  it('sustains a slow bow and keeps the drawn speed through a bow change', () => {
    const bowed = (speed: number) => {
      const voice = new BowedVoice({}, { hair: 'male' })
      voice.openFreq = 174.61
      voice.setPitch(196, 0)
      voice.bowLive(pad(speed), 'tatakh', 0.1)
      return renderVoice(voice, 1.3, 0x2545f491)
    }
    const slow = bowed(0.03)
    expect(rmsDb(slow.out, 0.6, 1.25) - rmsDb(bowed(0.3).out, 0.6, 1.25)).toBeCloseTo(-20, 0)
    expect(harmonicDb(slow.out, slow.phase, Math.floor(0.6 * SR), Math.floor(1.25 * SR), 2)).toBeLessThan(-3)

    const voice = new BowedVoice({}, { hair: 'female' })
    voice.openFreq = 233.08
    voice.bowLive(pad(0.7), 'tatakh', 0.1)
    voice.bowChange(1)
    expect(voice.bow.getValueAtTime(1.015)).toBeLessThan(0.6 * 0.7)
    expect(voice.bow.getValueAtTime(1.2)).toBeCloseTo(0.7, 2)
  })
})
