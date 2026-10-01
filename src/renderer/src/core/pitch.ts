/** Note-name, MIDI and frequency conversions. Pure functions, no audio or DOM dependencies. */

export const A4_HZ = 440
export const A4_MIDI = 69

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const NOTE_RE = /^([A-Ga-g])(#{1,2}|♯|b{1,2}|♭)?(-?\d+)$/

/** Parses "F3", "Bb3", "B♭3", "C#4" into a MIDI note number, or null if malformed. */
export function parseNote(name: string): number | null {
  const m = NOTE_RE.exec(name.trim())
  if (!m) return null
  const letter = m[1]!.toUpperCase()
  const acc = m[2] ?? ''
  const octave = Number(m[3])
  let alter = 0
  if (acc === '♯' || acc.startsWith('#')) alter = acc === '♯' ? 1 : acc.length
  else if (acc === '♭' || acc.startsWith('b')) alter = acc === '♭' ? -1 : -acc.length
  return (octave + 1) * 12 + LETTER_PC[letter]! + alter
}

/** Parses a bare pitch class such as "Bb" or "F#" into 0–11. */
export function parsePitchClass(name: string): number | null {
  const midi = parseNote(`${name.trim()}4`)
  return midi === null ? null : ((midi % 12) + 12) % 12
}

/** Morin khuur repertoire in standard F–B♭ tuning reads naturally with flats, so flats are the default. */
export function midiToName(midi: number, preferSharps = false): string {
  const pc = ((Math.round(midi) % 12) + 12) % 12
  const octave = Math.floor(Math.round(midi) / 12) - 1
  return `${(preferSharps ? SHARP_NAMES : FLAT_NAMES)[pc]}${octave}`
}

export function pitchClassName(pc: number, preferSharps = false): string {
  return (preferSharps ? SHARP_NAMES : FLAT_NAMES)[((pc % 12) + 12) % 12]!
}

/** Display form with proper accidental glyphs: "Bb3" → "B♭3". */
export function prettyNoteName(name: string): string {
  return name.replace(/([A-G])b/g, '$1♭').replace(/([A-G])#/g, '$1♯')
}

export function midiToFreq(midi: number, a4 = A4_HZ): number {
  return a4 * 2 ** ((midi - A4_MIDI) / 12)
}

export function freqToMidi(freq: number, a4 = A4_HZ): number {
  return A4_MIDI + 12 * Math.log2(freq / a4)
}

/** Signed distance in cents from `reference` to `actual`. */
export function centsBetween(reference: number, actual: number): number {
  return 1200 * Math.log2(actual / reference)
}
