import * as Tone from 'tone'

/**
 * Wooden-top soundbox (gashaa): [frequency Hz, Q, peak dB]. The maxima are the radiated response
 * Bulanov measured on a modern wooden-top morin khuur (lab, mic at 1 m): 170 Hz (air resonance at the
 * f-holes), 280 / 440 / 780 Hz within 4 dB of each other (an even, flat-topped mid-range), 1200 Hz
 * (stronger off-axis), 1800 Hz, and formants at 2300 and 3500 Hz present at every pitch that give
 * the instrument its brightness and projection. 980 and 1550 Hz are fillers that stop deep
 * antiresonances between measured maxima; the tail falls roughly linearly to 14–16 kHz.
 * Above 2 kHz the levels are set from reference recordings (references/measurements.md): a
 * conservatory recording rolls off ~10 dB more steeply over 3–5 kHz than the first version of
 * this table, a trio recording ~3 dB more; the table takes the middle, keeping 2300 and 3500 Hz
 * as maxima.
 * The air mode is set low so the open F3 fundamental lands 1–2 dB below its next harmonics, as
 * measured, while higher notes are increasingly dominated by the fundamental. Q values were
 * fitted in simulation — no source gives them.
 */
const WOOD_MODES: readonly [number, number, number][] = [
  [170, 8, -12],
  [280, 5, -1],
  [440, 5, 0],
  [780, 5, -1],
  [980, 12, -5],
  [1200, 10, -3],
  [1550, 8, -3],
  [1800, 10, -1],
  [2300, 10, -3],
  [2900, 16, -9],
  [3500, 10, -6],
  [4300, 18, -11],
  [5200, 20, -13],
  [6400, 22, -14],
  [8000, 24, -16],
  [10000, 26, -19]
]

/**
 * Traditional hide (skin) top. No morin khuur measurement exists. The closest radiated measurement
 * is Bulanov's suukha khuur (horsehair strings on a skin top): formants at 520 and 1120 Hz, steep
 * roll-off above, a weak fundamental on low notes. Modes at 670, 840, 1000, 1500 and 2170 Hz are
 * the kamancheh's measured membrane modes (ISMA 2014). The air mode is lowered to 160 Hz because a
 * compliant wall lowers it. Softened from the suukha khuur: warm and quiet rather than nasal.
 */
const HIDE_MODES: readonly [number, number, number][] = [
  [160, 8, -20],
  [300, 8, -19],
  [520, 7, 0],
  [670, 10, -9],
  [840, 10, -10],
  [1000, 10, -10],
  [1120, 8, -6],
  [1500, 10, -14],
  [1800, 10, -16],
  [2170, 12, -21],
  [3400, 12, -30],
  [5500, 14, -40]
]

export type Soundboard = 'wood' | 'hide'

export const SOUNDBOARDS: readonly { id: Soundboard; name: string; description: string }[] = [
  { id: 'wood', name: 'Wooden top', description: 'Modern concert instrument: spruce top with f-holes, soundpost and bass bar — louder and brighter.' },
  { id: 'hide', name: 'Hide top', description: 'Traditional skin-covered soundboard — warm, mellow and quieter, suited to playing inside a ger.' }
]

interface Variant {
  modes: readonly [number, number, number][]
  cloudTopHz: number
  cloudDb: number
  airHz: number
  /** Direct bridge signal mixed with the body response. */
  dry: number
  /** Make-up gain: wood matches the loudness of earlier versions, hide sits about 3 dB below. */
  level: number
}

const VARIANT: Record<Soundboard, Variant> = {
  wood: { modes: WOOD_MODES, cloudTopHz: 12000, cloudDb: -13, airHz: 16000, dry: 0.05, level: 0.385 },
  hide: { modes: HIDE_MODES, cloudTopHz: 5000, cloudDb: -28, airHz: 7000, dry: 0.02, level: 0.55 }
}

const IR_SECONDS = 0.35

function seededRandom(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * Impulse response as a sum of damped sinusoidal modes, plus a dense cloud of weak body modes.
 * Each mode is scaled so its spectral peak equals its dB value (the convolver does not normalise),
 * and principal modes alternate in sign so neighbouring maxima never cancel into deep notches.
 * The cloud has its own random stream, so editing the principal table cannot reshuffle it.
 */
export function soundboxImpulse(sampleRate: number, soundboard: Soundboard = 'wood'): Float32Array<ArrayBuffer> {
  const rand = seededRandom(0x6d6b6875)
  const v = VARIANT[soundboard]
  const modes: [number, number, number, number][] = v.modes.map(([f, q, db], i) => [f, q, db, (i % 2) * Math.PI])
  for (let i = 0; i < 64; i++) {
    const f = 500 * (v.cloudTopHz / 500) ** rand()
    const q = soundboard === 'hide' ? 8 + rand() * 12 : 18 + rand() * 40
    modes.push([f, q, v.cloudDb - rand() * 10 - (f / v.cloudTopHz) * 6, rand() * Math.PI * 2])
  }
  const n = Math.floor(IR_SECONDS * sampleRate)
  const ir = new Float32Array(n)
  for (const [f, q, db, phase] of modes) {
    const amp = (2 * 10 ** (db / 20) * 2 * Math.PI * f) / q / sampleRate
    const decay = Math.exp((-Math.PI * f) / (q * sampleRate))
    const w = (2 * Math.PI * f) / sampleRate
    let env = amp
    for (let i = 0; i < n; i++) {
      ir[i]! += env * Math.sin(w * i + phase)
      env *= decay
      if (env < 1e-7) break
    }
  }
  return ir
}

const irCache = new WeakMap<object, Partial<Record<Soundboard, AudioBuffer>>>()

function soundboxBuffer(context: Tone.BaseContext, soundboard: Soundboard): AudioBuffer {
  let perContext = irCache.get(context.rawContext)
  if (!perContext) irCache.set(context.rawContext, (perContext = {}))
  let buffer = perContext[soundboard]
  if (!buffer) {
    const ir = soundboxImpulse(context.sampleRate, soundboard)
    buffer = context.createBuffer(1, ir.length, context.sampleRate)
    buffer.copyToChannel(ir, 0)
    perContext[soundboard] = buffer
  }
  return buffer
}

/** Crossfade time when the soundboard is changed while playing. */
const SWAP_SECONDS = 0.08

/** The body path through one impulse response: its convolver and a fade gain after it. */
interface BodyPath {
  convolver: ConvolverNode
  fade: GainNode
}

/**
 * The soundbox. Both strings and knuckle taps excite the same body, as on the real instrument:
 * the convolved modal response, with a trace of direct bridge signal for articulation.
 */
export class Soundbox {
  readonly input: Tone.Gain
  private readonly highpass: Tone.Filter
  private path: BodyPath
  /** Paths being faded out after a soundboard change, disconnected once silent. */
  private readonly retiring = new Set<BodyPath>()
  private readonly air: Tone.Filter
  private readonly dry: Tone.Gain
  private readonly level: Tone.Gain
  private readonly nodes: Tone.ToneAudioNode[]
  private current: Soundboard

  constructor(output: Tone.InputNode, soundboard: Soundboard = 'wood') {
    this.current = soundboard
    this.input = new Tone.Gain(1)
    // Below the 170 Hz air resonance the box radiates little.
    this.highpass = new Tone.Filter({ type: 'highpass', frequency: 90, Q: 0.6 })
    this.dry = new Tone.Gain(VARIANT[soundboard].dry)
    this.air = new Tone.Filter({ type: 'lowpass', frequency: VARIANT[soundboard].airHz, Q: 0.5 })
    this.level = new Tone.Gain(VARIANT[soundboard].level)
    this.path = this.createPath(soundboard, 1)
    this.input.connect(this.highpass)
    this.highpass.chain(this.dry, this.air)
    this.air.chain(this.level, output)
    this.nodes = [this.input, this.highpass, this.dry, this.air, this.level]
  }

  /**
   * A native ConvolverNode: the impulse response is absolutely scaled, and Tone.Convolver would
   * apply equal-power normalisation (it assigns the buffer before its `normalize` option, and
   * rebuilds the node with the default whenever the buffer changes).
   */
  private createPath(soundboard: Soundboard, gain: number): BodyPath {
    const context = this.input.context
    const convolver = context.createConvolver()
    convolver.normalize = false
    convolver.buffer = soundboxBuffer(context, soundboard)
    const fade = context.createGain()
    fade.gain.value = gain
    Tone.connect(this.highpass, convolver)
    convolver.connect(fade)
    Tone.connect(fade, this.air)
    return { convolver, fade }
  }

  private releasePath(path: BodyPath): void {
    this.retiring.delete(path)
    this.highpass.disconnect(path.convolver)
    path.convolver.disconnect()
    path.fade.disconnect()
  }

  get soundboard(): Soundboard {
    return this.current
  }

  set soundboard(soundboard: Soundboard) {
    if (soundboard === this.current) return
    this.current = soundboard
    const v = VARIANT[soundboard]
    const t = this.input.context.currentTime
    if (t === 0) {
      // Nothing has sounded yet (an offline render being set up, or audio not started): swap outright.
      this.releasePath(this.path)
      this.path = this.createPath(soundboard, 1)
      this.air.frequency.setValueAtTime(v.airHz, 0)
      this.dry.gain.setValueAtTime(v.dry, 0)
      this.level.gain.setValueAtTime(v.level, 0)
      return
    }
    // While playing, crossfade the two bodies so the change is heard as a change, not a click.
    const old = this.path
    old.fade.gain.cancelScheduledValues(t)
    old.fade.gain.setValueAtTime(old.fade.gain.value, t)
    old.fade.gain.linearRampToValueAtTime(0, t + SWAP_SECONDS)
    this.retiring.add(old)
    setTimeout(() => {
      if (this.retiring.has(old)) this.releasePath(old)
    }, SWAP_SECONDS * 1000 + 100)
    this.path = this.createPath(soundboard, 0)
    this.path.fade.gain.setValueAtTime(0, t)
    this.path.fade.gain.linearRampToValueAtTime(1, t + SWAP_SECONDS)
    this.air.frequency.linearRampTo(v.airHz, SWAP_SECONDS, t)
    this.dry.gain.linearRampTo(v.dry, SWAP_SECONDS, t)
    this.level.gain.linearRampTo(v.level, SWAP_SECONDS, t)
  }

  dispose(): void {
    this.releasePath(this.path)
    for (const path of [...this.retiring]) this.releasePath(path)
    for (const n of this.nodes) n.dispose()
  }
}
