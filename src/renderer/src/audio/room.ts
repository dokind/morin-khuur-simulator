import * as Tone from 'tone'

export type RoomId = 'steppe' | 'ger' | 'hall' | 'dry'

export interface RoomPreset {
  id: RoomId
  name: string
  description: string
  /** Send to the short, felt-damped room reverb (ger ambience). */
  short: number
  /** Send to the long reverb (steppe / hall tail). */
  long: number
  longDecay: number
  longPreDelay: number
  /** Send to a single distant echo. */
  echo: number
}

export const ROOMS: readonly RoomPreset[] = [
  {
    id: 'steppe',
    name: 'Steppe Acoustic',
    description: 'Open air: a thin, far-reaching tail and a faint echo off distant hills.',
    short: 0.05,
    long: 0.22,
    longDecay: 3.6,
    longPreDelay: 0.06,
    echo: 0.12
  },
  {
    id: 'ger',
    name: 'Ger / Yurt',
    description: 'A small round felt tent: short, warm and intimate.',
    short: 0.38,
    long: 0.04,
    longDecay: 1.4,
    longPreDelay: 0.01,
    echo: 0
  },
  {
    id: 'hall',
    name: 'Wooden Hall',
    description: 'A concert hall with wooden panelling.',
    short: 0.12,
    long: 0.3,
    longDecay: 2.2,
    longPreDelay: 0.03,
    echo: 0
  },
  { id: 'dry', name: 'Dry Studio', description: 'No room at all.', short: 0, long: 0, longDecay: 1.5, longPreDelay: 0.01, echo: 0 }
]

export function getRoom(id: string): RoomPreset {
  return ROOMS.find((r) => r.id === id) ?? ROOMS[0]!
}

/** Parallel room: dry + short felt room + long tail + distant echo. */
export class Room {
  readonly input: Tone.Gain
  readonly ready: Promise<void>
  private readonly shortVerb: Tone.Reverb
  private readonly shortDamp: Tone.Filter
  private readonly shortSend: Tone.Gain
  private readonly longVerb: Tone.Reverb
  private readonly longSend: Tone.Gain
  private readonly echo: Tone.FeedbackDelay
  private readonly echoDamp: Tone.Filter
  private readonly echoSend: Tone.Gain
  private readonly dry: Tone.Gain

  constructor(output: Tone.InputNode, preset: RoomPreset = ROOMS[0]!) {
    this.input = new Tone.Gain(1)
    this.dry = new Tone.Gain(1)
    this.input.chain(this.dry, output)

    this.shortSend = new Tone.Gain(preset.short)
    this.shortVerb = new Tone.Reverb({ decay: 0.8, preDelay: 0.004, wet: 1 })
    this.shortDamp = new Tone.Filter({ type: 'lowpass', frequency: 3500 }) // felt absorbs the highs
    this.input.chain(this.shortSend, this.shortVerb, this.shortDamp, output)

    this.longSend = new Tone.Gain(preset.long)
    this.longVerb = new Tone.Reverb({ decay: preset.longDecay, preDelay: preset.longPreDelay, wet: 1 })
    this.input.chain(this.longSend, this.longVerb, output)

    this.echoSend = new Tone.Gain(preset.echo)
    this.echo = new Tone.FeedbackDelay({ delayTime: 0.34, feedback: 0.18, wet: 1 })
    this.echoDamp = new Tone.Filter({ type: 'lowpass', frequency: 2400 })
    this.input.chain(this.echoSend, this.echo, this.echoDamp, output)

    this.ready = Promise.all([this.shortVerb.ready, this.longVerb.ready]).then(() => undefined)
  }

  apply(preset: RoomPreset, time = Tone.immediate()): void {
    this.shortSend.gain.rampTo(preset.short, 0.2, time)
    this.longSend.gain.rampTo(preset.long, 0.2, time)
    this.echoSend.gain.rampTo(preset.echo, 0.2, time)
    if (this.longVerb.decay !== preset.longDecay) this.longVerb.decay = preset.longDecay
    if (this.longVerb.preDelay !== preset.longPreDelay) this.longVerb.preDelay = preset.longPreDelay
  }

  /** Studio knobs: 0–1 sends for the long ("Steppe Reverb") and short ("Ger Ambience") reverbs. */
  setSends({ long, short }: { long?: number; short?: number }, time = Tone.immediate()): void {
    if (long !== undefined) this.longSend.gain.rampTo(long, 0.1, time)
    if (short !== undefined) this.shortSend.gain.rampTo(short, 0.1, time)
  }

  dispose(): void {
    for (const n of [
      this.input,
      this.dry,
      this.shortSend,
      this.shortVerb,
      this.shortDamp,
      this.longSend,
      this.longVerb,
      this.echoSend,
      this.echo,
      this.echoDamp
    ]) {
      n.dispose()
    }
  }
}
