/**
 * Numbered musical notation (jianpu / "тоон нот"), widely used to teach Morin Khuur.
 * Degrees are relative to the song's key; dots above/below mark octaves; underlines shorten
 * the value (one = eighth, two = sixteenth) and dashes lengthen it.
 */

import { quartersPerBar } from './timing'
import type { Song, SongNote } from './types'

export interface JianpuSymbol {
  /** "1"–"7", "0" for a rest, "×" for unpitched percussion. */
  degree: string
  accidental: '' | '#' | 'b'
  /** Octave dots: positive above, negative below. */
  octave: number
  underlines: number
  dashes: number
  dotted: boolean
}

export type JianpuItem = { kind: 'note'; note: SongNote; symbol: JianpuSymbol } | { kind: 'rest'; startBeats: number; symbol: JianpuSymbol }

export interface JianpuMeasure {
  index: number
  items: JianpuItem[]
}

// Chromatic offset from the tonic → degree and accidental.
const DEGREES: readonly [string, JianpuSymbol['accidental']][] = [
  ['1', ''],
  ['1', '#'],
  ['2', ''],
  ['3', 'b'],
  ['3', ''],
  ['4', ''],
  ['4', '#'],
  ['5', ''],
  ['5', '#'],
  ['6', ''],
  ['7', 'b'],
  ['7', '']
]

/** Picks the octave for degree "1" so the largest number of notes need no octave dots. */
export function referenceTonic(pitches: number[], tonicPc: number): number {
  if (pitches.length === 0) return 60 + tonicPc
  const candidates: number[] = []
  const lo = Math.min(...pitches) - 12
  for (let m = lo - (((lo - tonicPc) % 12) + 12) % 12; m <= Math.max(...pitches); m += 12) candidates.push(m)
  let best = candidates[0]!
  let bestCount = -1
  for (const c of candidates) {
    const count = pitches.filter((p) => p >= c && p < c + 12).length
    if (count > bestCount) {
      best = c
      bestCount = count
    }
  }
  return best
}

export function degreeOf(midi: number, referenceTonicMidi: number): Pick<JianpuSymbol, 'degree' | 'accidental' | 'octave'> {
  const rel = midi - referenceTonicMidi
  const octave = Math.floor(rel / 12)
  const [degree, accidental] = DEGREES[((rel % 12) + 12) % 12]!
  return { degree, accidental, octave }
}

/** Duration in quarter-note beats → underlines, dashes and augmentation dot. */
export function durationMarks(beats: number): Pick<JianpuSymbol, 'underlines' | 'dashes' | 'dotted'> {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.02
  if (beats >= 2 - 0.02) return { underlines: 0, dashes: Math.max(1, Math.round(beats) - 1), dotted: false }
  if (near(beats, 1.5)) return { underlines: 0, dashes: 0, dotted: true }
  if (beats >= 1 - 0.02) return { underlines: 0, dashes: 0, dotted: false }
  if (near(beats, 0.75)) return { underlines: 1, dashes: 0, dotted: true }
  if (beats >= 0.5 - 0.02 || near(beats, 1 / 3)) return { underlines: 1, dashes: 0, dotted: false }
  if (beats >= 0.25 - 0.02) return { underlines: 2, dashes: 0, dotted: false }
  return { underlines: 3, dashes: 0, dotted: false }
}

/** Lays the song out bar by bar, inserting rests for silent gaps of an eighth or more. */
export function jianpuMeasures(song: Song): JianpuMeasure[] {
  const perBar = quartersPerBar(song.timeSignature)
  const tonicPc = song.keyPc ?? song.tuning.male % 12
  const pitches = song.notes.map((n) => n.pitch).filter((p): p is number => p !== null)
  const ref = referenceTonic(pitches, tonicPc)

  const barCount = Math.max(1, Math.ceil((song.lengthBeats - 1e-6) / perBar))
  const measures: JianpuMeasure[] = Array.from({ length: barCount }, (_, index) => ({ index, items: [] }))
  const barOf = (beats: number) => Math.min(barCount - 1, Math.floor(beats / perBar + 1e-6))

  const pushRest = (start: number, length: number) => {
    // Rests are split at bar lines so every measure stays self-contained.
    let t = start
    const end = start + length
    while (end - t >= 0.5 - 1e-6) {
      const barEnd = (barOf(t) + 1) * perBar
      const len = Math.min(end, barEnd) - t
      if (len >= 0.5 - 1e-6) {
        measures[barOf(t)]!.items.push({ kind: 'rest', startBeats: t, symbol: { degree: '0', accidental: '', octave: 0, ...durationMarks(len) } })
      }
      t += len
    }
  }

  let cursor = 0
  for (const note of song.notes) {
    if (note.startBeats > cursor + 1e-6) pushRest(cursor, note.startBeats - cursor)
    const symbol: JianpuSymbol =
      note.pitch === null
        ? { degree: '×', accidental: '', octave: 0, ...durationMarks(note.durationBeats) }
        : { ...degreeOf(note.pitch, ref), ...durationMarks(note.durationBeats) }
    measures[barOf(note.startBeats)]!.items.push({ kind: 'note', note, symbol })
    cursor = Math.max(cursor, note.startBeats + note.durationBeats)
  }
  return measures
}
