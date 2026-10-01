/**
 * Performed timing: long-song rubato and breath gaps as a monotone time warp over the notes'
 * onsets, plus seeded onset jitter. Notes that share an onset move together, a note that ends where
 * another starts still ends there (legato is kept), and no onset ever moves before the previous one.
 */

import type { VerificationReport } from '../notation'
import type { SongAnalysis } from './phrases'
import { RUBATO, type StylePreset } from './presets'
import { noteRng } from './rng'

export interface Timing {
  /** Performed start and end of each note, clock seconds (before the plan's lead-in). */
  start: number[]
  end: number[]
}

const EPS = 1e-6
/** Jitter never exceeds this many standard deviations, nor a quarter of the neighbouring intervals and notes. */
const JITTER_CLAMP = 2.5
const JITTER_SHARE = 0.25

interface Slice {
  u: number
  members: number[]
  /** Stretch applied to the first `span` seconds of the slice, and extra silence before it. */
  stretch: number
  span: number
  breath: number
  /** Cumulative shift of the slice's onset. */
  shift: number
}

/** `finalHold`: seconds added to the notes that end the song (long-song "settle together"). */
export function planTiming(title: string, report: VerificationReport, analysis: SongAnalysis, preset: StylePreset, finalHold: number): Timing {
  const notes = analysis.notes
  const start = notes.map((c) => c.start)
  const end = notes.map((c) => c.start + c.duration)
  const { jitter, rubato, breathGap } = preset.timing
  if (!notes.length || (!rubato && jitter === 0 && finalHold === 0)) return { start, end }
  const songEnd = Math.max(...end)

  const slices: Slice[] = []
  notes.forEach((c, i) => {
    const last = slices[slices.length - 1]
    if (last && c.start - last.u < EPS) last.members.push(i)
    else slices.push({ u: c.start, members: [i], stretch: 1, span: 0, breath: 0, shift: 0 })
  })

  // Rubato: rising notes are slower and steadier, phrase-final long notes are held [ENG factors].
  slices.forEach((s, j) => {
    const length = (j + 1 < slices.length ? slices[j + 1]!.u : songEnd) - s.u
    if (rubato) {
      for (const i of s.members) {
        const c = notes[i]!
        const f = (c.leap > 0 ? RUBATO.ascending : 1) * (c.phraseEnd && c.long ? RUBATO.phraseFinal : 1)
        if (f > s.stretch || (f === s.stretch && c.duration > s.span)) {
          s.stretch = f
          s.span = Math.min(length, c.duration)
        }
      }
      if (j > 0 && notes[s.members[0]!]!.phraseStart) s.breath = breathGap
    }
    if (j > 0) {
      const p = slices[j - 1]!
      s.shift = p.shift + p.span * (p.stretch - 1) + s.breath
    }
  })

  const sliceAt = (t: number): number => {
    let lo = 0
    let hi = slices.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const u = slices[mid]!.u
      if (Math.abs(u - t) < EPS) return mid
      if (u < t) lo = mid + 1
      else hi = mid - 1
    }
    return -1
  }
  /** Performed time of a note end at written time t (left of any breath gap at t). */
  const mapEnd = (t: number): number => {
    // The last slice starting strictly before t.
    let lo = 0
    let hi = slices.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (slices[mid]!.u < t - EPS) lo = mid
      else hi = mid - 1
    }
    const s = slices[lo]!
    if (t <= s.u) return t + s.shift
    return t + s.shift + Math.min(t - s.u, s.span) * (s.stretch - 1)
  }
  const onset = (j: number) => slices[j]!.u + slices[j]!.shift

  // Jitter per onset, clamped so order and at least half of every note survive.
  const endingAt = new Map<number, number[]>()
  notes.forEach((c, i) => {
    const k = sliceAt(c.start + c.duration)
    if (k >= 0) endingAt.set(k, [...(endingAt.get(k) ?? []), i])
  })
  const shiftBy = slices.map(() => 0)
  if (jitter > 0) {
    for (let j = 1; j < slices.length; j++) {
      const s = slices[j]!
      let limit = Math.min(JITTER_CLAMP * jitter, JITTER_SHARE * (onset(j) - onset(j - 1)))
      if (j + 1 < slices.length) limit = Math.min(limit, JITTER_SHARE * (onset(j + 1) - onset(j)))
      for (const i of s.members) limit = Math.min(limit, JITTER_SHARE * (mapEnd(end[i]!) - onset(j)))
      for (const i of endingAt.get(j) ?? []) limit = Math.min(limit, JITTER_SHARE * (mapEnd(end[i]!) - onset(sliceAt(start[i]!))))
      const g = jitter * noteRng(title, report.checks[s.members[0]!]!.note.index, 'onset').gaussian()
      shiftBy[j] = Math.max(-limit, Math.min(limit, g))
    }
  }

  const performedStart = notes.map((_, i) => {
    const j = sliceAt(start[i]!)
    return onset(j) + shiftBy[j]!
  })
  const performedEnd = notes.map((_, i) => {
    const k = sliceAt(end[i]!)
    const e = (k >= 0 ? mapEnd(end[i]!) + shiftBy[k]! : mapEnd(end[i]!)) + (end[i]! >= songEnd - EPS ? finalHold : 0)
    return e
  })
  return { start: performedStart, end: performedEnd }
}
