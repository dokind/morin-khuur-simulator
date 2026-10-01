/**
 * Physical model of the two-string Morin Khuur (see MORIN_KHUUR_FOUNDATION_SPEC.md §2–3).
 *
 * The strings hover in the air with no fingerboard; the left hand stops them from the SIDE with
 * the fingernail or cuticle groove. Stop positions therefore follow ideal string physics:
 * stopping at fraction f of the vibrating length from the nut raises pitch by -12·log2(1 − f).
 */

export type StringId = 'male' | 'female'
export const STRING_IDS: readonly StringId[] = ['male', 'female']

export const STRING_INFO: Record<StringId, { name: string; cyrillic: string; role: string; hairs: number }> = {
  male: { name: 'Arga', cyrillic: 'Эр утас', role: 'Male · bass', hairs: 130 },
  female: { name: 'Bilag', cyrillic: 'Эм утас', role: 'Female · treble', hairs: 105 }
}

export interface Tuning {
  id: string
  name: string
  /** Open-string MIDI notes. */
  male: number
  female: number
  /** Pitch class (0–11) used as the tonic for scale-based stop pads. */
  scaleTonic: number
}

export const TUNINGS: readonly Tuning[] = [
  // Spec §2 and Mongolian practice: Arga F3, Bilag B♭3, a fourth apart ("small octave" F and B♭).
  // Tonic B♭ reproduces the stop pads in the playground mockup.
  { id: 'standard', name: 'Standard F–B♭ (Mongolia)', male: 53, female: 58, scaleTonic: 10 },
  // Inner Mongolian "reverse fourth": thick string G3, thin string C4.
  { id: 'inner-mongolian', name: 'Inner Mongolian G–C', male: 55, female: 60, scaleTonic: 7 },
  // Traditionally the strings were tuned a fifth apart; E♭–B♭ is still used, and the spec and plan
  // list the folk fifths C–G and F–C.
  { id: 'fifth-eb', name: 'Fifth E♭–B♭', male: 51, female: 58, scaleTonic: 10 },
  { id: 'folk', name: 'Folk fifth C–G', male: 48, female: 55, scaleTonic: 0 },
  { id: 'folk-fc', name: 'Folk fifth F–C', male: 53, female: 60, scaleTonic: 5 }
]

export const DEFAULT_TUNING = TUNINGS[0]!

export function getTuning(id: string): Tuning {
  return TUNINGS.find((t) => t.id === id) ?? DEFAULT_TUNING
}

export function openMidi(tuning: Tuning, string: StringId): number {
  return string === 'male' ? tuning.male : tuning.female
}

export function otherString(string: StringId): StringId {
  return string === 'male' ? 'female' : 'male'
}

/**
 * Highest stop (in semitones above the open string) the simulator models on either string. The
 * instrument's range is about three octaves, F3–F6: two octaves of stops on the B♭ string (~44 cm of
 * usable neck) plus harmonics above.
 */
export const MAX_STOP = 24

/** Upper-to-lower bridge vibrating length (sources: 54–60 cm; the upper bridge is movable), for kinematic checks. */
export const VIBRATING_LENGTH_MM = 566

/** Fraction of the vibrating length from the nut at which a stop of `semitones` sits. */
export function stopFraction(semitones: number): number {
  return 1 - 2 ** (-semitones / 12)
}

export function contactPositionMm(semitones: number): number {
  return stopFraction(semitones) * VIBRATING_LENGTH_MM
}

// ---------------------------------------------------------------------------------------------
// Natural harmonics (tsatsal)
// ---------------------------------------------------------------------------------------------

export interface HarmonicNode {
  /** Partial number n: the string vibrates in n segments. */
  partial: number
  /** Node closest to the nut, as a fraction of vibrating length (1/n). */
  nodeFraction: number
  /** Where the node sits expressed as an equivalent stop position, in semitones. */
  positionSemitones: number
  /** Sounding pitch above the open string, in (fractional) semitones. */
  soundingSemitones: number
}

export function harmonicNode(partial: number): HarmonicNode {
  const nodeFraction = 1 / partial
  return {
    partial,
    nodeFraction,
    positionSemitones: -12 * Math.log2(1 - nodeFraction),
    soundingSemitones: 12 * Math.log2(partial)
  }
}

/** Nodes for partials 2…maxPartial, nearest-to-nut first in pitch order. */
export function harmonicNodes(maxPartial = 5): HarmonicNode[] {
  const nodes: HarmonicNode[] = []
  for (let n = 2; n <= maxPartial; n++) nodes.push(harmonicNode(n))
  return nodes
}

/** Partials whose equal-tempered rounding is close enough to name as a written note. */
const NAMEABLE_PARTIALS = [2, 3, 4, 5, 6, 8]

/**
 * If `semitonesAboveOpen` (a written, equal-tempered interval) is a natural harmonic of the open
 * string, returns its partial number; otherwise null.
 */
export function partialForInterval(semitonesAboveOpen: number): number | null {
  for (const n of NAMEABLE_PARTIALS) {
    if (Math.round(12 * Math.log2(n)) === semitonesAboveOpen) return n
  }
  return null
}

/** The harmonic node (if any) within `tolerance` semitones of a stop position. */
export function harmonicNearStop(stopSemitones: number, tolerance = 0.6, maxPartial = 5): HarmonicNode | null {
  let best: HarmonicNode | null = null
  for (const node of harmonicNodes(maxPartial)) {
    const d = Math.abs(node.positionSemitones - stopSemitones)
    if (d <= tolerance && (!best || d < Math.abs(best.positionSemitones - stopSemitones))) best = node
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Fingering
// ---------------------------------------------------------------------------------------------

/** Stopping fingers, plus the thumb (Erkhii darakh) — usually on the female string, in some schools under the male string. */
export type Finger = 'index' | 'middle' | 'ring' | 'pinky' | 'thumb'
export const FINGERS: readonly Finger[] = ['index', 'middle', 'ring', 'pinky', 'thumb']
/** Order of the side-stopping fingers along the neck; the thumb (0) works from below and is excluded. */
export const FINGER_NUMBER: Record<Finger, number> = { thumb: 0, index: 1, middle: 2, ring: 3, pinky: 4 }
export const FINGER_LABEL: Record<Finger, string> = { thumb: 'T', index: '1', middle: '2', ring: '3', pinky: '4' }
const SIDE_FINGERS: readonly Finger[] = ['index', 'middle', 'ring', 'pinky']

/**
 * First-position fingering (hand anchored at the upper bridge). Two frames are documented: index
 * +2, middle +3/+4, ring +5, little finger +7 (Khalkha teaching), and a chromatic frame with index
 * +2, middle +3, ring +4, little finger +5 — both are accepted. Beyond a fifth the hand shifts
 * position, so any side-stopping finger is accepted.
 */
const FIRST_POSITION: Record<number, readonly Finger[]> = {
  1: ['index'],
  2: ['index'],
  3: ['middle', 'index'],
  4: ['middle', 'ring'],
  5: ['ring', 'pinky', 'middle'],
  6: ['ring', 'pinky'],
  7: ['pinky', 'ring']
}

export function allowedFingers(stop: number): readonly Finger[] {
  if (stop <= 0) return []
  return FIRST_POSITION[stop] ?? SIDE_FINGERS
}

export function suggestFinger(stop: number): Finger | null {
  if (stop <= 0) return null
  const allowed = FIRST_POSITION[stop]
  if (allowed) return allowed[0]!
  // Upper positions: cycle the hand so index sits a whole tone below the target group.
  return SIDE_FINGERS[Math.min(3, Math.floor(((stop - 8) % 7) / 2))]!
}

// ---------------------------------------------------------------------------------------------
// Scales, string choice and keyboard layout
// ---------------------------------------------------------------------------------------------

export type ScaleId = 'diatonic' | 'pentatonic' | 'chromatic'

export const SCALES: Record<ScaleId, { name: string; intervals: readonly number[] }> = {
  diatonic: { name: 'Diatonic', intervals: [0, 2, 4, 5, 7, 9, 11] },
  // Anhemitonic pentatonic, the backbone of Mongolian folk melody.
  pentatonic: { name: 'Pentatonic · Bii', intervals: [0, 2, 4, 7, 9] },
  chromatic: { name: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
}

export function inScale(midi: number, tonicPc: number, scale: ScaleId): boolean {
  const rel = (((midi - tonicPc) % 12) + 12) % 12
  return SCALES[scale].intervals.includes(rel)
}

/** Stop offsets (0 = open) on a string whose pitches belong to the scale. */
export function scaleStops(openNote: number, tonicPc: number, scale: ScaleId, maxStop = MAX_STOP): number[] {
  const stops: number[] = []
  for (let s = 0; s <= maxStop; s++) if (inScale(openNote + s, tonicPc, scale)) stops.push(s)
  return stops
}

export interface StringPosition {
  string: StringId
  stop: number
  midi: number
}

/**
 * Where to play `midi`. Notes below the female open string go on the male string; everything else
 * on the female string unless `prefer` is given and the note is reachable there.
 */
export function chooseString(midi: number, tuning: Tuning, prefer?: StringId): StringPosition | null {
  const fits = (s: StringId) => {
    const stop = midi - openMidi(tuning, s)
    return stop >= 0 && stop <= MAX_STOP ? stop : null
  }
  if (prefer) {
    const stop = fits(prefer)
    if (stop !== null) return { string: prefer, stop, midi }
  }
  const femaleStop = fits('female')
  if (femaleStop !== null) return { string: 'female', stop: femaleStop, midi }
  const maleStop = fits('male')
  if (maleStop !== null) return { string: 'male', stop: maleStop, midi }
  return null
}

/**
 * Ascending playable notes for a one-row computer-keyboard layout: the male string from open up to
 * just below the female open string, then the female string upward.
 */
export function keyboardLayout(tuning: Tuning, scale: ScaleId, count: number): StringPosition[] {
  const notes: StringPosition[] = []
  for (let midi = tuning.male; notes.length < count && midi <= tuning.female + MAX_STOP; midi++) {
    if (!inScale(midi, tuning.scaleTonic, scale)) continue
    const string: StringId = midi < tuning.female ? 'male' : 'female'
    notes.push({ string, stop: midi - openMidi(tuning, string), midi })
  }
  return notes
}
