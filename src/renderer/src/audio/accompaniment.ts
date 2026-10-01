import * as Tone from 'tone'
import { Pluck } from './strikes'

/**
 * Tovshuur: the two/three-string Oirat lute. Strummed, so each stroke sounds the note and then,
 * a few milliseconds later, the fifth on the neighbouring string.
 */
export class Tovshuur {
  private readonly body: Tone.Filter[]
  private readonly input: Tone.Gain
  private readonly plucks: Pluck[]
  private next = 0

  constructor(output: Tone.InputNode) {
    this.input = new Tone.Gain(1)
    this.body = [new Tone.Filter({ type: 'peaking', frequency: 240, Q: 1.2, gain: 5 }), new Tone.Filter({ type: 'peaking', frequency: 950, Q: 1.5, gain: 3 })]
    this.input.chain(...this.body, output)
    this.plucks = Array.from({ length: 4 }, () => new Pluck(this.input, { decay: 1.2, brightness: 2.6, click: 0.5 }))
  }

  strum(freq: number, time: number, velocity: number): void {
    const a = this.plucks[this.next++ % this.plucks.length]!
    const b = this.plucks[this.next++ % this.plucks.length]!
    a.trigger(freq, time, velocity)
    b.trigger(freq * 1.5, time + 0.012, velocity * 0.55)
  }

  dispose(): void {
    for (const p of this.plucks) p.dispose()
    for (const f of this.body) f.dispose()
    this.input.dispose()
  }
}

// Vowel "o" formants of a low male voice.
const FORMANTS: [number, number, number][] = [
  [450, 6, 1],
  [800, 7, 0.6],
  [2830, 9, 0.25]
]

/**
 * Khöömii (overtone singing): a pressed, buzzy drone through vowel formants, with a very narrow
 * band-pass that isolates single harmonics of the drone for the whistled melody (isgeree).
 */
export class Khoomii {
  private readonly source: Tone.Oscillator
  private readonly vib: Tone.LFO
  private readonly env: Tone.Gain
  private readonly chest: Tone.Filter
  private readonly chestGain: Tone.Gain
  private readonly formants: Tone.Filter[]
  private readonly formantGains: Tone.Gain[]
  private readonly whistle: Tone.Filter
  private readonly whistleGain: Tone.Gain
  private readonly out: Tone.Gain
  private f0 = 116.5

  constructor(output: Tone.InputNode) {
    this.out = new Tone.Gain(0.55).connect(output)
    this.env = new Tone.Gain(0).connect(this.out)
    this.source = new Tone.Oscillator({ type: 'sawtooth', frequency: this.f0 })
    this.vib = new Tone.LFO({ frequency: 4.6, min: -6, max: 6 })
    this.vib.connect(this.source.detune)

    this.chest = new Tone.Filter({ type: 'lowpass', frequency: 320, Q: 0.7 })
    this.chestGain = new Tone.Gain(0.5)
    this.source.chain(this.chest, this.chestGain, this.env)

    this.formants = FORMANTS.map(([f, q]) => new Tone.Filter({ type: 'bandpass', frequency: f, Q: q }))
    this.formantGains = FORMANTS.map(([, , g]) => new Tone.Gain(g * 1.6))
    this.formants.forEach((f, i) => this.source.chain(f, this.formantGains[i]!, this.env))

    this.whistle = new Tone.Filter({ type: 'bandpass', frequency: this.f0 * 8, Q: 32 })
    this.whistleGain = new Tone.Gain(0)
    this.source.chain(this.whistle, this.whistleGain, this.env)

    this.source.start()
    this.vib.start()
  }

  drone(freq: number, start: number, duration: number): void {
    this.f0 = freq
    this.source.frequency.setValueAtTime(freq, start)
    const env = this.env.gain
    env.setValueAtTime(0, start)
    env.linearRampToValueAtTime(0.9, start + 1.2)
    // The singer breathes every few bars.
    const breathEvery = 9
    for (let t = start + breathEvery; t < start + duration - 2; t += breathEvery) {
      env.linearRampToValueAtTime(0.9, t - 0.35)
      env.linearRampToValueAtTime(0.05, t - 0.1)
      env.linearRampToValueAtTime(0.9, t + 0.5)
    }
    env.setValueAtTime(0.9, start + duration - 1.2)
    env.linearRampToValueAtTime(0, start + duration)
  }

  overtone(partial: number, start: number, duration: number): void {
    // Glide into the harmonic (the tongue moves), hold, then fade the whistle.
    this.whistle.frequency.setTargetAtTime(this.f0 * partial, start, 0.07)
    this.whistleGain.gain.setTargetAtTime(3.2, start, 0.12)
    this.whistleGain.gain.setTargetAtTime(0.6, start + duration * 0.9, 0.08)
  }

  dispose(): void {
    for (const n of [this.source, this.vib, this.env, this.chest, this.chestGain, ...this.formants, ...this.formantGains, this.whistle, this.whistleGain, this.out]) n.dispose()
  }
}
