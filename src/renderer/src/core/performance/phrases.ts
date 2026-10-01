/**
 * Musical context the ornament rules need (plan §4.2): the song's pitch set and ornament
 * neighbours, phrases and their climax, and how often each bar pair has already been heard.
 * Numbers are engineering defaults [ENG] unless a source is named.
 */

import { MAX_STOP } from '../instrument'
import { quartersPerBar, type Song, type VerificationReport } from '../notation'
import { TECHNIQUES } from '../techniques'
import type { SongClock } from './tempo'

// ---------------------------------------------------------------------------------------------
// Pitch set and neighbours
// ---------------------------------------------------------------------------------------------

export interface PitchContext {
  /** Pitch classes used by at least two notes (every used class when fewer than three qualify). */
  classes: ReadonlySet<number>
  /** Semitones the melody itself steps between consecutive notes, keyed by the lower pitch class (9 = A–B♭). */
  semitoneSteps: ReadonlySet<number>
}

const pc = (midi: number) => ((midi % 12) + 12) % 12

/** Pitch set S of a line of notes in time order (null = unpitched, skipped). */
export function pitchContext(pitches: readonly (number | null)[]): PitchContext {
  const counts = new Map<number, number>()
  for (const p of pitches) if (p !== null) counts.set(pc(p), (counts.get(pc(p)) ?? 0) + 1)
  let classes = new Set([...counts].filter(([, n]) => n >= 2).map(([c]) => c))
  if (classes.size < 3) classes = new Set(counts.keys())
  const semitoneSteps = new Set<number>()
  let prev: number | null = null
  for (const p of pitches) {
    if (p === null) continue
    if (prev !== null && Math.abs(p - prev) === 1) semitoneSteps.add(pc(Math.min(p, prev)))
    prev = p
  }
  return { classes, semitoneSteps }
}

export interface NeighbourOptions {
  /** Candidate distances in semitones, in order of preference (default: a second, then a minor third). */
  distances?: readonly number[]
  /** Also try a semitone first, allowed only where the melody itself steps by it (default true). */
  semitone?: boolean
  /** Return a whole tone when no candidate is in the pitch set (for slides; default false). */
  fallback?: boolean
  /** Physical check on a signed offset, e.g. that it stays on the string within one hand frame. */
  fits?: (offset: number) => boolean
}

/**
 * The ornament neighbour of `pitch` in direction `dir`: the first candidate whose pitch class is in
 * the song's set. Mongolian melodies are anhemitonic pentatonic at heart [D'Evelyn p.21], semitones
 * are avoided [Van Oost 1915] and grace notes are a major second or minor third [Lin p.23], so a
 * semitone is never used unless the song steps by exactly that semitone. Returns the signed offset
 * in semitones, or null.
 */
export function neighbour(pitch: number, dir: 1 | -1, ctx: PitchContext, opts: NeighbourOptions = {}): number | null {
  const { distances = [2, 3], semitone = true, fallback = false, fits = () => true } = opts
  const candidates = semitone ? [1, ...distances.filter((d) => d !== 1)] : distances
  for (const d of candidates) {
    const offset = dir * d
    if (!fits(offset)) continue
    const target = pitch + offset
    const inSet = ctx.classes.has(pc(target))
    if (d === 1 ? inSet && ctx.semitoneSteps.has(pc(Math.min(pitch, target))) : inSet) return offset
  }
  return fallback && fits(dir * 2) ? dir * 2 : null
}

/** Most an ornament note may lie from the main note on the same string: one hand frame, the little finger reaching a third [SaQie; zhwiki]. */
export const REACH_STOPS = 4

/** Offsets playable from a note stopped `stop` semitones above the open string: never below the nut, within reach. */
export function reachable(stop: number, offset: number): boolean {
  const s = stop + offset
  return s >= 0 && s <= MAX_STOP && Math.abs(offset) <= REACH_STOPS
}

// ---------------------------------------------------------------------------------------------
// Phrases, climax and repetition
// ---------------------------------------------------------------------------------------------

/** A rest at least this long (s) ends a phrase (the existing `phraseGap`). */
export const PHRASE_GAP = 0.2
/** A note at least this many times the median length ends a phrase. */
export const PHRASE_HOLD = 2
/** Phrases without a rest or held note are cut at bar lines after this many bars. */
export const MAX_PHRASE_BARS = 4
/** "Very long" notes (s). */
export const VERY_LONG = 1.5

export interface NoteContext {
  /** Clock seconds (tempo map applied, before any performance timing). */
  start: number
  duration: number
  /** Length of a quarter beat at the note, s. */
  beat: number
  /** d ≥ max(0.6 s, one beat). */
  long: boolean
  /** d ≥ 1.5 s. */
  veryLong: boolean
  phrase: number
  phraseStart: boolean
  phraseEnd: boolean
  /** Repetition index k of the note's bar pair: 0 the first time, 1, 2, … for repeats. */
  repeat: number
  /** On the first beat of a bar, or the other strong beat (beat 3 of 4/4, the second half of 6/8). */
  strongBeat: boolean
  /** `order` of the previous pitched, sounding note, or null. */
  prev: number | null
  /** `order` of the next pitched, sounding note, or null. */
  next: number | null
  /** Semitones from the previous pitched note (0 when there is none). */
  leap: number
}

export interface Phrase {
  /** First and last `order` in the phrase. */
  first: number
  last: number
  /** `order` of the phrase's highest note among those long for the song (else its highest pitched note), or null. */
  peak: number | null
  /** `order` of the phrase's highest long note (d ≥ max(0.6 s, one beat)), or null. */
  longPeak: number | null
}

export interface SongAnalysis {
  notes: NoteContext[]
  phrases: Phrase[]
  /** Index into `phrases` of the phrase holding the song's highest long note (see `Phrase.peak`), or null. */
  climax: number | null
  pitch: PitchContext
}

const EPS = 1e-6

/** The first beat of a bar, beat 3 of 4/4, or any dotted-quarter pulse of a compound metre (6/8, 9/8, 12/8). */
function isStrongBeat(ts: Song['timeSignature'], inBar: number): boolean {
  const on = (step: number) => Math.abs(inBar / step - Math.round(inBar / step)) < EPS
  if (on(quartersPerBar(ts))) return true
  if (ts.unit === 8 && ts.beats % 3 === 0 && ts.beats > 3) return on(1.5)
  return ts.beats === 4 && ts.unit === 4 && on(2)
}

/** Pitched notes that sound (percussive strikes are rhythm, not melody). */
const melodic = (report: VerificationReport, order: number) => {
  const n = report.checks[order]!.note
  return n.pitch !== null && TECHNIQUES[n.technique].kind !== 'percussive'
}

export function analyzeSong(song: Song, report: VerificationReport, clock: SongClock): SongAnalysis {
  const checks = report.checks
  const count = checks.length
  const starts = checks.map((c) => clock.seconds(c.note.startBeats))
  const durations = checks.map((c, i) => clock.seconds(c.note.startBeats + c.note.durationBeats) - starts[i]!)
  const sorted = [...durations].sort((a, b) => a - b)
  const median = count ? (count % 2 ? sorted[(count - 1) / 2]! : (sorted[count / 2 - 1]! + sorted[count / 2]!) / 2) : 0

  // Phrase boundaries fall only between different onsets, so simultaneous notes share a phrase. A
  // line without rests or held notes is cut into phrases of MAX_PHRASE_BARS at bar lines [ENG],
  // unless that would leave less than two bars at the end.
  const barBeats = quartersPerBar(song.timeSignature)
  const phraseEnd = new Array<boolean>(count).fill(false)
  let runningEnd = -Infinity
  let phraseFrom = count ? checks[0]!.note.startBeats : 0
  for (let i = 0; i < count; i++) {
    runningEnd = Math.max(runningEnd, starts[i]! + durations[i]!)
    const next = i + 1 < count ? checks[i + 1]!.note : null
    if (next && starts[i + 1]! - starts[i]! < EPS) continue
    let groupHold = 0
    for (let j = i; j >= 0 && starts[i]! - starts[j]! < EPS; j--) groupHold = Math.max(groupHold, durations[j]!)
    let end = next === null || starts[i + 1]! - runningEnd >= PHRASE_GAP - EPS || groupHold >= PHRASE_HOLD * median - EPS
    if (!end && next) {
      const onBar = Math.abs(next.startBeats / barBeats - Math.round(next.startBeats / barBeats)) < EPS
      end =
        onBar &&
        next.startBeats - phraseFrom >= MAX_PHRASE_BARS * barBeats - EPS &&
        song.lengthBeats - next.startBeats >= 2 * barBeats - EPS &&
        runningEnd <= starts[i + 1]! + EPS
    }
    if (end) {
      for (let j = i; j >= 0 && starts[i]! - starts[j]! < EPS; j--) phraseEnd[j] = true
      if (next) phraseFrom = next.startBeats
    }
  }

  // Repetition index per bar pair: same pitches, onsets and durations as an earlier pair.
  const pairBeats = 2 * barBeats
  const pairOf = (beats: number) => Math.floor(beats / pairBeats + EPS)
  const signatures = new Map<number, string[]>()
  for (const c of checks) {
    const p = pairOf(c.note.startBeats)
    const rel = c.note.startBeats - p * pairBeats
    const list = signatures.get(p) ?? []
    list.push(`${rel.toFixed(4)}/${c.note.durationBeats.toFixed(4)}/${c.note.pitch ?? '-'}`)
    signatures.set(p, list)
  }
  const seen = new Map<string, number>()
  const repeatOfPair = new Map<number, number>()
  for (const p of [...signatures.keys()].sort((a, b) => a - b)) {
    const key = signatures.get(p)!.join(' ')
    const k = seen.get(key) ?? 0
    repeatOfPair.set(p, k)
    seen.set(key, k + 1)
  }

  const pitched = checks.map((_, i) => melodic(report, i))
  const notes: NoteContext[] = []
  const phrases: Phrase[] = []
  let phrase = 0
  let prev: number | null = null
  for (let i = 0; i < count; i++) {
    const n = checks[i]!.note
    const phraseStart = i === 0 || (phraseEnd[i - 1]! && starts[i]! - starts[i - 1]! > EPS)
    if (phraseStart && i > 0) phrase++
    if (phraseStart) phrases.push({ first: i, last: i, peak: null, longPeak: null })
    phrases[phrase]!.last = i
    const beat = 60 / clock.bpmAt(n.startBeats)
    const strongBeat = isStrongBeat(song.timeSignature, n.startBeats - Math.floor(n.startBeats / barBeats + EPS) * barBeats)
    const leap = pitched[i] && prev !== null ? n.pitch! - checks[prev]!.note.pitch! : 0
    notes.push({
      start: starts[i]!,
      duration: durations[i]!,
      beat,
      long: durations[i]! >= Math.max(0.6, beat) - EPS,
      veryLong: durations[i]! >= VERY_LONG - EPS,
      phrase,
      phraseStart,
      phraseEnd: phraseEnd[i]!,
      repeat: repeatOfPair.get(pairOf(n.startBeats)) ?? 0,
      strongBeat,
      prev,
      next: null,
      leap
    })
    if (pitched[i]) {
      if (prev !== null) notes[prev]!.next = i
      prev = i
    }
  }

  // Peaks. The climax is judged on notes that are long for this song (at least the median length,
  // or long in absolute terms), so a quick tune without held notes still has one [ENG].
  const higher = (a: number | null, b: number) => a === null || checks[b]!.note.pitch! > checks[a]!.note.pitch!
  const prominent = (i: number) => notes[i]!.long || durations[i]! >= median - EPS
  for (const ph of phrases) {
    let best: number | null = null
    for (let i = ph.first; i <= ph.last; i++) {
      if (!pitched[i]) continue
      if (notes[i]!.long && higher(ph.longPeak, i)) ph.longPeak = i
      if (prominent(i) && higher(ph.peak, i)) ph.peak = i
      if (higher(best, i)) best = i
    }
    ph.peak ??= best
  }
  let climax: number | null = null
  for (let p = 0; p < phrases.length; p++) {
    const peak = phrases[p]!.peak
    if (peak === null) continue
    const current = climax === null ? null : phrases[climax]!.peak!
    const rank = (i: number) => (prominent(i) ? 1 : 0)
    if (current === null || rank(peak) > rank(current) || (rank(peak) === rank(current) && higher(current, peak))) climax = p
  }

  return { notes, phrases, climax, pitch: pitchContext(checks.map((c, i) => (pitched[i] ? c.note.pitch : null))) }
}
