/**
 * Accompaniment generators for the Studio's backing tracks. Mongolian folk accompaniment leans
 * on drones and fifths rather than chord changes, so every part is built from the tonic, its
 * fifth and (for khöömii) the natural overtone series of a single drone.
 */

import type { StringId } from './instrument'
import type { BowDirection } from './techniques'

export type StudioMeter = '6/8' | '4/4'

export interface ArrangementSpec {
  meter: StudioMeter
  bpm: number
  bars: number
  /** MIDI note of the tonic in the fiddle's register (e.g. B♭3 = 58). */
  tonic: number
}

export interface PartNote {
  /** Seconds from the start of the arrangement. */
  start: number
  duration: number
  midi: number
  velocity: number
}

export interface BowedPartNote extends PartNote {
  string: StringId
  bow: BowDirection
  slur: boolean
}

export interface OvertoneNote {
  start: number
  duration: number
  /** Harmonic number of the drone that the whistle (isgeree) sings. */
  partial: number
}

const quarter = (bpm: number) => 60 / bpm

export function barSeconds(spec: Pick<ArrangementSpec, 'meter' | 'bpm'>): number {
  return (spec.meter === '6/8' ? 3 : 4) * quarter(spec.bpm)
}

/**
 * Morin khuur rhythm track: galloping bowing on the open strings.
 * 6/8 — pull, push, push-slurred per dotted quarter (the "down-up-up" hoof pattern);
 * 4/4 — Töwöö dotted-eighth / sixteenth pairs.
 */
export function rhythmPart(spec: ArrangementSpec, tuning: { male: number; female: number }): BowedPartNote[] {
  const notes: BowedPartNote[] = []
  const q = quarter(spec.bpm)
  const bar = barSeconds(spec)
  for (let b = 0; b < spec.bars; b++) {
    const t0 = b * bar
    if (spec.meter === '6/8') {
      for (let beat = 0; beat < 2; beat++) {
        const string: StringId = (b + beat) % 2 === 0 ? 'male' : 'female'
        const midi = string === 'male' ? tuning.male : tuning.female
        const e = q / 2
        const start = t0 + beat * 3 * e
        notes.push({ start, duration: e, midi, velocity: 0.85, string, bow: 'tatakh', slur: false })
        notes.push({ start: start + e, duration: e, midi, velocity: 0.5, string, bow: 'tülekhe', slur: false })
        notes.push({ start: start + 2 * e, duration: e, midi, velocity: 0.6, string, bow: 'tülekhe', slur: true })
      }
    } else {
      for (let beat = 0; beat < 4; beat++) {
        const string: StringId = beat % 2 === 0 ? 'male' : 'female'
        const midi = string === 'male' ? tuning.male : tuning.female
        const start = t0 + beat * q
        notes.push({ start, duration: q * 0.75, midi, velocity: 0.8, string, bow: 'tatakh', slur: false })
        notes.push({ start: start + q * 0.75, duration: q * 0.25, midi, velocity: 0.5, string, bow: 'tülekhe', slur: false })
      }
    }
  }
  return notes
}

/** Tovshuur lute ostinato: tonic–fifth strums an octave below the fiddle. */
export function tovshuurPart(spec: ArrangementSpec): PartNote[] {
  const notes: PartNote[] = []
  const q = quarter(spec.bpm)
  const bar = barSeconds(spec)
  const root = spec.tonic - 12
  const fifth = root + 7
  const octave = root + 12
  // [offset in quarter notes, interval note, velocity]
  const cell: [number, number, number][] =
    spec.meter === '6/8'
      ? [
          [0, root, 0.9],
          [0.5, fifth, 0.5],
          [1, octave, 0.6],
          [1.5, root, 0.8],
          [2, fifth, 0.5],
          [2.5, octave, 0.6]
        ]
      : [
          [0, root, 0.9],
          [1, fifth, 0.55],
          [1.5, octave, 0.5],
          [2, root, 0.8],
          [3, fifth, 0.55],
          [3.5, fifth, 0.45]
        ]
  const barQuarters = spec.meter === '6/8' ? 3 : 4
  for (let b = 0; b < spec.bars; b++) {
    cell.forEach(([offset, midi, velocity], i) => {
      // Let each strum ring until just before the next one (or the bar line).
      const next = cell[i + 1]?.[0] ?? barQuarters
      notes.push({ start: b * bar + offset * q, duration: (next - offset) * q * 0.95, midi, velocity })
    })
  }
  return notes
}

/** Khöömii: one low drone for the whole piece plus a slow whistled overtone melody. */
export function khoomiiPart(spec: ArrangementSpec): { drone: PartNote; overtones: OvertoneNote[] } {
  const bar = barSeconds(spec)
  const total = spec.bars * bar
  // Drone two octaves below the tonic, clamped to a low male voice (≈ 80–140 Hz).
  let drone = spec.tonic - 24
  while (drone < 40) drone += 12
  while (drone > 49) drone -= 12
  const melody = [8, 9, 10, 9, 8, 6, 8, 10, 12, 10, 9, 8]
  const overtones: OvertoneNote[] = []
  const each = bar
  for (let i = 0, t = bar; t < total - bar * 0.5; i++, t += each) {
    overtones.push({ start: t, duration: each * 0.95, partial: melody[i % melody.length]! })
  }
  return { drone: { start: 0, duration: total, midi: drone, velocity: 0.8 }, overtones }
}
