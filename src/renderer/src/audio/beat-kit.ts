import * as Tone from 'tone'
import { DEFAULT_TUNING, type StringId, type Tuning } from '@renderer/core/instrument'
import { PAD_IDS, type PadId } from '@renderer/core/kit'
import { midiToFreq } from '@renderer/core/pitch'
import type { BowDirection } from '@renderer/core/techniques'
import { Soundbox } from './body'
import { BowedVoice } from './bowed-voice'
import { whinnyGesture } from './gestures'
import { BodyKnock, ColLegno, Pluck } from './strikes'

/** The four per-pad knobs from the Beat Maker mockup. */
export interface PadParams {
  /** dB */
  level: number
  /** semitones */
  tune: number
  /** low-pass cutoff, Hz */
  freq: number
  /** low-pass resonance (Q) */
  reso: number
}

export const DEFAULT_PAD_PARAMS: PadParams = { level: 0, tune: 0, freq: 16000, reso: 0.7 }

interface PadVoice {
  /** `ratio` is the frequency multiplier from the Tune knob. */
  trigger(time: number, velocity: number, ratio: number): void
  dispose(): void
}

const disposeAll = (...nodes: { dispose(): unknown }[]) => () => nodes.forEach((n) => n.dispose())

function bowedPad(
  out: Tone.InputNode,
  freq: () => number,
  open: () => number,
  stroke: { duration: number; harmonic?: boolean; tremolo?: boolean; velocityScale?: number },
  hair: StringId = 'female'
): PadVoice {
  const body = new Soundbox(out)
  const voice = new BowedVoice(body.input, { hair })
  let direction: BowDirection = 'tatakh'
  return {
    trigger(time, velocity, ratio) {
      voice.openFreq = open() * ratio
      voice.stroke({ time, freq: freq() * ratio, velocity: velocity * (stroke.velocityScale ?? 1), direction, ...stroke })
      direction = direction === 'tatakh' ? 'tülekhe' : 'tatakh'
    },
    dispose: disposeAll(voice, body)
  }
}

function createPad(id: PadId, out: Tone.InputNode, tuning: () => Tuning): PadVoice {
  const male = () => midiToFreq(tuning().male)
  const female = () => midiToFreq(tuning().female)

  switch (id) {
    case 'colLegno': {
      const body = new Soundbox(out)
      const c = new ColLegno(body.input)
      return { trigger: (t, v, r) => c.trigger(female() * r, t, v), dispose: disposeAll(c, body) }
    }
    case 'bodyTap': {
      const body = new Soundbox(out)
      const k = new BodyKnock(body.input)
      return { trigger: (t, v, r) => k.trigger(t, v, r), dispose: disposeAll(k, body) }
    }
    case 'pizzicato': {
      const body = new Soundbox(out)
      const p = new Pluck(body.input)
      return { trigger: (t, v, r) => p.trigger(female() * r, t, v), dispose: disposeAll(p, body) }
    }
    case 'whinny': {
      const body = new Soundbox(out)
      const voice = new BowedVoice(body.input)
      return {
        trigger: (t, _v, r) => {
          voice.openFreq = female() * r
          whinnyGesture(voice, t, female() * r * 2 ** (7 / 12), 1)
        },
        dispose: disposeAll(voice, body)
      }
    }
    case 'maleOpen':
      return bowedPad(out, male, male, { duration: 0.6 }, 'male')
    case 'femaleOpen':
      return bowedPad(out, female, female, { duration: 0.6 })
    case 'tsatsal':
      return bowedPad(out, () => female() * 2, female, { duration: 1.2, harmonic: true })
    case 'tremolo':
      return bowedPad(out, () => female() * 2 ** (7 / 12), female, { duration: 0.8, tremolo: true })

    case 'sub808': {
      const drive = new Tone.Distortion(0.2).connect(out)
      const s = new Tone.MembraneSynth({
        pitchDecay: 0.08,
        octaves: 3,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.002, decay: 1.4, sustain: 0, release: 0.3 }
      }).connect(drive)
      return { trigger: (t, v, r) => s.triggerAttackRelease(midiToFreq(29) * r, 1.2, t, v), dispose: disposeAll(s, drive) }
    }
    case 'snare': {
      const hp = new Tone.Filter({ type: 'highpass', frequency: 1800 }).connect(out)
      const n = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.02 }, volume: -4 }).connect(hp)
      const m = new Tone.MembraneSynth({ pitchDecay: 0.02, octaves: 1.5, envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.02 } }).connect(out)
      return {
        trigger: (t, v, r) => {
          n.triggerAttackRelease(0.15, t, v)
          m.triggerAttackRelease(180 * r, 0.1, t, v * 0.7)
        },
        dispose: disposeAll(n, m, hp)
      }
    }
    case 'hihat': {
      const hp = new Tone.Filter({ type: 'highpass', frequency: 6500 }).connect(out)
      const s = new Tone.MetalSynth({
        envelope: { attack: 0.001, decay: 0.06, release: 0.01 },
        harmonicity: 5.1,
        modulationIndex: 32,
        resonance: 5200,
        octaves: 1.5,
        volume: -14
      }).connect(hp)
      return { trigger: (t, v, r) => s.triggerAttackRelease(300 * r, 0.03, t, v), dispose: disposeAll(s, hp) }
    }
    case 'clap': {
      const band = new Tone.Filter({ type: 'bandpass', frequency: 1400, Q: 1.2 }).connect(out)
      const n = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.01 } }).connect(band)
      const wood = new Tone.MembraneSynth({ pitchDecay: 0.004, octaves: 0.6, envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.01 } }).connect(out)
      return {
        trigger: (t, v, r) => {
          n.triggerAttackRelease(0.01, t, v)
          n.triggerAttackRelease(0.01, t + 0.011, v * 0.8)
          n.triggerAttackRelease(0.06, t + 0.022, v * 0.9)
          wood.triggerAttackRelease(820 * r, 0.05, t, v * 0.6)
        },
        dispose: disposeAll(n, wood, band)
      }
    }
    case 'kick': {
      const s = new Tone.MembraneSynth({
        pitchDecay: 0.045,
        octaves: 6,
        envelope: { attack: 0.001, decay: 0.42, sustain: 0, release: 0.1 }
      }).connect(out)
      return { trigger: (t, v, r) => s.triggerAttackRelease(midiToFreq(24) * r, 0.4, t, v), dispose: disposeAll(s) }
    }
    case 'cymbal': {
      const hp = new Tone.Filter({ type: 'highpass', frequency: 3000 }).connect(out)
      const s = new Tone.MetalSynth({
        envelope: { attack: 0.001, decay: 1.3, release: 0.4 },
        harmonicity: 5.1,
        modulationIndex: 40,
        resonance: 4000,
        octaves: 1.5,
        volume: -16
      }).connect(hp)
      return { trigger: (t, v, r) => s.triggerAttackRelease(250 * r, 1, t, v), dispose: disposeAll(s, hp) }
    }
    case 'shamanDrum': {
      // Large frame drum (khengereg): low skin boom plus the swish of the beater.
      const lp = new Tone.Filter({ type: 'lowpass', frequency: 900 }).connect(out)
      const m = new Tone.MembraneSynth({
        pitchDecay: 0.09,
        octaves: 1.6,
        envelope: { attack: 0.002, decay: 0.95, sustain: 0, release: 0.2 }
      }).connect(out)
      const swish = new Tone.NoiseSynth({ noise: { type: 'brown' }, envelope: { attack: 0.004, decay: 0.3, sustain: 0, release: 0.05 } }).connect(lp)
      return {
        trigger: (t, v, r) => {
          m.triggerAttackRelease(62 * r, 0.8, t, v)
          swish.triggerAttackRelease(0.25, t, v * 0.6)
        },
        dispose: disposeAll(m, swish, lp)
      }
    }
    case 'bells': {
      // Jingling bells: three quick strikes.
      const s = new Tone.MetalSynth({
        envelope: { attack: 0.001, decay: 0.5, release: 0.2 },
        harmonicity: 3.1,
        modulationIndex: 8,
        resonance: 6000,
        octaves: 0.8,
        volume: -14
      }).connect(out)
      return {
        trigger: (t, v, r) => {
          s.triggerAttackRelease(900 * r, 0.3, t, v)
          s.triggerAttackRelease(900 * r, 0.3, t + 0.035, v * 0.6)
          s.triggerAttackRelease(900 * r, 0.3, t + 0.07, v * 0.4)
        },
        dispose: disposeAll(s)
      }
    }
  }
}

interface PadChannel {
  voice: PadVoice
  filter: Tone.Filter
  gain: Tone.Gain
  params: PadParams
}

/** The 16-pad kit. Every pad: source → low-pass (Freq/Reso) → gain (Level) → kit output. */
export class BeatKit {
  readonly output: Tone.Gain
  tuning: Tuning = DEFAULT_TUNING
  private readonly channels: Record<PadId, PadChannel>

  constructor(output: Tone.InputNode) {
    this.output = new Tone.Gain(0.65).connect(output)
    this.channels = {} as Record<PadId, PadChannel>
    for (const id of PAD_IDS) {
      const gain = new Tone.Gain(1).connect(this.output)
      const filter = new Tone.Filter({ type: 'lowpass', frequency: DEFAULT_PAD_PARAMS.freq, Q: DEFAULT_PAD_PARAMS.reso }).connect(gain)
      this.channels[id] = { voice: createPad(id, filter, () => this.tuning), filter, gain, params: { ...DEFAULT_PAD_PARAMS } }
    }
  }

  /** `pitch` is a per-hit offset in semitones, added to the pad's Tune knob. */
  trigger(pad: PadId, time = Tone.immediate(), velocity = 0.9, pitch = 0): void {
    const ch = this.channels[pad]
    ch.voice.trigger(time, velocity, 2 ** ((ch.params.tune + pitch) / 12))
  }

  setParams(pad: PadId, params: PadParams): void {
    const ch = this.channels[pad]
    ch.params = { ...params }
    ch.gain.gain.rampTo(Tone.dbToGain(params.level), 0.03)
    ch.filter.frequency.rampTo(params.freq, 0.03)
    ch.filter.Q.rampTo(params.reso, 0.03)
  }

  dispose(): void {
    for (const id of PAD_IDS) {
      const ch = this.channels[id]
      ch.voice.dispose()
      ch.filter.dispose()
      ch.gain.dispose()
    }
    this.output.dispose()
  }
}
