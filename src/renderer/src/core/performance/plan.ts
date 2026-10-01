/**
 * The performance planner: what a player adds to a verified song in a given style (presets.ts),
 * as pure data for the audio layer. Deterministic: every random choice is seeded from the title
 * and the note (rng.ts), so the same song, tempo and options always give the same plan.
 *
 * 'as-written' is notation only: the plan is neutral (no ornaments, no automatic vibrato, bowing
 * profile or timing, no frames), and the audio layer adds nothing of its own either (no default
 * vibrato on long stopped notes). What the file writes — notated vibrato, tremolo, accents, wavy
 * bowing, glides, drones and the tempo map — is still played from the notes themselves. The note-
 * and song-level performance hints (`ornament`, `vibratoPlacement`, `style`, `ornamentAmount`,
 * `frame`) are ignored in 'as-written'.
 *
 * In every other style notated vibrato always gets a VibratoPlan, note-level hints win over the
 * automatic rules, and nothing is ever added that the hand could not do: ornament notes stay on
 * the string within one hand frame, never below the nut, and use the song's own pitch set.
 */

import type { NoteCheck, Song, VerificationReport } from '../notation'
import {
  fall,
  fitOrnaments,
  grace,
  hammer,
  isBowedTone,
  mordent,
  ornamentClass,
  scoop,
  shiftSlide,
  targetOf,
  trill,
  trotSlide,
  vibratoPlan,
  type OrnamentTarget
} from './ornaments'
import { analyzeSong, type NoteContext, type SongAnalysis } from './phrases'
import { density, DRONE_LEVEL, FAST_NOTE, FRAMES, ORNAMENT_TIMING, POSITION_RAMP, PRESETS, SHURANKHAI_COUNT, type PresetStyle, type StylePreset } from './presets'
import { noteRng, type Rng } from './rng'
import { isBorjgin, resolveLevel, resolveStyle } from './style'
import { songClock } from './tempo'
import { planTiming, type Timing } from './timing'
import type { BowProfile, FrameEvent, LongSongLevel, NotePerformance, PerformancePlan, PitchOrnament, PlanOptions, StyleId, VibratoPlan } from './types'

export { resolveStyle, STYLES } from './style'

const EPS = 1e-6
/** Scoops in the stage style: phrase-start notes at least this long (s), or long notes after leaps of `STAGE_LEAP`+. */
const STAGE_SCOOP_MIN = 0.8
const STAGE_LEAP = 5
const LONG_SONG_LEAP = 3
/** A shift slide needs the notes (almost) joined: at most this gap, s. */
const SHIFT_GAP = 0.1
/** Graces take the preferred direction from above this often [ENG]. */
const GRACE_FROM_ABOVE = 0.6
const MORDENT_UPPER = 0.7
/**
 * Stopped notes shorter than this (s) do not get automatic lyrical vibrato in the stage style. On
 * the conservatory reference recording 73 % of sustained notes carry vibrato, down to 0.6 s.
 */
const AUTO_VIBRATO_MIN = 0.6

const neutral = (order: number): NotePerformance => ({
  order,
  timeOffset: 0,
  durationScale: 1,
  ornaments: [],
  vibrato: null,
  bow: 'swell',
  positionRamp: null,
  shurankhai: false,
  drone: null
})

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export function planPerformance(song: Song, report: VerificationReport, bpm: number, opts: PlanOptions = {}): PerformancePlan {
  const style: StyleId = opts.style ?? resolveStyle(song)
  if (style === 'as-written') return { style, notes: report.checks.map((_, order) => neutral(order)), frames: [], leadIn: 0 }

  const preset = PRESETS[style]
  const level = opts.level ?? resolveLevel(song)
  const requested = (song.ornamentAmount ?? 1) * (opts.amount ?? 1)
  const amount = Number.isFinite(requested) ? clamp(requested, 0, 2) : 1
  const analysis = analyzeSong(song, report, songClock(song, bpm))
  const openFrame = song.frame?.open ?? preset.frames.open
  const closeFrame = song.frame?.close ?? preset.frames.close
  // The long song closes by holding its final note rather than with extra strokes.
  const finalHold = style === 'urtiin-duu' && closeFrame ? FRAMES.finalHold : 0
  const timing = planTiming(song.title, report, analysis, preset, finalHold)
  const shurankhai = preset.shurankhai ? pickShurankhai(report, analysis, SHURANKHAI_COUNT[level]) : new Set<number>()

  const planner = new NotePlanner(song, report, analysis, timing, style, preset, level, amount)
  const notes = report.checks.map((check, order) => planner.plan(check, order, shurankhai.has(order)))
  const { frames, leadIn } = planFrames(style, openFrame, closeFrame, timing)

  return {
    style,
    notes,
    frames,
    leadIn,
    ...(style === 'urtiin-duu' ? { level } : {}),
    ...(preset.loop ? { loop: true } : {})
  }
}

/**
 * Absolute times for scheduling a plan: note starts and durations and frame starts, in seconds
 * from the start of playback (lead-in and tempo map included).
 */
export function performedTiming(
  plan: PerformancePlan,
  song: Song,
  report: VerificationReport,
  bpm: number
): { notes: { start: number; duration: number }[]; frames: { start: number; duration: number }[] } {
  const clock = songClock(song, bpm)
  const notes = report.checks.map((c, i) => {
    const s = clock.seconds(c.note.startBeats)
    const d = clock.seconds(c.note.startBeats + c.note.durationBeats) - s
    const p = plan.notes[i]
    return { start: plan.leadIn + s + (p?.timeOffset ?? 0), duration: d * (p?.durationScale ?? 1) }
  })
  const first = notes.length ? Math.min(...notes.map((n) => n.start)) : plan.leadIn
  return { notes, frames: plan.frames.map((f) => ({ start: first + f.start, duration: f.duration })) }
}

class NotePlanner {
  private readonly trillsInPhrase = new Map<number, number>()
  private readonly borjgin: boolean

  constructor(
    private readonly song: Song,
    private readonly report: VerificationReport,
    private readonly analysis: SongAnalysis,
    private readonly timing: Timing,
    private readonly style: PresetStyle,
    private readonly preset: StylePreset,
    private readonly level: LongSongLevel,
    private readonly amount: number
  ) {
    this.borjgin = isBorjgin(song)
  }

  plan(check: NoteCheck, order: number, shurankhai: boolean): NotePerformance {
    const c = this.analysis.notes[order]!
    const start = this.timing.start[order]!
    const duration = this.timing.end[order]! - start
    const rng = (purpose: string) => noteRng(this.song.title, check.note.index, purpose)

    const ornaments = fitOrnaments(this.ornaments(check, order, c, duration), duration)
    const hasTrill = ornaments.some((o) => o.kind === 'trill')
    return {
      order,
      timeOffset: start - c.start,
      durationScale: c.duration > 0 ? duration / c.duration : 1,
      ornaments,
      vibrato: this.vibrato(check, c, duration, hasTrill, rng('vibrato')),
      bow: this.bow(check, duration),
      positionRamp: shurankhai ? null : this.positionRamp(check, order, c),
      shurankhai,
      drone: this.drone(check, order) ? { level: DRONE_LEVEL } : null
    }
  }

  // --- ornaments ----------------------------------------------------------------------------

  private ornaments(check: NoteCheck, order: number, c: NoteContext, duration: number): PitchOrnament[] {
    const n = check.note
    const cls = ornamentClass(check)
    if (!cls || n.ornament === 'none') return []
    const t = targetOf(check, this.analysis.pitch)
    const rng = (purpose: string) => noteRng(this.song.title, n.index, purpose)
    if (n.ornament) {
      const o = this.hinted(n.ornament, t, duration, rng)
      return o ? [o] : []
    }
    if (this.amount <= 0) return []

    const rho = density(this.style, this.level, this.amount, c.repeat)
    const p = this.preset
    const out: PitchOrnament[] = []

    // Onset gesture: at most one, and none on a slurred continuation (it glides in legato instead).
    if (!n.slur) {
      const first = [
        () => (p.shiftSlides && cls === 'melodic' ? this.shift(check, c) : null),
        () => (cls === 'melodic' && this.wantsScoop(c, rng('scoop').chance(p.scoop * rho)) ? scoop(t, p.scoopSeconds) : null),
        () =>
          p.trotSlide > 0 && t.stop > 0 && (cls === 'gallop' || c.duration < FAST_NOTE) && this.otherStringBefore(check, c) && rng('trot').chance(p.trotSlide * rho)
            ? trotSlide(t, rng('trot-length'))
            : null,
        () =>
          p.grace > 0 && cls === 'melodic' && this.graceHere(check, c) && rng('grace').chance(p.grace * rho)
            ? grace(t, rng('grace-dir').next() < GRACE_FROM_ABOVE ? 1 : -1, rng('grace-length'))
            : null,
        () => (p.hammer > 0 && this.hammerHere(check, c, cls) && rng('hammer').chance(p.hammer * rho) ? hammer(t, rng('hammer-length')) : null),
        () => (p.mordent > 0 && cls === 'melodic' && rng('mordent').chance(p.mordent * rho) ? mordent(t, rng('mordent-dir').next() < MORDENT_UPPER ? 1 : -1) : null)
      ]
      for (const make of first) {
        const o = make()
        if (o) {
          out.push(o)
          break
        }
      }
    }

    // Release gesture: a trill (never over notated vibrato) or a fall at a phrase end.
    if (cls === 'melodic') {
      const notatedVibrato = n.articulations.includes('vibrato') || n.technique === 'vibrato'
      const phrase = c.phrase
      const trillSpot =
        p.trill > 0 &&
        !notatedVibrato &&
        c.long &&
        (p.trillOn === 'long' || (this.analysis.phrases[phrase]!.longPeak === order && (this.trillsInPhrase.get(phrase) ?? 0) < 1))
      const tr = trillSpot && rng('trill').chance(p.trill * rho) ? trill(t, 'end', duration) : null
      if (tr) {
        out.push(tr)
        this.trillsInPhrase.set(phrase, (this.trillsInPhrase.get(phrase) ?? 0) + 1)
      } else if (p.fall > 0 && c.phraseEnd && order < this.report.checks.length - 1 && !this.report.checks[order + 1]!.note.slur && rng('fall').chance(p.fall * rho)) {
        const f = fall(t, rng('fall-length'))
        if (f) out.push(f)
      }
    }
    return out
  }

  /** A note-level `ornament` hint: that one ornament, if the hand can make it on this note. */
  private hinted(kind: NonNullable<NoteCheck['note']['ornament']>, t: OrnamentTarget, duration: number, rng: (purpose: string) => Rng): PitchOrnament | null {
    switch (kind) {
      case 'scoop':
        return scoop(t, this.preset.scoopSeconds)
      case 'grace':
        return grace(t, rng('grace-dir').next() < GRACE_FROM_ABOVE ? 1 : -1, rng('grace-length'))
      case 'hammer':
        return hammer(t, rng('hammer-length'))
      case 'mordent':
        return mordent(t, 1)
      case 'trill':
        return trill(t, duration * (1 - ORNAMENT_TIMING.trillFrom) >= ORNAMENT_TIMING.trillMin ? 'end' : 'whole', duration)
      case 'fall':
        return fall(t, rng('fall-length'))
      default:
        return null
    }
  }

  private wantsScoop(c: NoteContext, lucky: boolean): boolean {
    switch (this.preset.scoopRule) {
      case 'stage':
        return (c.phraseStart && c.duration >= STAGE_SCOOP_MIN - EPS) || (c.long && c.leap >= STAGE_LEAP)
      case 'long-song':
        return c.long && (c.phraseStart || c.leap >= LONG_SONG_LEAP)
      case 'chance':
        return c.long && lucky
    }
  }

  /** Shift slide from the previous note when it is on the same string, stopped, and (almost) joined. */
  private shift(check: NoteCheck, c: NoteContext): PitchOrnament | null {
    if (c.prev === null) return null
    const prev = this.report.checks[c.prev]!
    const pc = this.analysis.notes[c.prev]!
    if (prev.note.string !== check.note.string || ornamentClass(prev) !== 'melodic' || c.start - (pc.start + pc.duration) > SHIFT_GAP + EPS) return null
    return shiftSlide(prev.stop!, check.stop!)
  }

  private otherStringBefore(check: NoteCheck, c: NoteContext): boolean {
    return c.prev !== null && this.report.checks[c.prev]!.note.string !== check.note.string
  }

  private accented(check: NoteCheck, c: NoteContext): boolean {
    return check.note.articulations.includes('accent') || check.note.velocity >= 0.9 || c.strongBeat
  }

  private graceHere(check: NoteCheck, c: NoteContext): boolean {
    return this.preset.graceOn === 'accented' ? this.accented(check, c) : c.long && (c.strongBeat || c.phraseStart || check.note.articulations.includes('accent'))
  }

  private hammerHere(check: NoteCheck, c: NoteContext, cls: 'melodic' | 'gallop'): boolean {
    if (this.preset.hammerOn === 'hoofbeat') return (cls === 'gallop' || c.duration < FAST_NOTE) && this.accented(check, c)
    return cls === 'melodic' && check.note.durationBeats >= 1 - EPS && c.strongBeat
  }

  // --- vibrato, bow, position, drone ----------------------------------------------------------

  private vibrato(check: NoteCheck, c: NoteContext, duration: number, hasTrill: boolean, rng: Rng): VibratoPlan | null {
    const n = check.note
    if (!isBowedTone(check)) return null
    const v = this.preset.vibrato
    let shape = v.shape
    if (this.style === 'urtiin-duu' && this.borjgin) shape = 'bonjignokh'
    if (shape === 'nogula' && !c.veryLong) shape = 'lyrical'
    const placement = n.vibratoPlacement ?? v.placement
    const notated = n.articulations.includes('vibrato') || n.technique === 'vibrato' || n.vibratoPlacement !== undefined
    if (notated) return vibratoPlan(shape, true, placement, duration, rng)

    const automatic =
      check.passed &&
      !hasTrill &&
      (check.stop ?? 0) > 0 &&
      n.technique !== 'gallop' &&
      n.technique !== 'shigshikh_glissando' &&
      (v.auto === 'over-0.9' ? duration > AUTO_VIBRATO_MIN : v.auto === 'long' ? c.long : v.auto === 'very-long' ? c.veryLong : false)
    return automatic ? vibratoPlan(shape, false, placement, duration, rng) : null
  }

  private bow(check: NoteCheck, duration: number): BowProfile {
    const n = check.note
    // Slurred notes continue the stroke; tremolo and wavy bowing are written bow strokes of their own.
    if (!isBowedTone(check) || n.slur || n.technique === 'tremolo' || n.articulations.includes('tremolo') || n.articulations.includes('wavy')) return 'swell'
    const b = this.preset.bow
    if (b === 'accent-release-fast') return duration < FAST_NOTE ? 'accent-release' : 'swell'
    return b
  }

  /** The bow drifts towards the bridge over the last 40% of the climax phrase [Bulanov]. */
  private positionRamp(check: NoteCheck, order: number, c: NoteContext): { from: number; to: number } | null {
    const climax = this.analysis.climax
    const n = check.note
    if (!this.preset.positionRamp || climax === null || c.phrase !== climax || !isBowedTone(check)) return null
    if (n.articulations.includes('sul_ponticello') || n.articulations.includes('sul_tasto') || n.technique === 'sul_ponticello' || n.technique === 'sul_tasto') return null
    const ph = this.analysis.phrases[climax]!
    const p0 = this.timing.start[ph.first]!
    let p1 = p0
    for (let i = ph.first; i <= ph.last; i++) p1 = Math.max(p1, this.timing.end[i]!)
    const w0 = p0 + (1 - POSITION_RAMP.share) * (p1 - p0)
    if (p1 - w0 <= EPS) return null
    const at = (x: number) => POSITION_RAMP.to * clamp((x - w0) / (p1 - w0), 0, 1)
    const ramp = { from: at(this.timing.start[order]!), to: at(this.timing.end[order]!) }
    return ramp.to > EPS ? ramp : null
  }

  /** Automatic open drone on the male string under a female-string note, when the male string is free. */
  private drone(check: NoteCheck, order: number): boolean {
    const n = check.note
    if (!this.preset.autoDrone || !check.passed || !isBowedTone(check) || n.string !== 'female' || n.technique === 'double_stop') return false
    const c = this.analysis.notes[order]!
    const s0 = c.start
    const s1 = c.start + c.duration
    for (let i = 0; i < this.report.checks.length; i++) {
      const oc = this.analysis.notes[i]!
      if (oc.start >= s1 - EPS) break // notes are sorted by start
      if (i === order || oc.start + oc.duration <= s0 + EPS) continue
      // Anything on the male string (a col legno strike too) or a double stop occupies it.
      const o = this.report.checks[i]!.note
      if (o.string === 'male' || o.technique === 'double_stop') return false
    }
    return true
  }
}

/**
 * Shurankhai: the highest very long bowed note of the climax phrase, then of the phrases with the
 * next highest such notes, up to `count` (aizam 2, suman 1, besreg 0).
 */
function pickShurankhai(report: VerificationReport, analysis: SongAnalysis, count: number): Set<number> {
  const picked = new Set<number>()
  if (count <= 0) return picked
  const pitch = (i: number) => report.checks[i]!.note.pitch!
  const best = analysis.phrases.map((ph) => {
    let b: number | null = null
    for (let i = ph.first; i <= ph.last; i++) {
      const check = report.checks[i]!
      if (check.passed && isBowedTone(check) && analysis.notes[i]!.veryLong && (b === null || pitch(i) > pitch(b))) b = i
    }
    return b
  })
  const ranked = best
    .map((note, phrase) => ({ note, phrase }))
    .filter((x): x is { note: number; phrase: number } => x.note !== null)
    .sort((a, b) => Number(b.phrase === analysis.climax) - Number(a.phrase === analysis.climax) || pitch(b.note) - pitch(a.note) || a.phrase - b.phrase)
  for (const { note } of ranked.slice(0, count)) picked.add(note)
  return picked
}

/** Opening and closing strokes, relative to the first performed note (FrameEvent.start). */
function planFrames(style: PresetStyle, open: boolean, close: boolean, timing: Timing): { frames: FrameEvent[]; leadIn: number } {
  if (!timing.start.length) return { frames: [], leadIn: 0 }
  const first = Math.min(...timing.start)
  const last = Math.max(...timing.end)
  const frames: FrameEvent[] = []
  const o = FRAMES.omZee
  if (open) {
    if (style === 'urtiin-duu') {
      const p = FRAMES.prelude
      frames.push({ kind: 'prelude', start: -(p.gap + p.duration), duration: p.duration, bow: 'tatakh', velocity: p.velocity })
    } else {
      frames.push(
        { kind: 'om-zee', start: -(o.gap + 2 * o.stroke), duration: o.stroke, bow: 'tatakh', velocity: o.velocity },
        { kind: 'om-zee', start: -(o.gap + o.stroke), duration: o.stroke, bow: 'tülekhe', velocity: o.velocity }
      )
    }
  }
  if (close && style !== 'urtiin-duu') {
    const after = last - first + o.gap
    frames.push(
      { kind: 'om-zee', start: after, duration: o.stroke, bow: 'tatakh', velocity: o.velocity },
      { kind: 'om-zee', start: after + o.stroke, duration: o.stroke, bow: 'tülekhe', velocity: o.velocity }
    )
  }
  const earliest = Math.min(0, ...frames.map((f) => f.start))
  return { frames, leadIn: Math.max(0, -(first + earliest)) }
}
