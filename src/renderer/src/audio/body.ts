import * as Tone from 'tone'
import { VARIANT, soundboxImpulse, type Soundboard } from './soundbox-ir'

export { SOUNDBOARDS, soundboxImpulse, type Soundboard } from './soundbox-ir'

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
