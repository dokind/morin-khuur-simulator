import * as Tone from 'tone'
import { DEFAULT_TUNING, openMidi, otherString, type StringId, type Tuning } from '@renderer/core/instrument'
import { midiToFreq } from '@renderer/core/pitch'
import { isGlissando } from '@renderer/core/techniques'
import { Soundbox, type Soundboard } from './body'
import { BowedVoice } from './bowed-voice'
import { whinnyGesture } from './gestures'
import type { NoteEvent, WhinnyVariant } from './song-events'
import { BodyKnock, ColLegno, Pluck, StringSlap } from './strikes'

export type { NoteEvent } from './song-events'

/** Default vibrato depth (cents). Erhu-family vibrato is wider than the violin's. */
const DEFAULT_VIBRATO_CENTS = 28

/**
 * The full instrument: two bowed strings through one soundbox, plus pizzicato, col legno,
 * slaps, knuckle taps and the horse-whinny gesture. Constructed against the current Tone context,
 * so the same class renders live and inside Tone.Offline.
 */
export class MorinKhuur {
  readonly voices: Record<StringId, BowedVoice>
  private readonly body: Soundbox
  private readonly plucks: Record<StringId, Pluck>
  private readonly hammer: Pluck
  private readonly colLegno: ColLegno
  private readonly slap: StringSlap
  private readonly knock: BodyKnock
  private readonly out: Tone.Gain
  private currentTuning: Tuning = DEFAULT_TUNING
  /** When each string's automatic drone stroke ends, so consecutive drone notes continue it. */
  private readonly droneUntil: Record<StringId, number> = { male: -1, female: -1 }
  vibratoCents = DEFAULT_VIBRATO_CENTS

  /** Wooden (modern) or hide (traditional) soundboard. */
  get soundboard(): Soundboard {
    return this.body.soundboard
  }

  set soundboard(soundboard: Soundboard) {
    this.body.soundboard = soundboard
  }

  get tuning(): Tuning {
    return this.currentTuning
  }

  set tuning(tuning: Tuning) {
    this.currentTuning = tuning
    this.voices.male.openFreq = midiToFreq(tuning.male)
    this.voices.female.openFreq = midiToFreq(tuning.female)
  }

  constructor(output: Tone.InputNode, { meters = false }: { meters?: boolean } = {}) {
    this.out = new Tone.Gain(1).connect(output)
    this.body = new Soundbox(this.out)
    this.voices = {
      male: new BowedVoice(this.body.input, { meter: meters, hair: 'male' }),
      female: new BowedVoice(this.body.input, { meter: meters, hair: 'female' })
    }
    this.plucks = { male: new Pluck(this.body.input), female: new Pluck(this.body.input) }
    // Tsokhilgo: a left-hand finger snapped onto the string — short, bright, lots of contact click.
    this.hammer = new Pluck(this.body.input, { decay: 0.22, brightness: 2.6, click: 0.9 })
    this.colLegno = new ColLegno(this.body.input)
    this.slap = new StringSlap(this.body.input)
    this.knock = new BodyKnock(this.body.input)
    this.tuning = DEFAULT_TUNING
    this.voices.male.setPitch(midiToFreq(this.tuning.male), 0)
    this.voices.female.setPitch(midiToFreq(this.tuning.female), 0)
  }

  /** Instrument output before the room, e.g. for recording a take in isolation. */
  get output(): Tone.Gain {
    return this.out
  }

  openFreq(string: StringId): number {
    return midiToFreq(openMidi(this.tuning, string))
  }

  levels(): Record<StringId, number> {
    return { male: this.voices.male.level(), female: this.voices.female.level() }
  }

  pluck(string: StringId, freq: number, time: number, velocity = 0.8): void {
    this.plucks[string].trigger(freq, time, velocity)
  }

  fingerStrike(freq: number, time: number, velocity = 0.8): void {
    this.hammer.trigger(freq, time, velocity)
  }

  strikeColLegno(freq: number, time: number, velocity = 0.8): void {
    this.colLegno.trigger(freq, time, velocity)
  }

  strikeSlap(freq: number, time: number, velocity = 0.8): void {
    this.slap.trigger(freq, time, velocity)
  }

  bodyTap(time: number, velocity = 0.9): void {
    this.knock.trigger(time, velocity)
  }

  /** Horse whinny (moriin insee) — always on the female string. */
  whinny(time: number, startFreq = this.openFreq('female'), duration = 1, variant?: WhinnyVariant): void {
    whinnyGesture(this.voices.female, time, startFreq, duration, variant)
  }

  /**
   * A framing stroke: both open strings under one bow — om zee's "inhale, exhale" pull and push,
   * a long-song prelude swell, or a closing stroke that dies away.
   */
  private playFrame(e: NoteEvent, time: number): void {
    for (const s of ['male', 'female'] as const) {
      this.droneUntil[s] = -1
      this.voices[s].stroke({ time, duration: e.duration, freq: this.openFreq(s), velocity: e.velocity, direction: e.bow ?? 'tatakh', vibrato: 0, taper: e.frame === 'coda' })
    }
  }

  /** Sounds one notated event at `time` (seconds on the current context clock). */
  play(e: NoteEvent, time: number): void {
    if (e.frame) return this.playFrame(e, time)
    const string = e.string ?? 'female'
    const freq = e.freq ?? this.openFreq(string)
    const bow = e.bow ?? 'tatakh'
    switch (e.technique) {
      case 'pizzicato':
        return this.pluck(string, freq, time, e.velocity)
      case 'tsokhilgo':
        return this.fingerStrike(freq, time, e.velocity)
      case 'col_legno':
        return this.strikeColLegno(freq, time, e.velocity)
      case 'string_slap':
        return this.strikeSlap(freq, time, e.velocity)
      case 'body_tap':
        return this.bodyTap(time, e.velocity)
      case 'horse_whinny':
        return this.whinny(time, freq, e.duration, e.whinny)
      default:
        break
    }

    const harmonic = e.technique === 'tsatsal_harmonic' || e.technique === 'artificial_harmonic'
    // The thumb pad (erkhii darakh) damps a little more than a fingernail: slightly darker.
    const position = e.technique === 'sul_ponticello' ? 1 : e.technique === 'sul_tasto' ? -1 : e.technique === 'erkhii_darakh' ? -0.25 : (e.position ?? 0)
    const glide = isGlissando(e.technique)
    const notatedSlide = !glide || e.glideTo ? undefined : e.technique === 'shuvtrakh_glissando' ? 0.06 : e.technique === 'shigshikh_glissando' ? 0.28 : 0.2
    const scoop = !notatedSlide && e.scoop && e.scoop.semitones > 0 ? e.scoop : null
    const slideIn = notatedSlide ?? scoop?.seconds
    // Notated vibrato applies anywhere (it is taught on open strings too). Unmarked long stopped
    // notes get a little by default, wider the longer the note (vibrato widens in slow music).
    // A performance plan decides for itself; notated vibrato is never dropped.
    const isOpen = Math.abs(freq / this.openFreq(string) - 1) < 1e-3
    const breadth = 0.7 + 0.5 * Math.min(1, e.duration / 1.5)
    const notated = e.vibrato || e.technique === 'vibrato'
    const planned = e.vibratoPlan !== undefined
    const vibrato = harmonic ? 0 : notated ? this.vibratoCents * 1.3 * breadth : !planned && !isOpen && e.duration > 0.9 ? this.vibratoCents * 0.5 * breadth : 0
    const vibratoPlan = e.vibratoPlan && !harmonic ? { ...e.vibratoPlan, cents: (e.vibratoPlan.cents * this.vibratoCents) / DEFAULT_VIBRATO_CENTS } : null
    const stroke = {
      time,
      duration: e.duration,
      velocity: e.velocity,
      direction: bow,
      slur: e.slur,
      harmonic,
      position,
      tremolo: e.tremolo || e.technique === 'tremolo',
      accent: e.accent || e.technique === 'shuvtrakh_glissando',
      detached: e.technique === 'gallop',
      wavy: e.wavy,
      bowProfile: e.bowProfile
    }
    this.voices[string].stroke({
      ...stroke,
      freq,
      vibrato,
      glideTo: glide ? (e.glideTo ?? undefined) : undefined,
      slideIn,
      slideFrom: scoop ? freq * 2 ** (-scoop.semitones / 12) : undefined,
      glide: e.glide ?? undefined,
      shake: e.technique === 'shigshikh_glissando',
      ornaments: notatedSlide ? undefined : e.ornaments,
      vibratoPlan,
      positionRamp: e.positionRamp ?? null,
      shurankhai: e.shurankhai
    })
    const other = otherString(string)
    if (e.technique === 'double_stop') {
      this.droneUntil[other] = -1
      this.voices[other].stroke({ ...stroke, velocity: e.velocity * 0.75, freq: e.droneFreq ?? this.openFreq(other), vibrato: 0 })
    } else if (e.droneLevel) {
      // Automatic drone under the melody: the bow also draws the other, open string. Consecutive
      // drone notes continue one sounding drone instead of re-attacking it (detached strokes, which
      // lift the bow before the next note, still re-attack).
      const voice = this.voices[other]
      const continuing = Math.abs(time - this.droneUntil[other]) < 0.08 && voice.envelope.getValueAtTime(time) > 0.02
      voice.stroke({ ...stroke, slur: continuing, harmonic: false, velocity: e.velocity * e.droneLevel, freq: this.openFreq(other), vibrato: 0 })
      this.droneUntil[other] = time + e.duration
    }
    if (!e.droneLevel) this.droneUntil[other] = -1
    this.droneUntil[string] = -1
  }

  /** Immediately silences both strings (transport stop). */
  silence(time = Tone.immediate()): void {
    for (const s of ['male', 'female'] as const) {
      this.droneUntil[s] = -1
      this.voices[s].release(time, 0.03)
      this.voices[s].setTremolo(0, 13, time)
      this.voices[s].resetExpression(time, { vibrato: true })
    }
  }

  dispose(): void {
    this.voices.male.dispose()
    this.voices.female.dispose()
    this.plucks.male.dispose()
    this.plucks.female.dispose()
    this.hammer.dispose()
    this.colLegno.dispose()
    this.slap.dispose()
    this.knock.dispose()
    this.body.dispose()
    this.out.dispose()
  }
}
