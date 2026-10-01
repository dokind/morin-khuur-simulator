import * as Tone from 'tone'
import type { StringId } from '@renderer/core/instrument'
import { vibratoSegments, type BowProfile, type PitchOrnament, type VibratoPlan } from '@renderer/core/performance'
import type { BowDirection } from '@renderer/core/techniques'
import { BOWED_STRING, isDspReady, loadDsp } from './dsp'

export interface BowInput {
  /** 0–1 bow velocity across the string. */
  speed: number
  /** 0–1 hair pressure; the underhand grip's middle/ring fingers tension the hair directly. */
  pressure: number
  /** −1 sul tasto (near the neck) … 0 normal … +1 sul ponticello (against the bridge). */
  position: number
}

export interface Timbre {
  /** Bow velocity fed to the string model, 0–1. */
  level: number
  /** Bow force fed to the friction junction, 0–1. */
  force: number
  /** Bow contact point, fraction of string length from the bridge. */
  beta: number
  /** Post-string low-pass (radiation / hand damping). */
  cutoff: number
  /** Extra rosin hiss on top of what the model produces. */
  noise: number
  presenceDb: number
  /** Crossfade towards a pure sine, for harmonics. */
  sineMix: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Contact point of sul tasto and shurankhai strokes (fraction of the string from the bridge). */
const TASTO_BETA = 0.19

/** Any Tone Param or Signal, for scheduling numeric targets. */
interface Automatable {
  cancelScheduledValues(time: number): unknown
  setTargetAtTime(value: number, time: number, timeConstant: number): unknown
  setValueAtTime(value: number, time: number): unknown
}

/**
 * Maps bow gestures to physical-model parameters. Speed drives bow velocity (loudness), pressure
 * drives friction force (light = airy surface sound, heavy = gripping and gritty), and the contact
 * point moves the bow between neck (dark, flautando) and bridge (bright, glassy).
 */
export function bowTimbre({ speed, pressure, position }: BowInput, harmonic = false): Timbre {
  const s = clamp(speed, 0, 1)
  const p = clamp(pressure, 0, 1)
  const x = clamp(position, -1, 1)
  return {
    level: s,
    // Players press harder to bow faster, and lean in at the bridge; the waveguide needs the same
    // to stay in Helmholtz motion (mapped exhaustively offline: see bowed-string.test.ts).
    // Harmonics are bowed lightly, but not below the stable region the offline maps found.
    force: Math.min(0.95, (harmonic ? 0.4 : 0.3) + (harmonic ? 0.15 : 0.3) * p + (harmonic ? 0.3 : 0.4) * s + 0.12 * Math.max(0, x)),
    // Contact point from the bridge. Bowing at a node of a harmonic (1/n of the string) invites the
    // string to lock onto that harmonic instead of the fundamental, as a real string can. So the
    // contact point only takes values where the model holds Helmholtz motion at every bow speed and
    // force strokes use, never nearer the bridge than ~0.11: 0.13 (between 1/8 and 1/7) and, sul
    // tasto, 0.19 (between 1/6 and 1/5). Further from the bridge its regimes are unreliable (the
    // 0.225 and 0.29 first chosen sound H3 or H4 above the fundamental, and from 0.3 on subharmonics
    // at a third of the pitch mislead the pitch detector; bowed-string.test.ts). The low-pass and a
    // little flautando sine carry the continuous part of the tasto–ponticello control.
    beta: harmonic ? 0.13 : x <= -0.35 ? TASTO_BETA : x < 0 ? 0.13 : 0.13 * 2 ** (-x * 0.25),
    // Horsehair keeps energy up to 14–16 kHz; the bow point only tilts it.
    cutoff: harmonic ? 4000 : Math.min(16000, 12000 * 2 ** (x * 1.1) * (0.8 + 0.3 * p)),
    // Horsehair rasp: the conservatory reference is ~5 dB noisier (HNR 19 vs 25 dB) than this was;
    // part of that is room and tape noise, so the bow noise was raised by 3 dB, not 5.
    noise: 1.4 * (0.025 + 0.06 * (1 - p) * s) * (harmonic ? 0.4 : 1),
    // Sul ponticello's glassy rasp comes mostly from the upper partials and extra rosin noise.
    presenceDb: Math.max(0, x) * 8,
    sineMix: harmonic ? 0.7 : Math.max(0, -x) * 0.25
  }
}

export interface StrokeOptions {
  time: number
  duration: number
  freq: number
  /** 0–1 */
  velocity: number
  direction: BowDirection
  /** Continue the previous stroke without a bow change (legato finger change). */
  slur?: boolean
  harmonic?: boolean
  /** Vibrato depth in cents (0 = none). Onset is delayed like a player's. */
  vibrato?: number
  tremolo?: boolean
  position?: number
  /** Glissando target frequency (slide during the note). */
  glideTo?: number
  /** Slide into the note over this many seconds: from `slideFrom`, else the current pitch (a step below if silent). */
  slideIn?: number
  slideFrom?: number
  /** Legato (slurred) pitch change time in seconds; wider intervals take longer. */
  glide?: number
  /** Wide, fast vibrato "shake" during the slide-in (shigshikh). */
  shake?: boolean
  accent?: boolean
  /** Short, detached stroke (galloping bow). */
  detached?: boolean
  /** Wavy bow: accent pulses inside the stroke from the fingers pressing the hair. */
  wavy?: boolean
  // --- performance plan (core/performance); verification and measurePitch never set these ---
  /** Left-hand ornaments around the written pitch, in time order (ignored on harmonics and glissandi). */
  ornaments?: readonly PitchOrnament[]
  /** Planned vibrato (shape, rate, placement, amplitude modulation); replaces `vibrato` when set. */
  vibratoPlan?: VibratoPlan | null
  /** Bow-speed shape of a fresh stroke (default 'swell'). */
  bowProfile?: BowProfile
  /** Bow point drift over the note, added to `position`. Only the brightness follows it. */
  positionRamp?: { from: number; to: number } | null
  /** Long-song shurankhai: a lighter, flautando "falsetto" colour. */
  shurankhai?: boolean
  /** The stroke fades out over its length (closing frame). */
  taper?: boolean
}

/**
 * Planned vibrato placed over the 'whole' note reaches full depth this soon, s: on the conservatory
 * reference recording vibrato is at half depth ~130 ms into the note (references/measurements.md).
 */
const WHOLE_VIBRATO_RAMP = 0.26

/** How long a live landing keeps the bow off the string, s (see liveHold). */
const LANDING_HOLD = 0.012
/** Strokes scheduled less than this far ahead of the audio clock count as live, s. */
const LIVE_EVENT_WINDOW = 0.02

/** Vibrato rate: lyrical long-song vibrato runs at about 5 Hz. */
export const VIBRATO_HZ = 5

/**
 * Per-string horsehair character. The male (Arga) string has ~130 stallion hairs — thicker,
 * rougher and lossier; the female (Bilag) ~105 mare hairs.
 */
const HAIR: Record<StringId, { roughness: number; damping: number }> = {
  male: { roughness: 0.42, damping: 0.93 },
  female: { roughness: 0.32, damping: 0.945 }
}

/**
 * Scales the waveguide's bridge velocity before the soundbox. Bowed-string waves are spiky (peaks
 * ~14 dB above RMS), so this leaves a loud single note peaking near −6 dBFS with room for double
 * stops and reverb.
 */
const STRING_GAIN = 0.8
/** Legato finger changes on a hovering string always slide a little. */
const SLUR_GLIDE_TC = 0.025
/** Finger travel between an ornament note and the main note (grace, mordent, hammer lift). */
const ORNAMENT_STEP = 0.008
/**
 * A finger change on a sounding string (a bow change to a new note) glides over this long, and 3 ms
 * longer per half octave beyond the first: a jump in the loop length makes the waveguide skip or
 * replay part of the travelling wave, a click and, when it replays the Helmholtz corner, a second
 * corner (the octave). Moving the loop length by about a sample per sample or less, it only
 * stretches the wave — even across a leap of two octaves to a harmonic.
 */
const FINGER_STEP = 0.003
/** Trill steps: each change of note glides over 12–15 ms ("stepped" trill). */
const TRILL_STEP = 0.013
/**
 * Exponential bow rise of detached and abrupt strokes (63% in 12 ms). Before landings took the
 * string over into Helmholtz motion (bowed-string.worklet.js), faster, linear or raised-cosine
 * rises flipped the male string to its octave at medium velocities (bowed-string.test.ts).
 */
const QUICK_ATTACK_TC = 0.012
/**
 * A stroke continues the string's motion (a bow change, or a slur) while the bow still moves at
 * this fraction of the new stroke's speed; below it (after a detached, abrupt or released stroke,
 * or a gesture) the bow lands again, with the force pressed.
 */
const SOUNDING = 0.3
/**
 * Live bowing below this speed is a crawl: drawn on to at least twice its speed at once, the hair
 * digs in and the stroke lands again, as from rest. Accelerated from so slow a bow, the string's
 * tiny Helmholtz motion cannot keep up: a bow-pad sforzando from 2% of full speed started in the
 * octave for 30–95 ms on a third of the male string's strokes (bowed-voice.test.ts).
 */
const CRAWL = 0.06
/**
 * At a bow change the hair slows towards half its speed (time constant 8 ms) and turns. Slowed
 * further and faster (to 25% within 4 ms, as first used), the bow can no longer hold the string
 * through its stick phase: extra slips split the period and the string flips to its octave
 * (double slip) on a few percent of bow changes. Slowed like this it keeps its Helmholtz motion
 * (bowed-string.test.ts).
 */
const BOW_TURN = { to: 0.5, timeConstant: 0.008 }
/**
 * Force pushes (accents, finger strikes) are held this long after the bow lands, then eased back.
 * A push that falls while the bow is still catching the string — the 20–40 ms spikes first tried —
 * locks the male string onto its octave on a third of all landings, depending only on where in a
 * render quantum the stroke starts (bowed-string.test.ts).
 */
const PUSH_HOLD = 0.2
/** On a bow change the hair stops and reverses: a push waits until the bow is moving again. */
const PUSH_TURN = 0.04
/** Force given back as an accent-release stroke's bow relaxes to 70% of its speed. */
const ACCENT_RELEASE_LIGHTER = 0.08
/** Shurankhai colour: the bow drawn lighter at the tasto contact point, with a flautando sine. */
const SHURANKHAI = { force: -0.15, position: -0.4, beta: TASTO_BETA, sineMix: 0.2 }

/** ± linear gain swing for a ± dB amplitude modulation around unity. */
const amSwing = (db: number) => (10 ** (db / 20) - 10 ** (-db / 20)) / 2

/** Value of a piecewise-linear envelope (sorted [time, value] points) at `time`. */
function envelopeAt(points: readonly (readonly [number, number])[], time: number): number {
  if (!points.length) return 0
  if (time <= points[0]![0]) return points[0]![1]
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i]!
    const [t0, v0] = points[i - 1]!
    if (time <= t1) return t1 > t0 ? v0 + ((v1 - v0) * (time - t0)) / (t1 - t0) : v1
  }
  return points[points.length - 1]![1]
}

/**
 * One bowed horsehair string: the `mkhuur-bowed-string` waveguide (worklet) driven by bow
 * velocity / force / contact point, with a sine layer for tsatsal harmonics, extra rosin hiss,
 * vibrato (detune) and tremolo. The worklet is attached as soon as its module has loaded.
 */
export class BowedVoice {
  private readonly freq: Tone.Signal<'frequency'>
  private readonly bow: Tone.Signal<'number'>
  private readonly force: Tone.Signal<'normalRange'>
  private readonly beta: Tone.Signal<'number'>
  private readonly stringGain: Tone.Gain
  private readonly sine: Tone.Oscillator
  private readonly sineVca: Tone.Gain
  private readonly mix: Tone.CrossFade
  private readonly toneLp: Tone.Filter
  private readonly presence: Tone.Filter
  private readonly noise: Tone.Noise
  private readonly noiseBandFreq: Tone.Multiply
  private readonly noiseBand: Tone.Filter
  private readonly noiseAmp: Tone.Gain
  private readonly noiseVca: Tone.Gain
  private readonly vibLfo: Tone.LFO
  private readonly vibDepth: Tone.Gain
  /** Vibrato amplitude modulation, in phase with the pitch (planned vibrato). */
  private readonly amDepth: Tone.Gain
  private readonly tremLfo: Tone.LFO
  private readonly tremDepth: Tone.Gain
  private readonly tremGain: Tone.Gain
  /** Post-string level for ornaments: a trill's quieter upper note. Never bow speed, which would flip regimes. */
  private readonly expr: Tone.Gain
  private readonly trim: Tone.Gain
  private readonly rough: Tone.Signal<'number'>
  private readonly hairRoughness: number
  private readonly meter: Tone.Meter | null
  private string: AudioWorkletNode | null = null
  private disposed = false
  /** Most recently requested pitch, for scaling the bow point with the stopped length. */
  private lastFreq = 233
  /**
   * When the bow last began to come off the string or to a stop (a release, the end of a scheduled
   * stroke, or live bowing at no speed); null while it is being drawn. The next stroke drawn after
   * it lands again, however slowly the bow is still creeping.
   */
  private restingFrom: number | null = 0
  /** Bow speed live bowing last asked for, which a bow change turns back to. */
  private liveLevel = 0
  /** Open-string frequency of this string (set by the owning instrument when the tuning changes). */
  openFreq = 233

  constructor(output: Tone.InputNode, { meter = false, hair = 'female' }: { meter?: boolean; hair?: StringId } = {}) {
    this.freq = new Tone.Signal({ value: 233, units: 'frequency' })
    // 'number', not 'normalRange': swells and accents may briefly exceed 1 (the worklet clamps).
    this.bow = new Tone.Signal({ value: 0, units: 'number' })
    this.force = new Tone.Signal({ value: 0.85, units: 'normalRange' })
    this.beta = new Tone.Signal({ value: 0.127, units: 'number' })
    this.hairRoughness = HAIR[hair].roughness
    this.rough = new Tone.Signal({ value: this.hairRoughness, units: 'number' })

    this.stringGain = new Tone.Gain(STRING_GAIN)
    this.sine = new Tone.Oscillator({ type: 'sine', volume: -6 })
    this.sineVca = new Tone.Gain(0)
    this.freq.connect(this.sine.frequency)
    this.bow.connect(this.sineVca.gain)
    this.sine.connect(this.sineVca)

    this.mix = new Tone.CrossFade(0)
    this.stringGain.connect(this.mix.a)
    this.sineVca.connect(this.mix.b)

    this.toneLp = new Tone.Filter({ type: 'lowpass', frequency: 12000, Q: 0.6, rolloff: -12 })
    this.presence = new Tone.Filter({ type: 'peaking', frequency: 3200, Q: 1.1, gain: 0 })
    this.tremGain = new Tone.Gain(1)
    this.expr = new Tone.Gain(1)
    this.trim = new Tone.Gain(1)
    this.mix.chain(this.toneLp, this.presence, this.tremGain, this.expr, this.trim, output)

    // Rosin hiss that tracks the pitch and follows the bow.
    this.noise = new Tone.Noise('pink')
    this.noiseBandFreq = new Tone.Multiply(2.2)
    this.noiseBand = new Tone.Filter({ type: 'bandpass', frequency: 600, Q: 0.9 })
    this.freq.connect(this.noiseBandFreq)
    this.noiseBandFreq.connect(this.noiseBand.frequency)
    this.noiseAmp = new Tone.Gain(0.03)
    this.noiseVca = new Tone.Gain(0)
    this.bow.connect(this.noiseVca.gain)
    this.noise.chain(this.noiseBand, this.noiseAmp, this.noiseVca, this.tremGain)

    // Depth gains add onto the modulated params (connecting a plain node sums, it doesn't override).
    // ~4.75 Hz was measured on a morin khuur recording (Zhu et al.); players vary around 5 Hz.
    this.vibLfo = new Tone.LFO({ frequency: VIBRATO_HZ, min: -1, max: 1 })
    this.vibDepth = new Tone.Gain(0)
    this.vibLfo.connect(this.vibDepth)
    this.vibDepth.connect(this.sine.detune)
    // Singers' and fiddlers' vibrato swells in level with the pitch; applied after the string.
    this.amDepth = new Tone.Gain(0)
    this.vibLfo.connect(this.amDepth)
    this.amDepth.connect(this.tremGain.gain)

    this.tremLfo = new Tone.LFO({ frequency: 13, min: -1, max: 1 })
    this.tremDepth = new Tone.Gain(0)
    this.tremLfo.connect(this.tremDepth)
    this.tremDepth.connect(this.tremGain.gain)

    this.meter = meter ? new Tone.Meter({ normalRange: true, smoothing: 0.7 }) : null
    if (this.meter) this.trim.connect(this.meter)

    this.sine.start()
    this.noise.start()
    this.vibLfo.start()
    this.tremLfo.start()

    const context = this.freq.context
    if (isDspReady(context)) this.attachString(hair)
    else void loadDsp(context).then(() => this.attachString(hair))
  }

  private attachString(hair: StringId): void {
    if (this.disposed) return
    const node = this.freq.context.createAudioWorkletNode(BOWED_STRING, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] })
    const param = (name: string) => node.parameters.get(name)!
    param('damping').value = HAIR[hair].damping
    this.freq.connect(param('frequency'))
    this.bow.connect(param('velocity'))
    this.force.connect(param('force'))
    this.beta.connect(param('beta'))
    this.rough.connect(param('roughness'))
    this.vibDepth.connect(param('detune'))
    Tone.connect(node, this.stringGain)
    this.string = node
  }

  /** 0–1 output level, for string-vibration visuals. */
  level(): number {
    const v = this.meter?.getValue()
    return typeof v === 'number' ? Math.min(1, v * 2.5) : 0
  }

  /**
   * `landing`: the bow is set onto a silent string. A player presses the hair before drawing the
   * bow, so force and contact point take their values at once — easing the force in while the
   * bow already moves under-presses the attack, and the heavier male string then locks onto its
   * octave (double slip) and stays there for the whole stroke.
   */
  private applyTimbre(t: Timbre, time: number, bright = 1, landing = false): number {
    const set = (p: Automatable, v: number, tc: number) => {
      p.cancelScheduledValues(time)
      p.setTargetAtTime(v, time, tc)
    }
    const press = (p: Automatable, v: number, tc: number) => {
      if (!landing) return set(p, v, tc)
      p.cancelScheduledValues(time)
      p.setValueAtTime(v, time)
    }
    // Short (stopped-high) strings need a little more bow force to speak cleanly.
    const force = Math.min(0.97, t.force + 0.08 * Math.log2(this.shortening()))
    press(this.force, force, 0.02)
    press(this.beta, t.beta, 0.03)
    set(this.toneLp.frequency, t.cutoff * bright, 0.03)
    set(this.noiseAmp.gain, t.noise, 0.03)
    set(this.mix.fade, t.sineMix, 0.02)
    set(this.presence.gain, t.presenceDb, 0.05)
    return force
  }

  /**
   * Live strokes (pads, keys, MIDI: scheduled for "now") reach the audio thread a render quantum or
   * more after their time, so a landing's zero would never be rendered and the rising bow would
   * catch the still-ringing string in double slip. Such a landing holds the bow off the string for
   * LANDING_HOLD; scheduled playback (25–50 ms look-ahead) and offline renders are not delayed.
   */
  private liveHold(time: number): number {
    return time - this.bow.context.currentTime < LIVE_EVENT_WINDOW ? LANDING_HOLD : 0
  }

  /** The bow has come off the string or to a stop by `time` (restingFrom). */
  private resting(time: number): boolean {
    return this.restingFrom !== null && time >= this.restingFrom
  }

  /** The bow comes off the string, or to a stop, at `time`. */
  private rest(time: number): void {
    this.restingFrom = Math.min(this.restingFrom ?? time, time)
  }

  private shortening(): number {
    return Math.max(1, this.lastFreq / this.openFreq)
  }

  /**
   * Bow timbre for this string at its current stopping height. Horsehair bow noise grows in the
   * high register, where players use it expressively (Bulanov): +3.5 dB an octave up, +6 dB two.
   */
  private timbreFor(input: BowInput, harmonic?: boolean): Timbre {
    const timbre = bowTimbre(input, harmonic)
    return { ...timbre, noise: timbre.noise * (1 + 0.5 * Math.log2(this.shortening())) }
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduled strokes (songs, sequencer, offline rendering)
  // ---------------------------------------------------------------------------------------------

  stroke(o: StrokeOptions): void {
    const t = o.time
    this.lastFreq = o.freq
    const pull = o.direction === 'tatakh'

    // Bow point: the note's own position, the shurankhai's lighter tasto colour and any drift
    // towards the bridge. The contact point is taken from the start and stays on its safe values;
    // the drift only moves the brightness.
    const shurankhai = !!o.shurankhai && !o.harmonic
    const basePosition = (o.position ?? 0) + (shurankhai ? SHURANKHAI.position : 0)
    const bowAt = (drift: number): BowInput => ({
      speed: 0.4 + 0.6 * o.velocity,
      pressure: 0.4 + 0.4 * o.velocity,
      position: clamp(basePosition + drift, -1, 1)
    })
    let timbre = this.timbreFor(bowAt(o.positionRamp?.from ?? 0), o.harmonic)
    if (shurankhai) {
      timbre = { ...timbre, force: timbre.force + SHURANKHAI.force, beta: SHURANKHAI.beta, sineMix: Math.min(1, timbre.sineMix + SHURANKHAI.sineMix) }
    }
    // Tatakh (pull) is the heavier, warmer stroke; tülekhe (push) lighter and brighter.
    const peak = Math.min(1, timbre.level * (pull ? 1 : 0.88) * (o.accent ? 1.15 : 1))
    // The bow is still drawing the string (a bow change or a slur), or it has come off or nearly
    // stopped (after a detached, abrupt or released stroke, or a gesture) and lands again.
    const bowNow = this.bow.getValueAtTime(t)
    // A stroke that starts 5 ms or more after the previous stroke's release lands, even when the
    // released bow is still above SOUNDING (fast abrupt runs: 0.08 s notes release at 0.8·d and
    // the bow is still at 0.2–0.3); taken as a bow change, the string stayed in its octave.
    const released = !o.slur && this.restingFrom !== null && t - this.restingFrom >= 0.005
    const sounding = bowNow > SOUNDING * peak && !released
    // Bow profiles shape fresh strokes only; a slurred note continues the moving bow.
    const fresh = !(o.slur && sounding)
    const abrupt = o.bowProfile === 'abrupt' && fresh
    const accentRelease = o.bowProfile === 'accent-release' && fresh
    // Even a detached (gallop) stroke needs ~10 ms to catch the string into Helmholtz motion.
    const attackTc = o.detached || abrupt ? QUICK_ATTACK_TC : pull ? 0.025 : 0.018
    // Gallop strokes sound 70% of their length, abrupt (огцом) ones 80%.
    const end = t + o.duration * (o.detached ? 0.7 : abrupt ? 0.8 : 1)

    const { trillFrom, fallFrom, strikes } = this.schedulePitch(o, t, end, sounding)

    // Bow-speed envelope. Each stroke swells slightly then eases as the bow runs out — the
    // breathing phrasing of long-song playing.
    const bow = this.bow
    bow.cancelScheduledValues(t)
    if (!fresh) {
      bow.setTargetAtTime(peak, t, 0.04)
    } else if (sounding) {
      // Bow change on a sounding string: the hair slows and turns, and the string keeps its motion.
      bow.setTargetAtTime(BOW_TURN.to * Math.max(bowNow, peak), t, BOW_TURN.timeConstant)
      bow.setTargetAtTime(peak, t + 0.02, attackTc)
    } else {
      // Landing: the bow comes down from off the string, even if it was still creeping after a
      // release, so that the string model takes the string over into Helmholtz motion as the bow's
      // speed comes up (bowed-string.worklet.js: land) instead of catching whatever it still does.
      bow.setValueAtTime(0, t)
      bow.setTargetAtTime(peak, t + this.liveHold(t), attackTc)
    }
    // Wavy bow: 2–16 accent pulses per stroke, about five a second — ease off, press the hair again.
    const pulses = o.wavy ? Math.max(2, Math.min(16, Math.round(o.duration * 5))) : 0
    const pulseTimes = Array.from({ length: Math.max(0, pulses - 1) }, (_, k) => t + ((k + 1) * (end - t)) / pulses)
    if (o.wavy) {
      const gap = (end - t) / pulses
      for (const tk of pulseTimes) {
        bow.setTargetAtTime(peak * 0.5, tk - gap * 0.35, gap * 0.12)
        bow.setTargetAtTime(Math.min(1, peak * 1.1), tk, 0.012)
      }
    } else if (o.taper) {
      // Closing stroke: dies away over its length.
      bow.setTargetAtTime(peak * 0.2, t + o.duration * 0.2, o.duration * 0.35)
    } else if (accentRelease) {
      // Accent, then the bow relaxes to 70% of its speed (tatlaga, fast passages).
      bow.setTargetAtTime(peak * 0.7, t + attackTc * 3, o.duration * 0.3)
    } else if (abrupt) {
      bow.setTargetAtTime(peak * 0.9, t + attackTc * 4, Math.max(0.03, o.duration * 0.4))
    } else if (o.duration > 0.6 && !o.detached) {
      bow.setTargetAtTime(peak * 1.08, t + o.duration * 0.25, o.duration * 0.2)
      bow.setTargetAtTime(peak * 0.82, t + o.duration * 0.6, o.duration * 0.25)
    } else {
      bow.setTargetAtTime(peak * 0.85, t + attackTc * 4, Math.max(0.05, o.duration * 0.6))
    }
    // A fall lifts the bow as the finger slides off. Nothing scheduled above may outlast the release.
    const release = fallFrom ?? end
    bow.cancelScheduledValues(release)
    bow.setTargetAtTime(0, release, o.detached || abrupt ? 0.015 : 0.03)
    this.restingFrom = release

    const force = this.applyTimbre(timbre, t, pull ? 0.92 : 1.08, !sounding)
    if (o.positionRamp) {
      // Drift of the bow point: brightness and rasp follow; force and contact point stay.
      const to = this.timbreFor(bowAt(o.positionRamp.to), o.harmonic)
      this.toneLp.frequency.setTargetAtTime(to.cutoff * (pull ? 0.92 : 1.08), t + 0.05, Math.max(0.05, o.duration / 3))
      this.presence.gain.setTargetAtTime(to.presenceDb, t + 0.05, Math.max(0.05, o.duration / 3))
    }
    // Force pushes on top of the stroke's force. On a fresh stroke a push lands with the bow (or,
    // on a bow change, once the bow has turned) and is held until the string has been caught.
    const pushFrom = fresh && sounding ? t + PUSH_TURN : t
    const push = (at: number, amount: number, hold: number, timeConstant: number, after = force) => {
      const from = fresh ? Math.max(at, pushFrom) : at
      this.force.setValueAtTime(Math.min(0.97, force + amount), from)
      this.force.setTargetAtTime(after, Math.max(from + hold, fresh ? pushFrom + PUSH_HOLD : 0), timeConstant)
    }
    // Accents come from the ring and little fingers pressing the hair (accent-release: tatlaga,
    // fast passages). An accent-release stroke lightens as its bow relaxes: kept pressed at 70% of
    // the speed, high notes approach the too-heavy edge, where a faint period doubling appears and
    // the pitch detector reads them an octave low.
    if (o.accent) push(t, 0.15, 0.05, 0.04)
    else if (accentRelease) push(t, 0.12, 0, 0.04, force - ACCENT_RELEASE_LIGHTER)
    // Hammered note: the finger strikes the string — a push of force and a click of noise.
    for (const ts of strikes) push(ts, 0.1, 0.003, 0.02)
    if (!o.slur) {
      // Rosin bite at the start of a fresh stroke.
      this.noiseAmp.gain.setValueAtTime(timbre.noise * 3, t)
      this.noiseAmp.gain.setTargetAtTime(timbre.noise, t + 0.01, 0.03)
    }
    // After applyTimbre, which clears the noise automation from `t` on.
    for (const tk of pulseTimes) {
      this.noiseAmp.gain.setValueAtTime(timbre.noise * 2.5, tk)
      this.noiseAmp.gain.setTargetAtTime(timbre.noise, tk + 0.01, 0.03)
    }
    for (const ts of strikes) {
      if (!o.slur && ts - t < 0.01) continue // merged with the rosin bite
      this.noiseAmp.gain.setValueAtTime(timbre.noise * 2, ts)
      this.noiseAmp.gain.setTargetAtTime(timbre.noise, ts + 0.005, 0.01)
    }

    this.scheduleVibrato(o, t, end, trillFrom)

    const trem = this.tremDepth.gain
    trem.cancelScheduledValues(t)
    trem.setTargetAtTime(o.tremolo ? 0.8 : 0, t, 0.01)
    if (o.tremolo) trem.setTargetAtTime(0, end, 0.02)
  }

  /**
   * Pitch path of a stroke: the written note, its onset ("bite" or legato glide) and any planned
   * left-hand ornaments. Returns when a trill and a fall begin (for the vibrato and the bow) and
   * when hammered notes strike.
   */
  private schedulePitch(o: StrokeOptions, t: number, end: number, sounding: boolean): { trillFrom: number | null; fallFrom: number | null; strikes: number[] } {
    const f = this.freq
    const main = o.freq
    const from = Number(f.getValueAtTime(t))
    f.cancelScheduledValues(t)
    // Ornaments need a stopping finger and a steady written pitch.
    const ornaments = o.harmonic || o.slideIn || o.glideTo ? [] : (o.ornaments ?? [])
    const onset = ornaments.filter((x) => x.at === 'start' && x.kind !== 'trill')
    const ornPitch = (x: PitchOrnament) => main * 2 ** (x.semitones / 12)
    const strikes: number[] = []
    // Last scheduled pitch and the time it is reached.
    let pitch = main
    let cursor = t
    const glide = (to: number, time: number, over: number) => {
      if (Math.abs(to / pitch - 1) < 1e-6) return
      f.setValueAtTime(pitch, time)
      f.exponentialRampToValueAtTime(to, time + over)
      pitch = to
      cursor = time + over
    }

    // On a sounding string (a bow change) the finger moves over FINGER_STEP rather than jumping.
    const moving = (to: number) => sounding && from > 20 && Math.abs(to / from - 1) > 1e-6
    const finger = (to: number) => FINGER_STEP * Math.max(1, 2 * Math.abs(Math.log2(to / from)))
    if (o.slideIn) {
      // Glissando into the note along the hovering string.
      const start = o.slideFrom ?? (sounding && from > 20 ? from : o.freq * 2 ** (-2 / 12))
      f.setValueAtTime(moving(start) ? from : start, t)
      if (moving(start)) f.exponentialRampToValueAtTime(start, t + finger(start))
      f.exponentialRampToValueAtTime(o.freq, t + o.slideIn)
    } else if (onset.length) {
      const first = onset[0]!
      const start = first.kind === 'mordent' ? main : ornPitch(first)
      // Fresh stroke: the bow lands on the ornament note. Slurred: the finger moves to it.
      if (!moving(start)) {
        f.setValueAtTime(start, t)
        pitch = start
      } else {
        pitch = from
        glide(start, t, o.slur ? ORNAMENT_STEP : finger(start))
      }
      for (const x of onset) {
        const orn = ornPitch(x)
        const at = cursor
        switch (x.kind) {
          case 'scoop':
          case 'shift-slide':
          case 'trot-slide':
            // Slide into the note from the ornament pitch (the previous pitch for a shift).
            glide(orn, at, ORNAMENT_STEP)
            f.setValueAtTime(pitch, cursor)
            f.exponentialRampToValueAtTime(main, cursor + x.seconds)
            pitch = main
            cursor += x.seconds
            break
          case 'hammer':
            strikes.push(at)
            glide(orn, at, 0.004)
            f.setValueAtTime(orn, at + x.seconds)
            pitch = orn
            glide(main, at + x.seconds, ORNAMENT_STEP * 0.75)
            break
          case 'grace': {
            // `seconds` covers the hold and the move to the main note.
            const move = Math.min(ORNAMENT_STEP, x.seconds / 2)
            glide(orn, at, ORNAMENT_STEP)
            f.setValueAtTime(orn, at + x.seconds - move)
            glide(main, at + x.seconds - move, move)
            break
          }
          case 'mordent':
            // Main, neighbour, main: each half of the gesture.
            glide(main, at, ORNAMENT_STEP)
            glide(orn, cursor + x.seconds / 2, ORNAMENT_STEP)
            glide(main, at + x.seconds, ORNAMENT_STEP)
            break
          default:
            break
        }
      }
    } else if (o.slur && sounding) {
      f.setTargetAtTime(o.freq, t, o.glide ? o.glide / 3 : SLUR_GLIDE_TC)
    } else {
      // A new stroke "bites" a few cents flat.
      const bite = o.freq * 2 ** (-6 / 1200)
      const at = moving(bite) ? t + finger(bite) : t
      if (at > t) {
        f.setValueAtTime(from, t)
        f.exponentialRampToValueAtTime(bite, at)
      } else f.setValueAtTime(bite, t)
      f.setTargetAtTime(o.freq, at, 0.015)
    }
    if (o.glideTo) {
      f.setValueAtTime(o.freq, t + o.duration * 0.2)
      f.exponentialRampToValueAtTime(o.glideTo, t + o.duration * 0.8)
    }

    // Release ornaments: a fall slides off as the bow lifts; an after-grace touches the neighbour.
    // Both need the note to have settled first; on shorter notes they are left out.
    const fall = ornaments.find((x) => x.kind === 'fall')
    const fallFrom = fall && end - fall.seconds > cursor + 0.02 ? end - fall.seconds : null
    const tailEnd = fallFrom ?? end
    const graceEnd = ornaments.find((x) => x.kind === 'grace' && x.at === 'end')
    const graceFrom = graceEnd && tailEnd - graceEnd.seconds - ORNAMENT_STEP > cursor + 0.02 ? tailEnd - graceEnd.seconds - ORNAMENT_STEP : null

    // Trill: stepped alternation with the upper note, whose level dips (anti-phase amplitude) on a
    // post-string gain. The bow keeps its speed: modulating it would flip the string's regime.
    const expr = this.expr.gain
    expr.cancelScheduledValues(t)
    expr.setValueAtTime(1, t)
    const trill = ornaments.find((x) => x.kind === 'trill')
    let trillFrom: number | null = null
    if (trill) {
      const rate = trill.rateHz ?? 6.5
      const half = 1 / (2 * rate)
      const upper = ornPitch(trill)
      const level = 10 ** ((trill.upperGainDb ?? 0) / 20)
      const stop = graceFrom ?? tailEnd
      let ts = Math.max(cursor + 0.02, t + (trill.at === 'end' ? (trill.from ?? 0.6) : 0) * o.duration)
      if (ts + 2 * half <= stop + 1e-6) trillFrom = ts
      for (; ts + 2 * half <= stop + 1e-6; ts += 2 * half) {
        f.setValueAtTime(main, ts)
        f.exponentialRampToValueAtTime(upper, ts + TRILL_STEP)
        f.setValueAtTime(upper, ts + half)
        f.exponentialRampToValueAtTime(main, ts + half + TRILL_STEP)
        expr.setValueAtTime(1, ts)
        expr.linearRampToValueAtTime(level, ts + TRILL_STEP)
        expr.setValueAtTime(level, ts + half)
        expr.linearRampToValueAtTime(1, ts + half + TRILL_STEP)
      }
    }
    if (graceEnd && graceFrom !== null) {
      f.setValueAtTime(main, graceFrom)
      f.exponentialRampToValueAtTime(ornPitch(graceEnd), graceFrom + ORNAMENT_STEP)
    }
    if (fall && fallFrom !== null) {
      // An after-grace ends where the fall begins: the fall slides from the neighbour.
      f.setValueAtTime(graceEnd && graceFrom !== null ? ornPitch(graceEnd) : main, fallFrom)
      f.exponentialRampToValueAtTime(ornPitch(fall), end)
    }
    return { trillFrom, fallFrom, strikes }
  }

  /**
   * Vibrato depth, rate and amplitude modulation for a stroke: the planned vibrato (shape and
   * placement), else the legacy depth with a delayed onset. A trill takes over from the vibrato.
   */
  private scheduleVibrato(o: StrokeOptions, t: number, end: number, trillFrom: number | null): void {
    // Holding (not just cancelling) keeps a previous note's automation from snapping back to an
    // older value at this note's start.
    const vib = this.vibDepth.gain
    const am = this.amDepth.gain
    const rate = this.vibLfo.frequency
    const rough = this.rough
    vib.cancelAndHoldAtTime(t)
    am.cancelAndHoldAtTime(t)
    rate.cancelScheduledValues(t)
    rough.cancelScheduledValues(t)
    rough.setTargetAtTime(this.hairRoughness, t, 0.05)
    const plan = o.harmonic ? null : (o.vibratoPlan ?? null)

    if (o.shake && o.slideIn) {
      // A shaking slide in the 6–7 Hz band of the "Mongolian trill", settling into the note's
      // vibrato — within the note, so the release at its end still applies.
      const settle = Math.min(t + o.slideIn * 1.4, end)
      rate.setValueAtTime(6.5, t)
      rate.setValueAtTime(VIBRATO_HZ, settle)
      vib.setValueAtTime(55, t)
      vib.linearRampToValueAtTime(o.vibrato ?? 0, settle)
      am.setTargetAtTime(0, t, 0.02)
    } else if (plan && plan.cents > 0 && o.duration > 0.2) {
      const d = o.duration
      const stop = Math.min(end, trillFrom ?? end)
      // Placement envelope (0–1): 'end' straight first, then vibrato; 'start' from the onset,
      // fading after half the note; 'whole' ramped in.
      const hold = t + Math.max(0.15, 0.4 * d)
      const env: [number, number][] =
        plan.placement === 'end'
          ? [
              [t, 0],
              [hold, 0],
              [hold + Math.min(0.35, 0.3 * d), 1]
            ]
          : plan.placement === 'start'
            ? [
                [t, 0],
                [t + 0.05, 1],
                [t + 0.5 * d, 1],
                [end, 0]
              ]
            : [
                [t, 0],
                [t + Math.min(WHOLE_VIBRATO_RAMP, d * 0.4), 1]
              ]
      // Depth points (cents). Nogula: irregular 150–400 ms segments, each with its own rate and
      // depth, drawn from the plan's seed (vibratoSegments) so renders are reproducible.
      const points: [number, number][] = []
      rate.setValueAtTime(plan.rateHz, t)
      if (plan.shape === 'nogula') {
        for (const s of vibratoSegments(plan, d)) {
          const ts = t + s.start
          if (ts >= stop) break
          rate.setValueAtTime(s.rateHz, ts)
          const at = Math.min(stop, ts + Math.min(0.08, s.duration / 2))
          points.push([at, s.cents * envelopeAt(env, at)])
        }
      } else {
        for (const [time, e] of env) if (time <= stop) points.push([time, e * plan.cents])
      }
      if (stop < end) points.push([stop, envelopeAt(points, stop)], [Math.min(end, stop + 0.03), 0])
      const swing = amSwing(plan.amDb) / plan.cents
      // Ease from whatever the previous note left, never a jump (a jump in depth is a pitch jump).
      const first = Math.max(t + 0.02, points[0]?.[0] ?? t)
      vib.linearRampToValueAtTime(envelopeAt(points, first), first)
      am.linearRampToValueAtTime(envelopeAt(points, first) * swing, first)
      for (const [time, cents] of points) {
        if (time <= first) continue
        vib.linearRampToValueAtTime(cents, time)
        am.linearRampToValueAtTime(cents * swing, time)
      }
      if (plan.roughnessBoost > 0) {
        const on = plan.placement === 'end' ? hold : t
        rough.setTargetAtTime(this.hairRoughness + plan.roughnessBoost, on, 0.05)
        rough.setTargetAtTime(this.hairRoughness, stop, 0.05)
      }
    } else if (o.vibrato && o.duration > 0.35) {
      rate.setValueAtTime(VIBRATO_HZ, t)
      vib.setValueAtTime(0, t)
      vib.linearRampToValueAtTime(o.vibrato, t + Math.min(0.45, o.duration * 0.5))
      am.setTargetAtTime(0, t, 0.02)
    } else {
      vib.setTargetAtTime(0, t, 0.02)
      am.setTargetAtTime(0, t, 0.02)
    }
    vib.setTargetAtTime(0, end, 0.05)
    am.setTargetAtTime(0, end, 0.05)
  }

  // ---------------------------------------------------------------------------------------------
  // Live control (bow pad, keyboard, MIDI)
  // ---------------------------------------------------------------------------------------------

  /**
   * Live bowing (bow pad, keyboard, MIDI), called again whenever the bow's speed changes. A stroke
   * drawn after the bow came off the string or to a stop lands as a scheduled one does: from
   * zero, with the force and contact point pressed, so that the string model takes the string over
   * into Helmholtz motion. Keyboard notes played detached re-bow 0.1–0.3 s after the key-up, while
   * the released bow still creeps on the string at 3–10% of its speed; caught by the rising bow
   * instead, the string started in its octave on most of them.
   */
  bowLive(input: BowInput, direction: BowDirection, time: number, harmonic = false): void {
    const timbre = this.timbreFor(input, harmonic)
    const pull = direction === 'tatakh'
    const level = timbre.level * (pull ? 1 : 0.9)
    const bowNow = this.bow.getValueAtTime(time)
    // A new stroke after the bow came off the string or to a stop, or one drawn on fast from a
    // crawl (CRAWL), lands from zero. A nearly still bow is pressed again either way (a bow pad
    // drawn from rest re-sends its speed every frame, while the bow is still coming up to it).
    const digsIn = bowNow < CRAWL && this.liveLevel < CRAWL && level > 2 * Math.max(bowNow, this.liveLevel)
    const lands = digsIn || (this.resting(time) && bowNow < SOUNDING * level)
    const landing = lands || bowNow < 0.02
    if (landing) this.resetExpression(time)
    this.bow.cancelScheduledValues(time)
    if (lands) this.bow.setValueAtTime(0, time)
    this.bow.setTargetAtTime(level, lands ? time + LANDING_HOLD : time, 0.02)
    this.applyTimbre(timbre, time, pull ? 0.92 : 1.08, landing)
    this.liveLevel = level
    // A bow held still on the string (no speed) is not drawing it: the next stroke lands again.
    if (level > 0.005) this.restingFrom = null
    else this.rest(time)
  }

  /**
   * Bow reversal while sounding: the hair slows and turns (BOW_TURN), with a rosin burst, and is
   * drawn on at the speed live bowing asked for (left at the turn's speed, the keyboard's auto-bow
   * lost half its speed at every run-out). A bow that is coming off the string has nothing to turn.
   */
  bowChange(time: number): void {
    const current = this.bow.getValueAtTime(time)
    if (current < 0.02 || this.resting(time)) return
    this.bow.cancelScheduledValues(time)
    this.bow.setTargetAtTime(current * BOW_TURN.to, time, BOW_TURN.timeConstant)
    this.bow.setTargetAtTime(this.liveLevel || current, time + 0.02, 0.02)
    this.noiseAmp.gain.setValueAtTime(0.1, time)
    this.noiseAmp.gain.setTargetAtTime(0.03, time + 0.01, 0.03)
  }

  /**
   * Stops the string at `freq`. Without a glide the finger still takes FINGER_STEP to press the
   * string down, as on a bow change: the string may still be ringing, and a jump in the loop length
   * clicks.
   */
  setPitch(freq: number, time: number, glideSeconds = 0): void {
    const from = Number(this.freq.getValueAtTime(time))
    this.lastFreq = freq
    this.freq.cancelScheduledValues(time)
    if (glideSeconds > 0) this.freq.setTargetAtTime(freq, time, glideSeconds / 3)
    else if (from > 20 && Math.abs(freq / from - 1) > 1e-6) {
      this.freq.setValueAtTime(from, time)
      this.freq.exponentialRampToValueAtTime(freq, time + FINGER_STEP * Math.max(1, 2 * Math.abs(Math.log2(freq / from))))
    } else this.freq.setValueAtTime(freq, time)
  }

  setVibrato(depthCents: number, rateHz: number, time: number): void {
    // Later rate changes go too: a stopped song's irregular (nogula) vibrato would keep firing them.
    this.vibLfo.frequency.cancelScheduledValues(time)
    this.vibLfo.frequency.setValueAtTime(rateHz, time)
    this.vibDepth.gain.cancelScheduledValues(time)
    this.vibDepth.gain.setTargetAtTime(depthCents, time, 0.08)
  }

  setTremolo(depth: number, rateHz: number, time: number): void {
    this.tremLfo.frequency.setValueAtTime(rateHz, time)
    this.tremDepth.gain.cancelScheduledValues(time)
    this.tremDepth.gain.setTargetAtTime(depth, time, 0.01)
  }

  /** Lifts the bow; the string rings down on its own. */
  release(time: number, timeConstant = 0.04): void {
    this.bow.cancelScheduledValues(time)
    this.bow.setTargetAtTime(0, time, timeConstant)
    this.rest(time)
  }

  /**
   * Clears scheduled ornament automation (trill levels, vibrato amplitude, hair roughness) from
   * `time` on — e.g. after a song stops mid-note, before the string is played live. With
   * `vibrato`, the vibrato also comes to rest (no depth, the default rate) and its scheduled depth
   * and rate changes are dropped; live bowing keeps the vibrato the player has set.
   */
  resetExpression(time: number, { vibrato = false }: { vibrato?: boolean } = {}): void {
    this.expr.gain.cancelScheduledValues(time)
    this.expr.gain.setTargetAtTime(1, time, 0.01)
    this.amDepth.gain.cancelScheduledValues(time)
    this.amDepth.gain.setTargetAtTime(0, time, 0.01)
    this.rough.cancelScheduledValues(time)
    this.rough.setTargetAtTime(this.hairRoughness, time, 0.01)
    if (vibrato) {
      this.vibDepth.gain.cancelAndHoldAtTime(time)
      this.vibDepth.gain.setTargetAtTime(0, time, 0.01)
      this.vibLfo.frequency.cancelScheduledValues(time)
      this.vibLfo.frequency.setValueAtTime(VIBRATO_HZ, time)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Raw automation access for scripted gestures (horse whinny)
  // ---------------------------------------------------------------------------------------------

  get frequency(): Tone.Signal<'frequency'> {
    return this.freq
  }

  /** Bow velocity, 0–1. */
  get envelope(): Tone.Signal<'number'> {
    return this.bow
  }

  prepareGesture(time: number, timbre: Timbre): void {
    const bowNow = this.bow.getValueAtTime(time)
    const lands = this.resting(time) && bowNow < SOUNDING * timbre.level
    const landing = lands || bowNow < 0.02
    this.resetExpression(time)
    this.freq.cancelScheduledValues(time)
    this.bow.cancelScheduledValues(time)
    if (lands) this.bow.setValueAtTime(0, time)
    this.applyTimbre(timbre, time, 1, landing)
  }

  dispose(): void {
    this.disposed = true
    if (this.string) {
      this.string.port.postMessage('dispose')
      this.string.disconnect()
    }
    for (const n of [
      this.freq,
      this.bow,
      this.force,
      this.beta,
      this.stringGain,
      this.sine,
      this.sineVca,
      this.mix,
      this.toneLp,
      this.presence,
      this.noise,
      this.noiseBandFreq,
      this.noiseBand,
      this.noiseAmp,
      this.noiseVca,
      this.rough,
      this.vibLfo,
      this.vibDepth,
      this.amDepth,
      this.tremLfo,
      this.tremDepth,
      this.tremGain,
      this.expr,
      this.trim,
      ...(this.meter ? [this.meter] : [])
    ]) {
      n.dispose()
    }
  }
}
