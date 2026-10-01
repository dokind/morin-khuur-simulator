/**
 * Western staff notation: the song as one monophonic line on a treble staff at sounding pitch
 * (F3 sits on the third ledger line below). Pure layout; components/StaffView.tsx draws it.
 *  - Every measure is filled exactly with notes and rests: the items add up to quartersPerBar. An
 *    empty measure is one measure rest, whatever the meter.
 *  - Notes that cross a bar line, or have no single written value, become tied pieces, split
 *    along the beat so the meter stays readable (6/8 groups in dotted quarters).
 *  - "t" durations are written as 3:2 triplets; dotted values take up to two dots.
 *  - The grid holds 64th notes and 64th-note triplets. A note shorter than those is still written,
 *    as a 64th, taking the time from what follows (which starts that much later).
 *  - Pitches are spelled in the song's major key (flats in flat keys and C, sharps in sharp keys)
 *    and an accidental lasts until the bar line.
 *  - Unpitched notes (body tap, slap, col legno) stay in the line as "x" noteheads on the middle
 *    line, so percussion rhythms remain visible and every note can be highlighted.
 *  - Where notes overlap the top line wins: at every moment the highest sounding note is written.
 *    Of notes starting together the highest is kept, a higher (or equally high, re-struck) note
 *    cuts a held note short, and a lower (or unpitched) note is left out while a higher one holds,
 *    then written from where that one ends if it is still sounding.
 */

import { quartersPerBar, type TimeSignature } from './timing'
import type { Song, SongNote } from './types'

export type StaffDuration = 'w' | 'h' | 'q' | '8' | '16' | '32' | '64'

export interface StaffValue {
  duration: StaffDuration
  dots: number
  /** Written inside a 3:2 tuplet ("8t" is an eighth-note triplet). */
  triplet: boolean
}

interface StaffItemBase extends StaffValue {
  /** Quarter-note beats from the start of the song. */
  startBeats: number
  /** Length in quarter-note beats, dots and triplet ratio included. */
  beats: number
}

export interface StaffNoteItem extends StaffItemBase {
  kind: 'note'
  /** `SongNote.index` of the note this piece belongs to. */
  noteIndex: number
  /** VexFlow key such as "bb/3"; unpitched notes use "b/4". */
  key: string
  /** Sign to print, or null when the key signature or an earlier sign in the bar applies. */
  accidental: '#' | 'b' | 'n' | null
  /** Unpitched (body tap, slap, col legno…): drawn with an "x" notehead. */
  percussion: boolean
  /** Tied to the next item, which continues the same note. */
  tie: boolean
}

export interface StaffRestItem extends StaffItemBase {
  kind: 'rest'
  /**
   * The rest fills the whole measure. It is written as a whole rest ("w", conventionally centred)
   * in every meter, so only `beats` gives its length.
   */
  measureRest: boolean
}

export type StaffItem = StaffNoteItem | StaffRestItem

export interface StaffMeasure {
  index: number
  startBeats: number
  /** quartersPerBar(song.timeSignature); the items' beats always add up to it. */
  beats: number
  items: StaffItem[]
}

export interface StaffKey {
  /** Major key signature as VexFlow names it: "C", "Bb", "Gb"… */
  name: string
  tonicPc: number
  /** Sharps (positive) or flats (negative) in the signature. */
  fifths: number
}

/** Layout grid: 48 ticks per quarter holds 64ths (3 ticks) and 64th-note triplets (2 ticks). */
const TPQ = 48

interface Written extends StaffValue {
  ticks: number
}

const BASE: readonly (readonly [StaffDuration, number])[] = [
  ['w', 192],
  ['h', 96],
  ['q', 48],
  ['8', 24],
  ['16', 12],
  ['32', 6],
  ['64', 3]
]

/** Every value the layout writes, longest first. 2 and 3 ticks are both present, so any length ≥ 2 ticks is expressible. */
const VALUES: readonly Written[] = BASE.flatMap(([duration, ticks]): Written[] => [
  { duration, dots: 0, triplet: false, ticks },
  { duration, dots: 0, triplet: true, ticks: (ticks * 2) / 3 },
  ...[1, 2].map((dots) => ({ duration, dots, triplet: false, ticks: ticks * (2 - 2 ** -dots) })).filter((v) => Number.isInteger(v.ticks))
]).sort((a, b) => b.ticks - a.ticks)

const EXACT = new Map(VALUES.map((v) => [v.ticks, v]))

// Major keys by tonic pitch class; F♯/G♭ is written G♭ like the rest of the app's flat spellings.
const KEY_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const KEY_FIFTHS = [0, -5, 2, -3, 4, -1, -6, 1, -4, 3, -2, 5]
const LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b']
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11]
/** Letter indexes in the order sharps are added (F C G D A E B); flats use the reverse. */
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]
const SIGN: Record<number, '#' | 'b' | 'n'> = { 1: '#', [-1]: 'b', 0: 'n' }

const mod = (n: number, m: number) => ((n % m) + m) % m

/** The song's `key` as a major key, else the male string's pitch class (as jianpuMeasures does). */
export function staffKey(song: Song): StaffKey {
  const tonicPc = mod(song.keyPc ?? song.tuning.male, 12)
  return { name: KEY_NAMES[tonicPc]!, tonicPc, fifths: KEY_FIFTHS[tonicPc]! }
}

/** Alteration (+1, 0, −1) the key signature gives each letter C…B. */
function keyAlterations(fifths: number): number[] {
  const alter = LETTERS.map(() => 0)
  const order = fifths >= 0 ? SHARP_ORDER : [...SHARP_ORDER].reverse()
  for (const letter of order.slice(0, Math.abs(fifths))) alter[letter] = Math.sign(fifths)
  return alter
}

interface Spelling {
  letter: number
  alter: number
  octave: number
}

/** Scale notes take the key's spelling; other notes use flats (or sharps in sharp keys). */
function spell(midi: number, alter: number[], sharps: boolean): Spelling {
  const pc = mod(midi, 12)
  let letter = alter.findIndex((a, l) => mod(LETTER_PC[l]! + a, 12) === pc)
  let acc = letter >= 0 ? alter[letter]! : 0
  if (letter < 0) {
    letter = LETTER_PC.indexOf(pc)
    if (letter < 0) {
      acc = sharps ? 1 : -1
      letter = LETTER_PC.indexOf(mod(pc - acc, 12))
    }
  }
  return { letter, alter: acc, octave: Math.floor((midi - acc) / 12) - 1 }
}

const vexKey = (s: Spelling) => `${LETTERS[s.letter]}${s.alter > 0 ? '#' : s.alter < 0 ? 'b' : ''}/${s.octave}`

/** VexFlow key for a MIDI pitch spelled in `key`, e.g. 70 in B♭ major → "bb/4". */
export function staffPitch(midi: number, key: StaffKey): string {
  return vexKey(spell(midi, keyAlterations(key.fifths), key.fifths > 0))
}

/**
 * Treble-staff line of a VexFlow key as VexFlow counts them: the bottom line (E4) is 1, the top
 * line (F5) 5, spaces are halves. Ledger notes lie outside 1–5: F3 at −2, C3 at −3.5, B♭6 at 10.
 */
export function staffLine(key: string): number {
  const octave = Number(key.slice(key.indexOf('/') + 1))
  return (octave * 7 + LETTERS.indexOf(key[0]!) - 30) / 2 + 1
}

/** Highest and lowest notehead lines (see staffLine) in these measures, or null when they hold only rests. */
export function staffRange(measures: readonly StaffMeasure[]): { highest: number; lowest: number } | null {
  let highest = -Infinity
  let lowest = Infinity
  for (const item of measures.flatMap((m) => m.items)) {
    if (item.kind !== 'note') continue
    const line = staffLine(item.key)
    highest = Math.max(highest, line)
    lowest = Math.min(lowest, line)
  }
  return highest >= lowest ? { highest, lowest } : null
}

/** Beat in ticks: the time-signature unit, or three units in compound meters (3/8, 6/8, 9/8, 12/8…). */
function beatTicks(ts: TimeSignature): number {
  const unit = (4 / ts.unit) * TPQ
  return ts.unit >= 8 && ts.beats % 3 === 0 ? unit * 3 : unit
}

interface Meter {
  /** Beat in ticks (see beatTicks). */
  beat: number
  rest: boolean
}

/**
 * Whether value `v` (`n` ticks at bar offset `t`) reads well at a metric level of `unit` ticks.
 * Notes: anything inside one unit; across units a value starts on a unit and ends on one (or
 * half-way through a simple beat, as in ♩. ♪). Triplets stay inside a 3:2 group: their own, or
 * for notes one of the next shorter triplet value, taking two of its three places (a half-note
 * triplet on the second quarter triplet). Rests also start on a multiple of their undotted value
 * within the beat, cross units only from a multiple of their own length, and are dotted across
 * units only in compound meters.
 */
function fits(t: number, n: number, v: Written, unit: number, m: Meter): boolean {
  const offset = t % m.beat
  if (Math.floor(t / unit) === Math.floor((t + n - 1) / unit)) return !m.rest || v.triplet || offset % (n / (2 - 2 ** -v.dots)) === 0
  if (v.triplet) {
    const groups = m.rest ? [3 * n] : [3 * n, 1.5 * n]
    return groups.some((group) => t % (group / 3) === 0 && Math.floor(t / group) === Math.floor((t + n - 1) / group))
  }
  if (t % unit !== 0) return false
  const end = t + n
  const compound = unit % 9 === 0
  if (m.rest) return (unit >= m.beat ? t : offset) % n === 0 && end % unit === 0 && (v.dots === 0 || compound)
  return end % unit === 0 || (!compound && unit % 2 === 0 && end % (unit / 2) === 0)
}

/** Next metric level down: compound beats split in three, triplet grids in three, the rest in two. */
function finer(unit: number, triplet: boolean): number {
  return (triplet ? unit % 3 === 0 : unit % 9 === 0) ? unit / 3 : unit / 2
}

/** Longest-first fill that never leaves a single tick. Only reached for odd grids (e.g. 64ths mixed with triplets). */
function greedy(n: number): Written[] {
  const out: Written[] = []
  while (n > 0) {
    const v = VALUES.find((w) => w.ticks <= n && n - w.ticks !== 1) ?? VALUES[VALUES.length - 1]!
    out.push(v)
    n -= v.ticks
  }
  return out
}

/** Written values for `n` ticks starting `t` ticks into a bar, splitting along the metric levels. */
function split(t: number, n: number, unit: number, m: Meter): Written[] {
  if (n <= 0) return []
  if (!Number.isInteger(unit) || unit < 2) return greedy(n)
  const exact = EXACT.get(n)
  if (exact && fits(t, n, exact, unit, m)) return [exact]
  const triplet = t % 3 !== 0 || n % 3 !== 0
  const sub = finer(unit, triplet)
  if (t % unit !== 0) {
    const next = t - (t % unit) + unit
    if (next >= t + n) return split(t, n, sub, m)
    if (next - t === 1 || t + n - next === 1) return greedy(n)
    // The head up to the next unit is split at this level too, so it stays one value where one fits.
    return [...split(t, next - t, unit, m), ...split(next, t + n - next, unit, m)]
  }
  if (n <= unit) return split(t, n, sub, m)
  const usable = (v: Written) => v.ticks < n && n - v.ticks !== 1 && fits(t, v.ticks, v, unit, m)
  const head =
    VALUES.find((v) => usable(v) && !v.triplet && (t + v.ticks) % unit === 0) ??
    VALUES.find((v) => usable(v) && (!triplet || v.triplet || (t + v.ticks) % unit === 0))
  if (head) return [head, ...split(t + head.ticks, n - head.ticks, unit, m)]
  if (n - unit === 1) return greedy(n)
  return [...split(t, unit, sub, m), ...split(t + unit, n - unit, unit, m)]
}

interface Span {
  start: number
  end: number
  note: SongNote | null
}

/**
 * Monophonic top line on the tick grid: the notes' spans where each is the highest sounding note
 * (see the overlap rule in the header), in time order, without the rests between them.
 */
function topLine(notes: readonly SongNote[]): Span[] {
  // Notes on the grid, where a note shorter than a tick keeps one (fitGrid lengthens it to a
  // written value). A note that starts once another has ended starts after it on the grid too,
  // even when both are shorter than a tick and rounding alone would start them together.
  const spans: Span[] = []
  let held: { end: number; start: number }[] = []
  let ended = -1
  for (const note of notes) {
    const now = note.startBeats + 1e-6
    for (const h of held) if (h.end <= now) ended = Math.max(ended, h.start)
    held = held.filter((h) => h.end > now)
    const start = Math.max(0, Math.round(note.startBeats * TPQ), ended + 1)
    spans.push({ start, end: Math.max(start + 1, Math.round((note.startBeats + note.durationBeats) * TPQ)), note })
    held.push({ end: note.startBeats + note.durationBeats, start })
  }
  spans.sort((a, b) => a.start - b.start)
  const height = (s: Span) => s.note?.pitch ?? -Infinity
  // Higher wins; at equal height the later attack; of notes starting together the first in the song.
  const wins = (a: Span, b: Span) => height(a) > height(b) || (height(a) === height(b) && a.start > b.start)

  const times = [...new Set(spans.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b)
  const line: Span[] = []
  let sounding: Span[] = []
  let next = 0
  for (let i = 0; i + 1 < times.length; i++) {
    const t = times[i]!
    const until = times[i + 1]!
    while (next < spans.length && spans[next]!.start === t) sounding.push(spans[next++]!)
    sounding = sounding.filter((s) => s.end > t)
    const top = sounding.reduce<Span | null>((best, s) => (best && !wins(s, best) ? best : s), null)
    if (!top) continue
    const last = line.at(-1)
    if (last && last.note === top.note && last.end === t) last.end = until
    else line.push({ start: t, end: until, note: top.note })
  }
  return line
}

/**
 * Places the top line's spans on the grid with rests between them. No written value lasts a
 * single tick, so inside a bar every note and rest needs at least two: each boundary moves to the
 * nearest position that allows this, preferring a bar line and then the side that lengthens the
 * note. A rest can shrink away; a note never does: one shorter than any written value becomes a
 * 64th, and when a note has to grow the notes after it start that much later.
 */
function fitGrid(line: readonly Span[], barTicks: number): Span[] {
  const onBar = (p: number) => p % barTicks === 0
  // Whether a boundary can sit at `p` after one at `from`: no piece of one tick between them or next to a bar line.
  const legal = (p: number, from: number) => p === from || (p - from >= 2 && p % barTicks !== 1 && p % barTicks !== barTicks - 1)
  const place = (target: number, from: number, min: number, later: boolean) => {
    target = Math.max(target, min)
    for (let d = 0; ; d++) {
      const early = target - d >= min && legal(target - d, from)
      const late = legal(target + d, from)
      if (early && late && d > 0) {
        if (onBar(target - d) !== onBar(target + d)) return onBar(target - d) ? target - d : target + d
        return later ? target + d : target - d
      }
      if (early) return target - d
      if (late) return target + d
    }
  }

  const out: Span[] = []
  let cursor = 0
  for (const span of line) {
    // The start may move earlier into the rest before it; the end later into what follows.
    const start = place(span.start, cursor, cursor, false)
    if (start > cursor) out.push({ start: cursor, end: start, note: null })
    const shortest = span.note && span.note.durationBeats * TPQ < 2 ? 3 : 2
    const end = place(Math.max(span.end, start + shortest), start, start + 2, true)
    out.push({ start, end, note: span.note })
    cursor = end
  }
  return out
}

const valueOf = (v: Written): StaffValue => ({ duration: v.duration, dots: v.dots, triplet: v.triplet })

/** Lays the song out bar by bar on one treble staff. */
export function staffMeasures(song: Song): StaffMeasure[] {
  const perBar = quartersPerBar(song.timeSignature)
  const barTicks = Math.round(perBar * TPQ)
  const beat = beatTicks(song.timeSignature)
  const key = staffKey(song)
  const alter = keyAlterations(key.fifths)

  const spans = fitGrid(topLine(song.notes), barTicks)
  const cursor = spans.at(-1)?.end ?? 0
  const barCount = Math.max(1, Math.ceil(Math.max(Math.round(song.lengthBeats * TPQ), cursor) / barTicks))
  const total = barCount * barTicks
  if (cursor < total) spans.push({ start: cursor, end: total, note: null })

  const measures: StaffMeasure[] = Array.from({ length: barCount }, (_, index) => ({ index, startBeats: index * perBar, beats: perBar, items: [] }))
  const measureRest: Written = { duration: 'w', dots: 0, triplet: false, ticks: barTicks }
  let signs = new Map<string, number>()
  let signsBar = -1

  for (const span of spans) {
    const note = span.note
    let spelled: Spelling | null = null
    let accidental: StaffNoteItem['accidental'] = null
    if (note && note.pitch !== null) {
      spelled = spell(note.pitch, alter, key.fifths > 0)
      const bar = Math.floor(span.start / barTicks)
      if (bar !== signsBar) {
        signs = new Map()
        signsBar = bar
      }
      const position = `${spelled.letter}/${spelled.octave}`
      if (spelled.alter !== (signs.get(position) ?? alter[spelled.letter])) {
        accidental = SIGN[spelled.alter]!
        signs.set(position, spelled.alter)
      }
    }

    const pieces: StaffNoteItem[] = []
    for (let t = span.start; t < span.end; ) {
      const barStart = t - (t % barTicks)
      const to = Math.min(span.end, barStart + barTicks)
      const items = measures[barStart / barTicks]!.items
      const whole = !note && to - t === barTicks
      const values = whole ? [measureRest] : split(t - barStart, to - t, beat, { beat, rest: !note })
      let at = t
      for (const v of values) {
        const timing = { ...valueOf(v), startBeats: at / TPQ, beats: v.ticks / TPQ }
        if (!note) items.push({ kind: 'rest', ...timing, measureRest: whole })
        else {
          const piece: StaffNoteItem = {
            kind: 'note',
            ...timing,
            noteIndex: note.index,
            key: spelled ? vexKey(spelled) : 'b/4',
            accidental: pieces.length === 0 ? accidental : null,
            percussion: spelled === null,
            tie: true
          }
          items.push(piece)
          pieces.push(piece)
        }
        at += v.ticks
      }
      t = to
    }
    const last = pieces.at(-1)
    if (last) last.tie = false
  }
  return measures
}
