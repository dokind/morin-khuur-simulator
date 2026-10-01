/**
 * Ornament and vibrato builders (plan §4.3). Each builder returns an ornament that a player could
 * actually make on the note, or null: ornament notes stay on the note's string within one hand
 * frame, never below the nut (so nothing slides or falls into an open string from below), and use
 * the song's own pitch set (see `neighbour`). Timings are [ENG] (presets.ts).
 */

import type { NoteCheck } from '../notation'
import { isGlissando, TECHNIQUES, type TechniqueId } from '../techniques'
import { neighbour, reachable, type PitchContext } from './phrases'
import { LYRICAL_RATE_JITTER, ORNAMENT_TIMING as T, VIBRATO_SHAPES } from './presets'
import { makeRng, type Rng } from './rng'
import type { PitchOrnament, VibratoPlan, VibratoShape } from './types'

/** Bowed melodic techniques that take pitch ornaments; open strings only take ornaments above them (nothing goes below the nut: `reachable`). */
const MELODIC: ReadonlySet<TechniqueId> = new Set([
  'open',
  'cuticle_side_stop',
  'fingernail_side_stop',
  'vibrato',
  'tremolo',
  'erkhii_darakh',
  'double_stop',
  'sul_ponticello',
  'sul_tasto'
])

/**
 * How a note may be ornamented: 'melodic' (any ornament that fits), 'gallop' (a galloping-bow
 * stroke: only trot slides and finger hammers are added automatically) or null (harmonics, plucks,
 * percussion, the whinny, glissandi and glides, notes that failed verification).
 */
export function ornamentClass(check: NoteCheck): 'melodic' | 'gallop' | null {
  const n = check.note
  if (!check.passed || n.pitch === null || n.string === null || check.stop === null || n.glideTo !== null) return null
  if (isGlissando(n.technique) || TECHNIQUES[n.technique].kind !== 'stopped') return null
  if (n.technique === 'gallop') return 'gallop'
  return MELODIC.has(n.technique) ? 'melodic' : null
}

/** Bowed, pitched and sounding: takes vibrato, bow profiles and position ramps. */
export function isBowedTone(check: NoteCheck): boolean {
  const n = check.note
  return n.pitch !== null && n.string !== null && TECHNIQUES[n.technique].kind === 'stopped' && TECHNIQUES[n.technique].needsBow
}

export interface OrnamentTarget {
  pitch: number
  stop: number
  ctx: PitchContext
}

export const targetOf = (check: NoteCheck, ctx: PitchContext): OrnamentTarget => ({ pitch: check.note.pitch!, stop: check.stop!, ctx })

const fitsOn = (t: OrnamentTarget) => (offset: number) => reachable(t.stop, offset)

/** Slide into the note from its lower neighbour (plan F1: 2–3 semitones, never an unstepped semitone). */
export function scoop(t: OrnamentTarget, seconds: number): PitchOrnament | null {
  const s = neighbour(t.pitch, -1, t.ctx, { fallback: true, fits: fitsOn(t) })
  return s === null ? null : { kind: 'scoop', semitones: s, seconds, at: 'start' }
}

/** Front grace note (前倚音) a second or third away, preferring `dir`. */
export function grace(t: OrnamentTarget, dir: 1 | -1, rng: Rng): PitchOrnament | null {
  const s = neighbour(t.pitch, dir, t.ctx, { fits: fitsOn(t) }) ?? neighbour(t.pitch, dir === 1 ? -1 : 1, t.ctx, { fits: fitsOn(t) })
  return s === null ? null : { kind: 'grace', semitones: s, seconds: rng.uniform(T.graceHold[0], T.graceHold[1]) + T.graceMove, at: 'start' }
}

/** Hammered upper note (打音): a third above, struck at the onset. */
export function hammer(t: OrnamentTarget, rng: Rng): PitchOrnament | null {
  const s = neighbour(t.pitch, 1, t.ctx, { distances: [3, 4], semitone: false, fits: fitsOn(t) })
  return s === null ? null : { kind: 'hammer', semitones: s, seconds: rng.uniform(T.hammer[0], T.hammer[1]), at: 'start' }
}

/** Mordent (波音): main, neighbour, main. */
export function mordent(t: OrnamentTarget, dir: 1 | -1): PitchOrnament | null {
  const opts = { distances: [2, 3, 4], fits: fitsOn(t) }
  const s = neighbour(t.pitch, dir, t.ctx, opts) ?? neighbour(t.pitch, dir === 1 ? -1 : 1, t.ctx, opts)
  return s === null ? null : { kind: 'mordent', semitones: s, seconds: 2 * T.mordentStep, at: 'start' }
}

/**
 * Trill with the upper neighbour: a major third if it is in the song's pitch set, else a minor
 * third, else a whole tone. 'end' is the after-trill from 0.6 of the note; 'whole' covers the note.
 * `duration` is the performed length of the note.
 */
export function trill(t: OrnamentTarget, at: 'end' | 'whole', duration: number): PitchOrnament | null {
  const seconds = at === 'end' ? duration * (1 - T.trillFrom) : duration
  if (seconds < T.trillMin - 1e-9) return null
  const s = neighbour(t.pitch, 1, t.ctx, { distances: [4, 3, 2], semitone: false, fits: fitsOn(t) })
  if (s === null) return null
  return {
    kind: 'trill',
    semitones: s,
    seconds,
    at,
    rateHz: T.trillRateHz,
    upperGainDb: T.trillUpperGainDb,
    ...(at === 'end' ? { from: T.trillFrom } : {})
  }
}

/** Fall off the note at its release (шувтраа) to the lower neighbour. */
export function fall(t: OrnamentTarget, rng: Rng): PitchOrnament | null {
  const s = neighbour(t.pitch, -1, t.ctx, { fallback: true, fits: fitsOn(t) })
  return s === null ? null : { kind: 'fall', semitones: s, seconds: rng.uniform(T.fall[0], T.fall[1]), at: 'end' }
}

/** Short slide into a stopped note in trotting and gallop passages, a whole tone or a stepped semitone. */
export function trotSlide(t: OrnamentTarget, rng: Rng): PitchOrnament | null {
  const s = neighbour(t.pitch, -1, t.ctx, { distances: [2], fallback: true, fits: fitsOn(t) })
  return s === null ? null : { kind: 'trot-slide', semitones: s, seconds: rng.uniform(T.trotSlide[0], T.trotSlide[1]), at: 'start' }
}

/** A shift of the hand by at least this many stops on one string is heard as a slide [Dymbrylov]. */
export const SHIFT_STOPS = 5

/** Audible shift from the previous stopped pitch on the same string. */
export function shiftSlide(prevStop: number, stop: number): PitchOrnament | null {
  if (prevStop <= 0 || stop <= 0 || Math.abs(stop - prevStop) < SHIFT_STOPS) return null
  return { kind: 'shift-slide', semitones: prevStop - stop, seconds: T.shiftSlide, at: 'start' }
}

/**
 * Keeps each start or end gesture within `maxShare` of the note and all of them inside it (a trill
 * spans its own part of the note); returns them in time order.
 */
export function fitOrnaments(ornaments: readonly PitchOrnament[], duration: number): PitchOrnament[] {
  const kept: PitchOrnament[] = []
  let used = 0
  for (const o of ornaments) {
    if (o.kind !== 'trill' && o.seconds > T.maxShare * duration + 1e-9) continue
    if (used + o.seconds > duration + 1e-9) continue
    kept.push(o)
    used += o.seconds
  }
  const order = { start: 0, whole: 1, end: 2 }
  return kept.sort((a, b) => order[a.at] - order[b.at])
}

// ---------------------------------------------------------------------------------------------
// Vibrato
// ---------------------------------------------------------------------------------------------

/**
 * A vibrato plan. Lyrical depth follows the current engine (28 cents × 1.3 notated or × 0.5
 * automatic, widening with the note: breadth 0.7–1.2 up to 1.5 s); the other shapes use fixed
 * depths [ENG]. Depths are for the engine's default 28-cent vibrato: scale by the instrument's
 * setting / 28 if it has one.
 */
export function vibratoPlan(shape: VibratoShape, notated: boolean, placement: VibratoPlan['placement'], duration: number, rng: Rng): VibratoPlan {
  const s = VIBRATO_SHAPES[shape]
  const breadth = shape === 'lyrical' ? 0.7 + 0.5 * Math.min(1, duration / 1.5) : 1
  return {
    cents: (notated ? s.notated : s.auto) * breadth,
    rateHz: shape === 'lyrical' ? s.rateHz + rng.uniform(-LYRICAL_RATE_JITTER, LYRICAL_RATE_JITTER) : s.rateHz,
    placement,
    shape,
    amDb: s.amDb,
    roughnessBoost: s.roughness,
    seed: rng.int()
  }
}

export interface VibratoSegment {
  /** Seconds from the note start. */
  start: number
  duration: number
  rateHz: number
  /** ± cents. */
  cents: number
}

/**
 * Segments of an aperiodic ('nogula') vibrato over a note: 150–400 ms each, rate 4.5–7 Hz and
 * depth 0–`plan.cents`, all drawn from `plan.seed`, so the audio layer and tests agree. Other shapes
 * return one steady segment.
 */
export function vibratoSegments(plan: VibratoPlan, duration: number): VibratoSegment[] {
  if (plan.shape !== 'nogula') return [{ start: 0, duration, rateHz: plan.rateHz, cents: plan.cents }]
  const rng = makeRng(plan.seed)
  const segments: VibratoSegment[] = []
  for (let t = 0; t < duration - 1e-9; ) {
    const d = Math.min(rng.uniform(0.15, 0.4), duration - t)
    segments.push({ start: t, duration: d, rateHz: rng.uniform(4.5, 7), cents: rng.uniform(0, plan.cents) })
    t += d
  }
  return segments
}
