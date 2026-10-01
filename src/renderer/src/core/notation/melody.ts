/**
 * Turns an imported melody (from MIDI or MusicXML) into a playable `.mkhuur.json` song: one line,
 * inside the two strings' range, on the quantised grid the notation can express, with strings,
 * fingers and alternating bows filled in. The result always parses and verifies without errors.
 */

import { DEFAULT_TUNING, MAX_STOP, suggestFinger, type StringId, type Tuning } from '../instrument'
import { midiToName, pitchClassName } from '../pitch'
import { oppositeBow, type BowDirection } from '../techniques'
import { formatPosition, parsePosition, parseTimeSignature, quartersPerBar, type TimeSignature } from './timing'
import type { RawSong, RawSongNote } from './types'

export interface MelodyNote {
  /** Quarter-note beats from the start. */
  startBeats: number
  durationBeats: number
  midi: number
  /** 0–1. */
  velocity: number
  /** Continues the previous note in the same bow stroke. */
  slur: boolean
}

export interface MelodyInput {
  /** May be empty when the source names none. */
  title: string
  composer?: string
  /** Quarter notes per minute. */
  tempoBpm: number
  timeSignature: TimeSignature
  /** Tonic pitch class (major key) or null when unknown. */
  keyPc: number | null
  notes: MelodyNote[]
  /** Notes from the importer (ignored tracks, tempo changes…), passed through to the result. */
  messages?: string[]
}

export interface ArrangeOptions {
  tuning?: Pick<Tuning, 'male' | 'female'>
  /** Where the melody came from, e.g. "tune.mid (MIDI)". */
  source?: string
}

export interface ArrangeResult {
  raw: RawSong
  /** Human-readable notes about every change made to fit the instrument. */
  messages: string[]
}

const EPS = 1e-9
/**
 * Positions snap to 1/12 beat (sixteenths and eighth/sixteenth triplets) for played, unquantised
 * input. Notated input — nearly every onset already on the 1/24 grid — snaps to 1/24 instead, so
 * 32nds and dotted-16th/32nd figures keep all their notes.
 */
const COARSE_GRID = 12
const FINE_GRID = 24
/** An onset within this many beats of a 1/24 grid point counts as notated. */
const NOTATED_TOLERANCE = 1e-3
const NOTATED_SHARE = 0.9
/** Notes starting this close together are treated as one chord. */
const CHORD_TOLERANCE = 1 / 24
/** Overlaps up to this long (beats) are legato playing, not a second voice. */
const LEGATO_OVERLAP = 0.25
/** Notes sounding shorter than a 32nd (staccato, 1-tick MIDI notes) are written as up to a 16th. */
const SHORT_NOTE_TARGET = 0.25
/** Matches the verifier: a rest this long lets the player retake the bow. */
const RETAKE_GAP_BEATS = 0.5
/** Hard cap on song length (beats) so positions keep full floating-point precision. */
const MAX_BEATS = 1_000_000

const NOTE_TOKENS: readonly [string, number][] = [
  ['1n.', 6],
  ['1n', 4],
  ['2n.', 3],
  ['2n', 2],
  ['4n.', 1.5],
  ['4n', 1],
  ['8n.', 0.75],
  ['8n', 0.5],
  ['16n.', 0.375],
  ['16n', 0.25],
  ['32n', 0.125],
  ['2t', 4 / 3],
  ['4t', 2 / 3],
  ['8t', 1 / 3],
  ['16t', 1 / 6]
]
const MIN_TOKEN = Math.min(...NOTE_TOKENS.map(([, v]) => v))
const SHARP_KEYS = [7, 2, 9, 4, 11]

interface Working {
  start: number
  end: number
  midi: number
  velocity: number
  slur: boolean
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The tuning to arrange for: integer MIDI notes with the female string above the male one. */
function usableTuning(tuning: ArrangeOptions['tuning'], messages: string[]): Pick<Tuning, 'male' | 'female'> {
  if (!tuning) return DEFAULT_TUNING
  const { male, female } = tuning
  const ok = (m: number) => Number.isInteger(m) && m >= 0 && m <= 127
  if (ok(male) && ok(female) && female > male) return { male, female }
  const shown = (m: number) => (Number.isFinite(m) ? String(m) : '?')
  messages.push(
    `Tuning ${shown(male)}/${shown(female)} is not usable (needs MIDI notes 0–127, female above male); using ${midiToName(DEFAULT_TUNING.male)}–${midiToName(DEFAULT_TUNING.female)}.`
  )
  return DEFAULT_TUNING
}

/** Arranges a melody for the two strings; see the module comment for the guarantees. */
export function arrangeMelody(melody: MelodyInput, options: ArrangeOptions = {}): ArrangeResult {
  const messages = [...(melody.messages ?? [])]
  const tuning = usableTuning(options.tuning, messages)

  const { beats, unit } = melody.timeSignature
  let ts = parseTimeSignature(`${beats}/${unit}`)
  if (!ts) {
    messages.push(Number.isFinite(beats) && Number.isFinite(unit) ? `Time signature ${beats}/${unit} is not supported; using 4/4.` : 'The time signature is unreadable; using 4/4.')
    ts = { beats: 4, unit: 4 }
  }
  const perBar = quartersPerBar(ts)

  let tempoBpm = Number.isFinite(melody.tempoBpm) ? Math.round(melody.tempoBpm * 100) / 100 : 90
  if (tempoBpm < 20 || tempoBpm > 400) {
    const clamped = Math.min(400, Math.max(20, tempoBpm))
    messages.push(`Tempo ${tempoBpm} BPM is outside 20–400; using ${clamped}.`)
    tempoBpm = clamped
  }

  // --- (a) Monophonic reduction --------------------------------------------------------------
  let invalid = 0
  let outOfMidi = 0
  const input: Working[] = []
  for (const n of melody.notes) {
    // A note starting before 0 keeps only the part that sounds from 0 on.
    const start = Math.max(0, n.startBeats)
    const end = n.startBeats + n.durationBeats
    if (!Number.isFinite(n.startBeats) || !Number.isFinite(n.durationBeats) || !(n.durationBeats > 0) || !Number.isFinite(end) || end <= start) {
      invalid++
      continue
    }
    const midi = Math.round(n.midi)
    if (!(midi >= 0 && midi <= 127)) {
      outOfMidi++
      continue
    }
    input.push({
      start,
      end,
      midi,
      velocity: Number.isFinite(n.velocity) ? Math.min(1, Math.max(0, n.velocity)) : 0.8,
      slur: n.slur === true
    })
  }
  input.sort((a, b) => a.start - b.start || b.midi - a.midi)
  if (invalid) messages.push(`Ignored ${plural(invalid, 'note')} without a usable start time or duration.`)
  if (outOfMidi) messages.push(`Ignored ${plural(outOfMidi, 'note')} outside the MIDI pitch range.`)

  const line: Working[] = []
  let chordDropped = 0
  let hiddenDropped = 0
  let shortened = 0
  for (const note of input) {
    const prev = line[line.length - 1]
    if (!prev || note.start >= prev.end - EPS) {
      line.push(note)
      continue
    }
    if (note.start - prev.start < CHORD_TOLERANCE) {
      chordDropped++
      if (note.midi > prev.midi) line[line.length - 1] = { ...note, slur: prev.slur }
      continue
    }
    const overlap = prev.end - note.start
    const legato = overlap <= Math.min(LEGATO_OVERLAP, (prev.end - prev.start) / 2)
    // A higher note takes over; so does the same pitch struck again (a re-attack, e.g. under sustain).
    if (legato || note.midi >= prev.midi) {
      prev.end = note.start
      shortened++
      line.push(note)
    } else {
      hiddenDropped++
    }
  }
  // Notes cut very short here are not dropped yet: quantisation below drops only the notes that
  // leave no room before the next onset, so staccato and 1-tick MIDI notes survive.
  let notes = line

  if (chordDropped) messages.push(`Kept the top note of each chord (${plural(chordDropped, 'note')} removed).`)
  if (hiddenDropped) messages.push(`Removed ${plural(hiddenDropped, 'lower note')} sounding under a held melody note.`)
  if (shortened) messages.push(`Shortened ${plural(shortened, 'overlapping note')} so only one note sounds at a time.`)

  // Leading silence: drop whole empty bars.
  if (notes.length) {
    const emptyBars = Math.floor(notes[0]!.start / perBar + EPS)
    if (emptyBars > 0) {
      const shift = emptyBars * perBar
      notes = notes.map((n) => ({ ...n, start: Math.max(0, n.start - shift), end: n.end - shift }))
      messages.push(`Removed ${plural(emptyBars, 'empty bar')} at the start.`)
    }
  }
  const beforeCap = notes.length
  notes = notes.filter((n) => n.start < MAX_BEATS - 1).map((n) => (n.end > MAX_BEATS ? { ...n, end: MAX_BEATS } : n))
  if (notes.length < beforeCap) messages.push(`Dropped ${plural(beforeCap - notes.length, 'note')} starting more than ${MAX_BEATS.toLocaleString('en')} beats in.`)
  if (notes.length === 0) messages.push('The melody has no notes.')

  // --- (b) Range: whole-octave transposition, then per-note octave folding ---------------------
  // Male string: open up to just below the female string; female string: open up to MAX_STOP.
  const low = tuning.male
  const high = tuning.female + MAX_STOP
  const playable = (m: number) => (m >= tuning.female && m <= high) || (m >= low && m < tuning.female && m - low <= MAX_STOP)
  const rangeName = `${midiToName(low)}–${midiToName(high)}`
  if (notes.length) {
    const pitches = notes.map((n) => n.midi)
    const lowest = pitches.reduce((a, b) => Math.min(a, b))
    const highest = pitches.reduce((a, b) => Math.max(a, b))
    const center = (lowest + highest) / 2
    let best = { shift: 0, fits: -1, distance: Infinity }
    for (let octaves = Math.floor((low - highest) / 12) - 1; octaves <= Math.ceil((high - lowest) / 12) + 1; octaves++) {
      const shift = octaves * 12
      const fits = pitches.filter((p) => playable(p + shift)).length
      const distance = Math.abs(octaves) * 1000 + Math.abs(center + shift - (low + high) / 2)
      if (fits > best.fits || (fits === best.fits && distance < best.distance)) best = { shift, fits, distance }
    }
    if (best.shift !== 0) {
      const n = Math.abs(best.shift / 12)
      messages.push(`Transposed ${best.shift > 0 ? 'up' : 'down'} ${plural(n, 'octave')} to fit the ${rangeName} range.`)
    }
    const folded: string[] = []
    notes = notes.map((note) => {
      const original = note.midi + best.shift
      const midi = foldIntoRange(original, low, high, playable)
      if (midi !== original) folded.push(`${midiToName(original)}→${midiToName(midi)}`)
      return { ...note, midi }
    })
    if (folded.length) {
      const sample = folded.slice(0, 6).join(', ')
      messages.push(`Moved ${plural(folded.length, 'note')} by octaves to stay within ${rangeName}: ${sample}${folded.length > 6 ? ', …' : ''}.`)
    }
  }

  // --- (f) Quantise and pick duration tokens, last note first so each sees its successor -------
  const onFineGrid = notes.filter((n) => Math.abs(n.start * FINE_GRID - Math.round(n.start * FINE_GRID)) <= NOTATED_TOLERANCE * FINE_GRID).length
  const grid = notes.length && onFineGrid >= NOTATED_SHARE * notes.length ? FINE_GRID : COARSE_GRID
  const q = (beats: number) => Math.round(beats * grid) / grid
  const placed: (Working & { token: string })[] = []
  let nextStart = Infinity
  let crowded = 0
  let lengthened = 0
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i]!
    const start = q(note.start)
    const room = nextStart - start
    if (room < MIN_TOKEN - EPS) {
      crowded++
      continue
    }
    const sounding = note.end - note.start
    const short = sounding < MIN_TOKEN - EPS && room > sounding + EPS
    const target = short ? Math.min(room, SHORT_NOTE_TARGET) : Math.min(note.end - start, room)
    const [token, length] = durationToken(target, room, perBar)
    if (short) lengthened++
    placed.push({ ...note, start, end: start + length, token })
    nextStart = start
  }
  placed.reverse()
  if (lengthened) messages.push(`Lengthened ${plural(lengthened, 'very short note')} to a notatable value.`)
  if (crowded) messages.push(`Dropped ${plural(crowded, 'note')} starting less than a 32nd before the next one.`)

  // --- (c)–(e) Strings, technique, fingers and bows ----------------------------------------------
  const keyPc = melody.keyPc === null || !Number.isFinite(melody.keyPc) ? null : ((Math.round(melody.keyPc) % 12) + 12) % 12
  const sharps = keyPc !== null && SHARP_KEYS.includes(keyPc)
  const rawNotes: RawSongNote[] = []
  let prevBow: BowDirection | null = null
  let prevEnd = -Infinity
  for (const note of placed) {
    const string: StringId = note.midi >= tuning.female ? 'female' : 'male'
    const stop = note.midi - (string === 'female' ? tuning.female : tuning.male)
    const slur = note.slur && prevBow !== null
    let bow: BowDirection
    if (slur) bow = prevBow!
    else if (prevBow === null || note.start - prevEnd >= RETAKE_GAP_BEATS - EPS) bow = 'tatakh'
    else bow = oppositeBow(prevBow)
    prevBow = bow
    prevEnd = note.end

    const raw: RawSongNote = {
      time: positionString(note.start, ts),
      pitch: midiToName(note.midi, sharps),
      duration: note.token,
      string,
      technique: stop === 0 ? 'open' : 'cuticle_side_stop',
      finger: suggestFinger(stop),
      bow
    }
    if (slur) raw.slur = true
    const velocity = Math.round(note.velocity * 100) / 100
    if (velocity !== 0.8) raw.velocity = velocity
    rawNotes.push(raw)
  }

  // --- (g) Song fields ----------------------------------------------------------------------------
  const from = options.source?.trim() || 'an imported melody'
  const raw: RawSong = {
    title: melody.title.trim() || 'Imported melody',
    ...(melody.composer?.trim() ? { composer: melody.composer.trim() } : {}),
    source: `Auto-arranged for morin khuur from ${from} by the Morin Khuur Simulator importer; strings, fingers and bows are suggestions.`,
    tuning: { maleString: midiToName(tuning.male), femaleString: midiToName(tuning.female) },
    ...(keyPc !== null ? { key: pitchClassName(keyPc, sharps) } : {}),
    tempoBpm,
    timeSignature: `${ts.beats}/${ts.unit}`,
    notes: rawNotes
  }
  return { raw, messages }
}

/** The octave of `midi` that is playable and nearest to it (`midi` itself when already playable). */
function foldIntoRange(midi: number, low: number, high: number, playable: (m: number) => boolean): number {
  if (playable(midi)) return midi
  let best: number | null = null
  for (let m = low + ((((midi - low) % 12) + 12) % 12); m <= high; m += 12) {
    if (playable(m) && (best === null || Math.abs(m - midi) < Math.abs(best - midi))) best = m
  }
  // Unreachable for a usable tuning (each string spans more than an octave); kept as a safe fallback.
  return best ?? low
}

/** Nearest single duration token to `target` that does not exceed `room` (both in beats). */
function durationToken(target: number, room: number, perBar: number): [string, number] {
  const candidates: [string, number][] = [...NOTE_TOKENS]
  // Whole bars: the two bar counts around the target, and the most that fits in the room.
  const maxBars = Number.isFinite(room) ? Math.floor((room + EPS) / perBar) : Infinity
  for (const bars of new Set([Math.floor(target / perBar), Math.ceil(target / perBar), maxBars])) {
    if (bars >= 1 && Number.isFinite(bars)) candidates.push([`${bars}m`, bars * perBar])
  }
  let best: [string, number] | null = null
  for (const c of candidates) {
    if (c[1] > room + EPS) continue
    if (!best) {
      best = c
      continue
    }
    const d = Math.abs(c[1] - target) - Math.abs(best[1] - target)
    if (d < -EPS || (Math.abs(d) <= EPS && c[1] < best[1] - EPS)) best = c
  }
  return best ?? ['32n', MIN_TOKEN]
}

/**
 * formatPosition, with extra precision where its 3-decimal sixteenths would drift off a triplet
 * position by more than the verifier's overlap tolerance.
 */
function positionString(beats: number, ts: TimeSignature): string {
  const text = formatPosition(beats, ts)
  if (Math.abs((parsePosition(text, ts) ?? Infinity) - beats) < EPS) return text
  const perBar = quartersPerBar(ts)
  const bars = Math.floor(beats / perBar + EPS)
  const rest = beats - bars * perBar
  const whole = Math.floor(rest + EPS)
  return `${bars}:${whole}:${Math.round((rest - whole) * 4 * 1e6) / 1e6}`
}
