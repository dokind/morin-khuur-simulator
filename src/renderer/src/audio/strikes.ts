import * as Tone from 'tone'

export interface PluckOptions {
  /** Seconds for the string to die away. Horsehair damps quickly. */
  decay: number
  /** Octaves the low-pass opens above its base at the moment of the pluck. */
  brightness: number
  /** Level of the finger/stick contact click. */
  click: number
}

/**
 * Pizzicato (huruugaar tatakh): a subtractive pluck — sawtooth through a low-pass that snaps
 * open and closes as the string loses energy, plus a contact click. Deliberately not
 * Tone.PluckSynth: its Karplus–Strong loop sounds 3–7 cents flat, failing the 5-cent pitch test.
 */
export class Pluck {
  private readonly synth: Tone.MonoSynth
  private readonly click: Tone.NoiseSynth
  private readonly clickBand: Tone.Filter
  private readonly options: PluckOptions

  constructor(output: Tone.InputNode, options: Partial<PluckOptions> = {}) {
    this.options = { decay: 0.75, brightness: 2.3, click: 0.35, ...options }
    const { decay, brightness } = this.options
    this.synth = new Tone.MonoSynth({
      oscillator: { type: 'sawtooth' },
      // The cutoff never drops near the fundamental: a filter sweeping across it shifts its phase
      // continuously, which is heard (and measured) as the note going flat.
      filter: { type: 'lowpass', Q: 0.8, rolloff: -12 },
      envelope: { attack: 0.001, decay, sustain: 0, release: decay * 0.4 },
      filterEnvelope: { attack: 0.001, decay: decay * 0.5, sustain: 0, release: 0.1, baseFrequency: 2000, octaves: brightness, exponent: 2 },
      volume: -1
    }).connect(output)
    this.clickBand = new Tone.Filter({ type: 'bandpass', frequency: 2500, Q: 0.8 }).connect(output)
    this.click = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.0005, decay: 0.008, sustain: 0, release: 0.005 } }).connect(this.clickBand)
  }

  trigger(freq: number, time: number, velocity = 0.8): void {
    this.synth.triggerAttackRelease(freq, this.options.decay, time, velocity)
    if (this.options.click > 0) this.click.triggerAttackRelease(0.01, time, Math.min(1, velocity * this.options.click))
  }

  dispose(): void {
    this.synth.dispose()
    this.click.dispose()
    this.clickBand.dispose()
  }
}

/** Col legno (numny modoor tsoxikh): wooden bow stick on the string — dry click plus a pitched tick. */
export class ColLegno {
  private readonly click: Tone.NoiseSynth
  private readonly band: Tone.Filter
  private readonly tick: Pluck

  constructor(output: Tone.InputNode) {
    this.band = new Tone.Filter({ type: 'bandpass', frequency: 3200, Q: 0.9 })
    this.click = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.0005, decay: 0.025, sustain: 0, release: 0.01 }, volume: 12 })
    this.click.chain(this.band, output)
    this.tick = new Pluck(output, { decay: 0.12, brightness: 3.2, click: 0 })
  }

  trigger(freq: number, time: number, velocity = 0.8): void {
    this.click.triggerAttackRelease(0.02, time, velocity)
    this.tick.trigger(freq, time, velocity * 0.8)
  }

  dispose(): void {
    this.click.dispose()
    this.band.dispose()
    this.tick.dispose()
  }
}

/** String slap / snap (utas tsoxikh): a hard finger snap against the hovering string. */
export class StringSlap {
  private readonly snap: Tone.NoiseSynth
  private readonly hp: Tone.Filter
  private readonly string: Pluck

  constructor(output: Tone.InputNode) {
    this.hp = new Tone.Filter({ type: 'highpass', frequency: 1200 })
    this.snap = new Tone.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.0005, decay: 0.012, sustain: 0, release: 0.01 }, volume: 8 })
    this.snap.chain(this.hp, output)
    this.string = new Pluck(output, { decay: 0.2, brightness: 3.4, click: 0.6 })
  }

  trigger(freq: number, time: number, velocity = 0.8): void {
    this.snap.triggerAttackRelease(0.015, time, velocity)
    this.string.trigger(freq, time, velocity * 0.7)
  }

  dispose(): void {
    this.snap.dispose()
    this.hp.dispose()
    this.string.dispose()
  }
}

/** Body percussion (hairtsag tsoxikh): knuckles on the soundbox — the galloping hoof beat (doroo). */
export class BodyKnock {
  private readonly thump: Tone.MembraneSynth
  private readonly knock: Tone.NoiseSynth
  private readonly band: Tone.Filter

  constructor(output: Tone.InputNode, private readonly pitch = 105) {
    this.thump = new Tone.MembraneSynth({
      pitchDecay: 0.012,
      octaves: 2.2,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.02 },
      volume: 3
    })
    this.thump.connect(output)
    this.band = new Tone.Filter({ type: 'bandpass', frequency: 700, Q: 1.5 })
    this.knock = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.0008, decay: 0.035, sustain: 0, release: 0.01 } })
    this.knock.chain(this.band, output)
  }

  trigger(time: number, velocity = 0.9, pitchScale = 1): void {
    this.thump.triggerAttackRelease(this.pitch * pitchScale, 0.1, time, velocity)
    this.knock.triggerAttackRelease(0.03, time, velocity * 0.8)
  }

  dispose(): void {
    this.thump.dispose()
    this.knock.dispose()
    this.band.dispose()
  }
}
