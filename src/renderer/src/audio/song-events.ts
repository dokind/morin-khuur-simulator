/**
 * Instrument events as plain data, and songs turned into timed events. No Tone and no DOM, so the
 * scheduling rules are tested in Node (song-events.test.ts); the instrument (morin-khuur.ts) and
 * the transport (song-player.ts) consume them.
 */

import { legatoGlideSeconds } from '@renderer/core/expression'
import type { StringId } from '@renderer/core/instrument'
import type { Song, VerificationReport } from '@renderer/core/notation'
import {
  performedTiming,
  planPerformance,
  type BowProfile,
  type FrameEvent,
  type PerformancePlan,
  type PitchOrnament,
  type StyleId,
  type VibratoPlan
} from '@renderer/core/performance'
import { midiToFreq } from '@renderer/core/pitch'
import type { BowDirection, TechniqueId } from '@renderer/core/techniques'

/**
 * 'khalkh': the fast slide up and stepped, neighing descent. 'inner-mongolian': a shaking glissando
 * up from the open string and back down with the same shake, with a trill of a fifth at the top
 * (matouqin horse imitation: D'Evelyn; fifth trills in horse passages).
 */
export type WhinnyVariant = 'khalkh' | 'inner-mongolian'

/** Everything needed to sound one notated event. Frequencies are explicit so harmonics can be just-tuned. */
export interface NoteEvent {
  technique: TechniqueId
  string: StringId | null
  /** Sounding frequency, or null for unpitched strikes. */
  freq: number | null
  duration: number
  velocity: number
  bow: BowDirection | null
  slur?: boolean
  vibrato?: boolean
  tremolo?: boolean
  wavy?: boolean
  accent?: boolean
  position?: number
  glideTo?: number | null
  /** Double stop: frequency on the other string. */
  droneFreq?: number | null
  /** Expressive slide into the note from below (not part of the notation). */
  scoop?: { semitones: number; seconds: number } | null
  /** Legato glide time for slurred notes, seconds. */
  glide?: number | null
  // --- performance plan (core/performance: NotePerformance); never part of the notation ---
  /** Left-hand ornaments, in time order. */
  ornaments?: readonly PitchOrnament[]
  /**
   * Planned vibrato. `undefined`: the instrument's own rule (notated vibrato, a little on long
   * stopped notes); `null`: none unless notated (songs played as written). Depth scales with
   * `vibratoCents`.
   */
  vibratoPlan?: VibratoPlan | null
  bowProfile?: BowProfile
  positionRamp?: { from: number; to: number } | null
  shurankhai?: boolean
  /** Automatic drone: the other string, open, at this velocity multiplier (continuous across notes). */
  droneLevel?: number | null
  /** A framing stroke on both open strings (om zee, long-song prelude, coda); not a score note. */
  frame?: FrameEvent['kind'] | null
  /** Horse whinny style. */
  whinny?: WhinnyVariant
}

export interface TimedEvent {
  /** Index into `report.checks` (the song's notes in sorted order), or -1 for a framing stroke that is not a score note. */
  order: number
  start: number
  event: NoteEvent
}

export interface SongEventOptions {
  /**
   * Playing style; defaults to the song's own (`resolveStyle`). 'as-written' plays exactly the
   * notes: what they write (vibrato, accents, tremolo…) and nothing else, not even the
   * instrument's own light vibrato on long notes.
   */
  style?: StyleId
  /** Ornament density, 0–2 (default 1). */
  amount?: number
  /** false plays as written, whatever `style` says (the older on/off switch). */
  expressive?: boolean
  /** Framing strokes (om zee, long-song prelude and coda) and the lead-in they need (default on). */
  frames?: boolean
  /**
   * Lock the song to a constant-tempo bar grid at `bpm`, for playing with other parts (Studio):
   * every note starts and lasts as written, without the song's tempo map (the other parts keep a
   * steady tempo) — no rubato, breaths, onset jitter or held endings — and there are no framing
   * strokes. Ornaments, vibrato and bow shapes are still performed, planned for those durations.
   */
  grid?: boolean
}

export interface SongPerformance {
  /** Score notes and framing strokes (order -1), in time order. */
  events: TimedEvent[]
  style: StyleId
  /** The style repeats the tune until stopped (bii dance tunes end when the dancer stops). */
  loop: boolean
}

/** The plan's per-note decisions without its timing: onsets and lengths as written. */
const onGrid = (plan: PerformancePlan): PerformancePlan => ({ ...plan, notes: plan.notes.map((n) => ({ ...n, timeOffset: 0, durationScale: 1 })) })

/** The song at one steady tempo: its tempo map dropped (the grid mode's clock). */
const steadyTempo = (song: Song): Song => (song.tempoMap ? { ...song, tempoMap: undefined } : song)

/**
 * A verified song performed at `bpm` in a style (core/performance): each note's ornaments, vibrato,
 * bow shape and timing come from the plan, framing strokes (order -1) are placed around the notes,
 * and slurred pitch changes glide by interval. 'as-written' (or `expressive: false`) plays exactly
 * the notation, with no automatic vibrato either. The song's tempo map applies in every style
 * (not on the grid, which keeps one tempo). Verification and the acoustic test never see any of this.
 *
 * The events are sorted by start time: a stroke cancels whatever its string had scheduled after
 * it, so events must reach the instrument in time order.
 */
export function songPerformance(
  song: Song,
  report: VerificationReport,
  bpm = song.tempoBpm,
  { style, amount, expressive = true, frames = true, grid = false }: SongEventOptions = {}
): SongPerformance {
  // On the grid the plan is made for the steady-tempo durations too, so its ornaments fit them.
  const clocked = grid ? steadyTempo(song) : song
  const plan = planPerformance(clocked, report, bpm, { style: expressive ? style : 'as-written', ...(amount !== undefined ? { amount } : {}) })
  const performed = plan.style !== 'as-written'
  const framed = frames && !grid
  // Tempo map, lead-in, rubato and held notes (on the grid: onsets and lengths as written at `bpm`).
  const timing = performedTiming(grid ? onGrid(plan) : plan, clocked, report, bpm)
  // Without frames the song starts on its first bar: the lead-in only makes room for them.
  const shift = framed ? 0 : plan.leadIn

  let prevPitch: number | null = null
  const events: TimedEvent[] = report.checks.map((check, order) => {
    const n = check.note
    const glide = performed && n.slur && prevPitch !== null && n.pitch !== null ? legatoGlideSeconds(prevPitch, n.pitch) : null
    if (n.pitch !== null) prevPitch = n.pitch
    const p = performed ? plan.notes[order] : undefined
    const at = timing.notes[order]!
    const freq = check.passed && check.expectedFreq !== null ? check.expectedFreq : n.pitch !== null ? midiToFreq(n.pitch) : null
    const event: NoteEvent = {
      technique: n.technique,
      string: n.string,
      freq,
      duration: at.duration,
      velocity: n.velocity,
      bow: n.bow,
      slur: n.slur,
      vibrato: n.articulations.includes('vibrato'),
      tremolo: n.articulations.includes('tremolo'),
      wavy: n.articulations.includes('wavy'),
      accent: n.articulations.includes('accent'),
      position: n.articulations.includes('sul_ponticello') ? 1 : n.articulations.includes('sul_tasto') ? -1 : 0,
      glideTo: n.glideTo !== null ? midiToFreq(n.glideTo) : null,
      droneFreq: n.drone !== null ? midiToFreq(n.drone) : null,
      scoop: null,
      glide
    }
    if (p) {
      if (p.ornaments.length) event.ornaments = p.ornaments
      event.vibratoPlan = p.vibrato
      event.bowProfile = p.bow
      if (p.positionRamp) event.positionRamp = p.positionRamp
      if (p.shurankhai) event.shurankhai = true
      if (p.drone) event.droneLevel = p.drone.level
    } else {
      // As written: notated vibrato only, without the instrument's own on long stopped notes.
      event.vibratoPlan = null
    }
    if (plan.style === 'inner-mongolian' && n.technique === 'horse_whinny') event.whinny = 'inner-mongolian'
    return { order, start: Math.max(0, at.start - shift), event }
  })

  if (performed && framed) {
    plan.frames.forEach((f, i) => {
      events.push({
        order: -1,
        start: Math.max(0, timing.frames[i]!.start),
        event: { technique: 'double_stop', string: null, freq: null, duration: f.duration, velocity: f.velocity, bow: f.bow, frame: f.kind }
      })
    })
  }
  // Stable: notes that share an onset keep their score order.
  events.sort((a, b) => a.start - b.start)
  return { events, style: plan.style, loop: performed && !!plan.loop }
}

/** Timed instrument events for a song, in time order: `songPerformance(...).events`. */
export function songEvents(song: Song, report: VerificationReport, bpm = song.tempoBpm, opts: SongEventOptions = {}): TimedEvent[] {
  return songPerformance(song, report, bpm, opts).events
}

export function eventsDuration(events: readonly TimedEvent[]): number {
  return events.reduce((end, e) => Math.max(end, e.start + e.event.duration), 0)
}
