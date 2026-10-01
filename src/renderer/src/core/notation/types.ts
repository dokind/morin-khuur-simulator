import type { Finger, StringId } from '../instrument'
import type { StyleId } from '../performance/types'
import type { BowDirection, TechniqueId } from '../techniques'
import type { TimeSignature } from './timing'

/**
 * Performance hints (optional, song and note level). They only steer the expressive player in
 * `core/performance`; parsing validates them, verification and the acoustic pitch test ignore
 * them, and the 'as-written' style ignores all of them except `tempoMap`, which is tempo notation.
 */
/** Ornament for one note. 'none' suppresses automatic ornaments; the others replace them with that one. */
export type OrnamentHint = 'none' | 'scoop' | 'grace' | 'hammer' | 'mordent' | 'trill' | 'fall'
export const ORNAMENT_HINTS: readonly OrnamentHint[] = ['none', 'scoop', 'grace', 'hammer', 'mordent', 'trill', 'fall']

/** Where a note's vibrato sits: from the onset ('start'), after a straight beginning ('end'), or ramped in over the note ('whole'). */
export type VibratoPlacement = 'start' | 'end' | 'whole'
export const VIBRATO_PLACEMENTS: readonly VibratoPlacement[] = ['start', 'end', 'whole']

const STYLE_TABLE: Record<StyleId, true> = {
  'as-written': true,
  'khalkh-stage': true,
  'urtiin-duu': true,
  tatlaga: true,
  'bii-ikel': true,
  'inner-mongolian': true
}
/** Every value accepted in a song's `style` field. */
export const STYLE_IDS = Object.keys(STYLE_TABLE) as StyleId[]

/** A tempo change in `tempoMap`, as written in the file. */
export interface RawTempoPoint {
  /** "bars:beats:sixteenths". */
  time: string
  /** Quarter notes per minute from `time` on. */
  bpm: number
  /** Change gradually (linearly per beat) from the previous point, reaching `bpm` at `time`, instead of jumping. */
  ramp?: boolean
}

/** A parsed tempo change; `beats` in quarter beats from the start of the song. */
export interface TempoPoint {
  beats: number
  bpm: number
  ramp: boolean
}

/** Framing strokes around the piece: switches the style's opening and closing on (true) or off (false). */
export interface FrameHint {
  /** Opening: om zee (both open strings, pull then push) or, for long songs, the khuur prelude. */
  open?: boolean
  /** Closing: om zee after the last note or, for long songs, the held final note. */
  close?: boolean
}

/**
 * On-disk `.mkhuur.json` shape (spec §5.2). Fields after `bow` are optional extensions:
 * they are ignored by readers that only know the spec's core format.
 */
export interface RawSongNote {
  time: string
  pitch?: string | null
  duration: string
  string?: StringId | null
  technique: string
  finger?: string | null
  bow?: string | null
  /** Continue the previous note in the same bow stroke (legato). */
  slur?: boolean
  /** 0–1, default 0.8. */
  velocity?: number
  /** Extra articulations layered on the note, e.g. ["vibrato"]. */
  articulations?: string[]
  /** Glissando target pitch on the same string. */
  glideTo?: string
  /** Double stop: pitch on the other string (defaults to that string open). */
  drone?: string
  /** Performance hint: this note's ornament in expressive styles. */
  ornament?: OrnamentHint
  /** Performance hint: where the vibrato sits; also asks for vibrato on a note that would not get it. */
  vibratoPlacement?: VibratoPlacement
}

export interface RawSong {
  title: string
  composer?: string
  /** e.g. "Urtiin Duu", "Bii biyelgee", "Tatlaga". */
  genre?: string
  tuning: { maleString: string; femaleString: string }
  tempoBpm: number
  timeSignature: string
  /** Tonic for numbered (jianpu) notation, e.g. "F" or "Bb". */
  key?: string
  description?: string
  /** Provenance of the transcription: who transcribed it and from which source. */
  source?: string
  /** Performance hint: playing style, overriding the one inferred from `genre`. */
  style?: StyleId
  /** Performance hint: density of automatic ornaments, 0–2 (default 1). */
  ornamentAmount?: number
  /** Tempo changes after the opening `tempoBpm` (e.g. a ritardando), in time order. */
  tempoMap?: RawTempoPoint[]
  /** Performance hint: framing strokes around the piece. */
  frame?: FrameHint
  notes: RawSongNote[]
}

/**
 * `wavy`: the "wavy / whipping" bow accents taught by UUGUUL — several accent pulses inside one
 * bow stroke, made by the ring and little fingers pressing the hair ("multiple stroking").
 */
export type Articulation = 'vibrato' | 'tremolo' | 'accent' | 'wavy' | 'sul_ponticello' | 'sul_tasto'
export const ARTICULATIONS: readonly Articulation[] = ['vibrato', 'tremolo', 'accent', 'wavy', 'sul_ponticello', 'sul_tasto']

export interface SongNote {
  /** Position in the source `notes` array. */
  index: number
  time: string
  startBeats: number
  durationBeats: number
  pitch: number | null
  string: StringId | null
  /** True when `string` was missing in the file and chosen automatically. */
  stringInferred: boolean
  technique: TechniqueId
  finger: Finger | null
  bow: BowDirection | null
  slur: boolean
  velocity: number
  articulations: Articulation[]
  glideTo: number | null
  drone: number | null
  /** Performance hints, present only when given in the file. */
  ornament?: OrnamentHint
  vibratoPlacement?: VibratoPlacement
}

export interface Song {
  title: string
  composer: string
  genre: string
  description: string
  source: string
  tuning: { male: number; female: number }
  tempoBpm: number
  timeSignature: TimeSignature
  /** Tonic pitch class for jianpu, or null to derive from the tuning. */
  keyPc: number | null
  /** Notes sorted by start time. */
  notes: SongNote[]
  lengthBeats: number
  /** Performance hints and tempo changes, present only when given (and valid) in the file. */
  style?: StyleId
  ornamentAmount?: number
  /** Sorted by `beats`; `tempoBpm` applies before the first point. */
  tempoMap?: TempoPoint[]
  frame?: FrameHint
}

export type Severity = 'error' | 'warning' | 'info'

export interface Issue {
  severity: Severity
  /** Index into the source `notes` array, or null for song-level issues. */
  noteIndex: number | null
  code: string
  message: string
}
