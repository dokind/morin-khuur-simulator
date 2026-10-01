import * as Tone from 'tone'
import { harmonicNearStop, openMidi, otherString, type HarmonicNode, type StringId, type Tuning } from '@renderer/core/instrument'
import { midiToFreq } from '@renderer/core/pitch'
import { oppositeBow, type BowDirection } from '@renderer/core/techniques'
import type { BowInput } from './bowed-voice'
import type { MorinKhuur } from './morin-khuur'

export interface PerformerState {
  activeString: StringId
  /** Current stop per string in semitones (0 = open). */
  stops: Record<StringId, number>
  /** Light-touch harmonic per string, when playing tsatsal. */
  harmonics: Record<StringId, HarmonicNode | null>
  /** Which strings the bow is currently drawing. */
  bowed: Record<StringId, boolean>
  direction: BowDirection
  bowSpeed: number
  drone: boolean
  pizzicato: boolean
  tremolo: boolean
  /** Erkhii darakh: stopped notes are played with the thumb instead of a fingernail. */
  thumb: boolean
}

interface HeldNote {
  string: StringId
  stop: number
  harmonic: boolean
}

/** Bow hair length in seconds of continuous auto-bowing before the bow must change direction. */
const AUTO_BOW_SECONDS = 3.2
const FINGER_SLIDE = 0.02

/**
 * Live-playing controller for the Playground. Maps keys, clicks and the bow pad onto the
 * instrument with physical rules: legato keys slur in one bow, lifting a finger returns the string
 * to open while the bow keeps sounding, open strings get no vibrato, and the bow runs out.
 */
export class LivePerformer {
  private readonly listeners = new Set<() => void>()
  private held = new Map<string, HeldNote>()
  private padBowing = false
  private padInput: BowInput = { speed: 0, pressure: 0.55, position: 0 }
  private autoBow = false
  private autoBowTimer: number | null = null
  private vibratoDepth = 18
  private vibratoBoost = false
  private state: PerformerState

  /** Defaults for keyboard/auto bowing. */
  bowPressure = 0.55
  bowPosition = 0
  velocity = 0.75

  constructor(private readonly kh: MorinKhuur) {
    this.state = {
      activeString: 'female',
      stops: { male: 0, female: 0 },
      harmonics: { male: null, female: null },
      bowed: { male: false, female: false },
      direction: 'tülekhe',
      bowSpeed: 0,
      drone: false,
      pizzicato: false,
      tremolo: false,
      thumb: false
    }
  }

  // --- observable state for the UI ---------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): PerformerState => this.state

  private update(patch: Partial<PerformerState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  private get tuning(): Tuning {
    return this.kh.tuning
  }

  private get now(): number {
    return Tone.immediate()
  }

  setTuning(tuning: Tuning): void {
    this.kh.tuning = tuning
    for (const s of ['male', 'female'] as const) this.applyPitch(s, 0)
  }

  // --- pitch -------------------------------------------------------------------------------

  private freqFor(string: StringId, stop: number, harmonic: HarmonicNode | null): number {
    const open = midiToFreq(openMidi(this.tuning, string))
    return harmonic ? open * harmonic.partial : open * 2 ** (stop / 12)
  }

  private applyPitch(string: StringId, glide: number): void {
    const stop = this.state.stops[string]
    const harmonic = this.state.harmonics[string]
    this.kh.voices[string].setPitch(this.freqFor(string, stop, harmonic), this.now, glide)
    this.applyVibrato(string)
  }

  private applyVibrato(string: StringId): void {
    // Automatic vibrato only on stopped notes; the vibrato key (V) works on open strings too, as
    // taught. Harmonics are left pure.
    const stopped = this.state.stops[string] > 0 && !this.state.harmonics[string]
    const depth = this.state.harmonics[string] ? 0 : this.vibratoBoost ? this.vibratoDepth * 2.6 : stopped ? this.vibratoDepth : 0
    this.kh.voices[string].setVibrato(depth, this.vibratoBoost ? 6 : 5, this.now)
  }

  private setStop(string: StringId, stop: number, harmonic: boolean): void {
    const node = harmonic ? harmonicNearStop(stop) : null
    const sounding = this.state.bowed[string]
    this.update({
      stops: { ...this.state.stops, [string]: stop },
      harmonics: { ...this.state.harmonics, [string]: node }
    })
    this.applyPitch(string, sounding ? FINGER_SLIDE : 0)
  }

  // --- bowing ------------------------------------------------------------------------------

  private bowStrings(): StringId[] {
    const a = this.state.activeString
    return this.state.drone ? [a, otherString(a)] : [a]
  }

  private drawBow(input: BowInput): void {
    const strings = this.bowStrings()
    const bowed: Record<StringId, boolean> = { male: false, female: false }
    for (const s of strings) {
      const scaled = s === this.state.activeString ? input : { ...input, speed: input.speed * 0.8 }
      // The thumb pad damps a little more than a fingernail: bow as if slightly towards the neck.
      const thumbed = this.state.thumb && this.state.stops[s] > 0
      this.kh.voices[s].bowLive(thumbed ? { ...scaled, position: scaled.position - 0.25 } : scaled, this.state.direction, this.now, this.state.harmonics[s] !== null)
      bowed[s] = input.speed > 0.01
    }
    for (const s of ['male', 'female'] as const) {
      if (!strings.includes(s) && this.state.bowed[s]) this.kh.voices[s].release(this.now, 0.05)
    }
    this.update({ bowed, bowSpeed: input.speed })
  }

  private changeDirection(direction: BowDirection): void {
    if (direction === this.state.direction) return
    for (const s of this.bowStrings()) this.kh.voices[s].bowChange(this.now)
    this.update({ direction })
  }

  private stopBow(): void {
    for (const s of ['male', 'female'] as const) this.kh.voices[s].release(this.now, 0.07)
    this.update({ bowed: { male: false, female: false }, bowSpeed: 0 })
  }

  private startAutoBow(newStroke: boolean): void {
    if (this.padBowing) return
    if (newStroke || !this.autoBow) this.changeDirection(oppositeBow(this.state.direction))
    this.autoBow = true
    this.drawBow({ speed: 0.35 + 0.55 * this.velocity, pressure: this.bowPressure, position: this.bowPosition })
    this.scheduleBowRunOut()
  }

  private scheduleBowRunOut(): void {
    if (this.autoBowTimer !== null) window.clearTimeout(this.autoBowTimer)
    this.autoBowTimer = window.setTimeout(() => {
      if (!this.autoBow || this.padBowing) return
      this.changeDirection(oppositeBow(this.state.direction))
      this.scheduleBowRunOut()
    }, AUTO_BOW_SECONDS * 1000)
  }

  private endAutoBow(): void {
    this.autoBow = false
    if (this.autoBowTimer !== null) window.clearTimeout(this.autoBowTimer)
    this.autoBowTimer = null
    if (!this.padBowing) this.stopBow()
  }

  /** Bow pad / arrow keys. Speed 0 while held keeps the hair on the string, silently. */
  bowPad(input: BowInput, direction: BowDirection): void {
    if (this.autoBow) this.endAutoBow()
    this.padBowing = true
    this.padInput = input
    this.changeDirection(direction)
    this.drawBow(input)
  }

  bowPadEnd(): void {
    this.padBowing = false
    this.stopBow()
    if (this.held.size > 0 && !this.state.pizzicato) this.startAutoBow(true)
  }

  // --- notes -------------------------------------------------------------------------------

  noteOn(id: string, string: StringId, stop: number, { harmonic = false, velocity }: { harmonic?: boolean; velocity?: number } = {}): void {
    if (velocity !== undefined) this.velocity = velocity
    const legato = this.held.size > 0 && this.autoBow
    const stringChanged = string !== this.state.activeString
    this.held.set(id, { string, stop, harmonic })
    if (stringChanged) this.update({ activeString: string })
    this.setStop(string, stop, harmonic)

    if (this.state.pizzicato) {
      this.kh.pluck(string, this.freqFor(string, stop, this.state.harmonics[string]), this.now, this.velocity)
      return
    }
    if (this.padBowing) {
      // The bow is already moving: crossing to the new string, fingers change underneath.
      if (stringChanged) this.drawBow(this.padInput)
      return
    }
    this.startAutoBow(!legato)
  }

  noteOff(id: string): void {
    const note = this.held.get(id)
    if (!note) return
    this.held.delete(id)
    if (this.state.pizzicato) return

    // Fall back to the most recent note still held on the same string, else lift to open.
    const remaining = [...this.held.values()].filter((n) => n.string === note.string)
    const fallback = remaining[remaining.length - 1]
    this.setStop(note.string, fallback?.stop ?? 0, fallback?.harmonic ?? false)

    if (this.held.size === 0 && this.autoBow) this.endAutoBow()
    else if (this.held.size > 0 && note.string === this.state.activeString && !fallback) {
      const last = [...this.held.values()].pop()!
      this.update({ activeString: last.string })
      if (this.autoBow) this.drawBow({ speed: 0.35 + 0.55 * this.velocity, pressure: this.bowPressure, position: this.bowPosition })
    }
  }

  allNotesOff(): void {
    this.held.clear()
    this.endAutoBow()
    this.padBowing = false
    this.stopBow()
    this.update({ stops: { male: 0, female: 0 }, harmonics: { male: null, female: null } })
  }

  // --- expression & techniques -------------------------------------------------------------

  setDrone(drone: boolean): void {
    this.update({ drone })
    if (this.padBowing) this.drawBow(this.padInput)
    else if (this.autoBow) this.drawBow({ speed: 0.35 + 0.55 * this.velocity, pressure: this.bowPressure, position: this.bowPosition })
  }

  setThumb(thumb: boolean): void {
    this.update({ thumb })
  }

  setPizzicato(pizzicato: boolean): void {
    if (pizzicato) this.endAutoBow()
    this.update({ pizzicato })
  }

  /** Wavy bow (live): accent pulses from the fingers pressing the hair, about six a second. */
  setWavy(on: boolean): void {
    if (this.state.tremolo) return
    for (const s of ['male', 'female'] as const) this.kh.voices[s].setTremolo(on ? 0.45 : 0, 6, this.now)
  }

  setTremolo(on: boolean): void {
    this.update({ tremolo: on })
    for (const s of ['male', 'female'] as const) this.kh.voices[s].setTremolo(on ? 0.8 : 0, 13, this.now)
    if (on && !this.padBowing && !this.autoBow) {
      this.autoBow = true
      this.drawBow({ speed: 0.7, pressure: this.bowPressure, position: this.bowPosition })
    } else if (!on && this.autoBow && this.held.size === 0) {
      this.endAutoBow()
    }
  }

  setBowPosition(position: number): void {
    this.bowPosition = position
  }

  setVibratoDepth(cents: number): void {
    this.vibratoDepth = cents
    for (const s of ['male', 'female'] as const) this.applyVibrato(s)
  }

  setVibratoBoost(on: boolean): void {
    this.vibratoBoost = on
    for (const s of ['male', 'female'] as const) this.applyVibrato(s)
  }

  private currentFreq(string: StringId): number {
    return this.freqFor(string, this.state.stops[string], this.state.harmonics[string])
  }

  pluck(): void {
    const s = this.state.activeString
    this.kh.pluck(s, this.currentFreq(s), this.now, this.velocity)
  }

  /** Tsokhilgo: snap a left-hand finger onto the active string at its current stop. */
  fingerStrike(): void {
    const s = this.state.activeString
    this.kh.fingerStrike(this.currentFreq(s), this.now, this.velocity)
  }

  colLegno(): void {
    this.kh.strikeColLegno(this.currentFreq(this.state.activeString), this.now, this.velocity)
  }

  slap(): void {
    this.kh.strikeSlap(this.currentFreq(this.state.activeString), this.now, this.velocity)
  }

  bodyTap(): void {
    this.kh.bodyTap(this.now, this.velocity)
  }

  whinny(): void {
    this.kh.whinny(this.now, this.currentFreq('female'), 1)
  }

  dispose(): void {
    this.allNotesOff()
    this.listeners.clear()
  }
}
