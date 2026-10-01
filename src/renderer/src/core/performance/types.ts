/**
 * Performance plans: the unwritten part of morin khuur playing. A plan says, per note, what a
 * player adds to the notation in a given style — ornaments, vibrato, bow shape, small timing
 * changes — plus framing strokes before and after the piece. Plans are pure data, computed from a
 * verified song (`planPerformance` in ./plan.ts) and rendered by the audio layer; verification and
 * the acoustic pitch test always use the notes as written ('as-written' produces an empty plan).
 *
 * The rules and their sources are summarised in ./presets.ts. Numbers without a source are
 * engineering defaults, marked [ENG] there.
 */

/** Playing style. 'as-written' adds nothing; the others are presets from the research. */
export type StyleId = 'as-written' | 'khalkh-stage' | 'urtiin-duu' | 'tatlaga' | 'bii-ikel' | 'inner-mongolian'

/** Long-song sub-genre, from the most to the least ornamented. */
export type LongSongLevel = 'aizam' | 'suman' | 'besreg'

export type PitchOrnamentKind =
  /** Slide into the note from below. */
  | 'scoop'
  /** Grace note (前/后倚音): a short neighbour before (at 'start') or after (at 'end') the note. */
  | 'grace'
  /** Hammered upper note (打音): a quick finger strike above the note at its onset. */
  | 'hammer'
  /** Mordent (波音): main, neighbour, main at the onset. */
  | 'mordent'
  /** Trill (颤音, the "Mongolian trill") with an upper neighbour, over the tail or the whole note. */
  | 'trill'
  /** Slide off the note at its release, downwards (шувтраа). */
  | 'fall'
  /** Audible shift slide from the previous pitch on the same string. */
  | 'shift-slide'
  /** Short slide into a stopped note in trotting/gallop passages. */
  | 'trot-slide'

export interface PitchOrnament {
  kind: PitchOrnamentKind
  /** Signed offset of the ornament pitch from the main note, semitones (e.g. -2 = from a tone below). */
  semitones: number
  /** Length of the ornament gesture, seconds (for a trill: the length of each upper/lower cycle is 1/rateHz). */
  seconds: number
  /** Where in the note the gesture sits. */
  at: 'start' | 'end' | 'whole'
  /** Trill alternations per second. */
  rateHz?: number
  /** Trill: level of the upper note relative to the main note, dB (anti-phase amplitude, e.g. -6). */
  upperGainDb?: number
  /** Trill 'end': fraction of the note after which the trill starts (e.g. 0.6). */
  from?: number
}

export type VibratoShape =
  /** Sine, even: lyrical Khalkh vibrato. */
  | 'lyrical'
  /** Wide, rough, "pounding" central-Khalkh long-song vibrato. */
  | 'tsokhilt'
  /** Small, fast, tremolo-like (Borjgin). */
  | 'bonjignokh'
  /** Irregular, aperiodic fluctuation (Inner Mongolian long song). */
  | 'nogula'

export interface VibratoPlan {
  /** Depth, ± cents. */
  cents: number
  rateHz: number
  /** 'end': straight first, then vibrato; 'start': from the onset, fading; 'whole': ramped in. */
  placement: 'start' | 'end' | 'whole'
  shape: VibratoShape
  /** In-phase amplitude modulation depth, ± dB (applied after the string, never to bow speed). */
  amDb: number
  /** Extra horsehair roughness while the vibrato is on (0 = none). */
  roughnessBoost: number
  /** Seed for aperiodic shapes, so renders are reproducible. */
  seed: number
}

export type BowProfile =
  /** Even bow with a gradual rise and ease-off (the current default stroke). */
  | 'swell'
  /** Accent at the stroke start (force spike), then the bow speed relaxes: tatlaga, fast passages. */
  | 'accent-release'
  /** Abrupt (огцом) short stroke: quick rise (never under 10 ms), sounds ~0.8 of the note, fast release. */
  | 'abrupt'

export interface NotePerformance {
  /** Index into `report.checks` (the song's notes in sorted order). */
  order: number
  /**
   * Seconds added to the note's start (rubato, jitter, breath). May be negative, never before the previous note's start.
   * Written times come from `songClock` (tempoBpm and the song's tempoMap); `performedTiming` does the sums.
   */
  timeOffset: number
  /** Multiplier on the written duration (e.g. 1.15 for a held phrase-final note). */
  durationScale: number
  /** Ornaments, in time order; empty for none. */
  ornaments: PitchOrnament[]
  /** Vibrato to apply, or null for none (notated vibrato always gets one in any style but 'as-written'). */
  vibrato: VibratoPlan | null
  bow: BowProfile
  /** Bow point drift over the note (0 = normal, + towards the bridge), or null. */
  positionRamp: { from: number; to: number } | null
  /** Long-song shurankhai: lighter, "falsetto" colour on this note. */
  shurankhai: boolean
  /** Automatic drone on the other (open) string at this velocity multiplier, or null. */
  drone: { level: number } | null
}

/** A framing stroke that is not a score note: om zee opening/closing or a long-song prelude. */
export interface FrameEvent {
  kind: 'om-zee' | 'prelude' | 'coda'
  /** Seconds relative to the first score note (negative = before it). */
  start: number
  duration: number
  bow: 'tatakh' | 'tülekhe'
  /** 0–1 */
  velocity: number
}

export interface PerformancePlan {
  style: StyleId
  /** One entry per `report.checks` item, same order. */
  notes: NotePerformance[]
  /** Strokes before the first note and after the last one. */
  frames: FrameEvent[]
  /** Seconds the whole song is delayed to make room for opening frames (≥ 0). */
  leadIn: number
  /** Long-song sub-genre the plan was made for ('urtiin-duu' only). */
  level?: LongSongLevel
  /** The style plays the tune on repeat until stopped (bii dance tunes end when the dancer stops). */
  loop?: boolean
}

export interface PlanOptions {
  /** Style to use; defaults to `resolveStyle(song)`. */
  style?: StyleId
  /** Ornament density multiplier, 0–2 (default 1); multiplies the song's own `ornamentAmount`. */
  amount?: number
  /** Long-song sub-genre; defaults to the one named in the genre (aizam when none is). */
  level?: LongSongLevel
}
