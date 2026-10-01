/**
 * Style presets for the performance planner (the research plan's §4.3–4.4). A preset only adds
 * what a player adds to the notation; the song's tuning, techniques, articulations and bowings
 * always win. Numbers without a source are engineering defaults [ENG] to be tuned by listening.
 *
 * Sources (short keys as in the research notes):
 * - Ornaments are unwritten and added by the player (ZH#25); composed stage pieces use fixed rhythm
 *   and little ornament (EN R27) — hence 'khalkh-stage' has no free ornaments.
 * - Neighbours are pentatonic seconds and minor thirds, never semitones [D'Evelyn p.21; Van Oost
 *   1915; Lin p.23]; ornament notes stay within one hand frame [SaQie; zhwiki].
 * - Long song: sub-genres aizam > suman > besreg by ornament density (mn.wiki Уртын дуу; Yoon),
 *   shurankhai counts 2 / 1 / 0 (Yoon; mn.wiki); tsokhilt vibrato wide and rough, bönjignökh small
 *   and tremolo-like (Yoon, EN R5; Borjgin style smaller [Yoon pp.148–149]); vibrato placement
 *   varies per note (Yoon pp.207–208, EN R33); a rising melody is slow and steady (UNESCO urtiin
 *   duu); ornaments grow on repeats [D'Evelyn pp.21–22]; breath gaps (Yoon pp.131–134); every long
 *   song begins with the sound of the khuur [Pegasus].
 * - Tatlaga: accents on pulls and pushes [D'Evelyn pp.9–10, 107]; percussive left-hand ornaments
 *   [D'Evelyn pp.9–10; Hutchins p.61]; trot slides [Hutchins p.61]; double-stop ostinato drone
 *   [D'Evelyn p.20; Bulanov]; om zee opening and, in the Boldoo lineage, closing [D'Evelyn p.20;
 *   Hutchins pp.72, 84]; the repeated fast section doubles its ornaments [Hutchins p.72].
 * - Bii / ikel: abrupt (огцом) strokes, no bounced bow; гулсаа slide-ins and шувтраа falls
 *   (Khumbaa, Erdenechimeg 1994 in [Magsarjav]); no чичиргээ vibrato; the piece loops until the
 *   dancer stops [Magsarjav].
 * - Inner Mongolian: graces, hammers (打音), mordents (波音) and the after-trill (后颤音) with a
 *   third [SaQie; Gehanxi; Tan; zhwiki; Pan-477]; irregular vibrato in long notes (孟宪红, Gehanxi);
 *   downward glides at phrase ends [Lin]; om zee opening [D'Evelyn p.20].
 * - Vibrato rates: lyrical 5–6 Hz, in phase with loudness; trill 6–7 Hz, 3.5–4.5 semitones, upper
 *   note 6–10 dB weaker [PL, vocal]. A shift slide on one string [Dymbrylov]; the bow drifts towards
 *   the bridge within a phrase [Bulanov].
 *
 * Never generated automatically, in any preset (the planner never changes a note's technique):
 * pizzicato, col legno and martellato ("generally not used" [enwiki-MK]; modern in [Dymbrylov]),
 * and bounced spiccato (borrowed from the violin, D'Evelyn p.105).
 */

import type { LongSongLevel, StyleId, VibratoPlan, VibratoShape } from './types'

export type PresetStyle = Exclude<StyleId, 'as-written'>

export interface StylePreset {
  /** Base ornament density ρ; per sub-genre for long songs. */
  density: number | Readonly<Record<LongSongLevel, number>>
  /** Density multiplier by repetition index k: first hearing, first repeat, later repeats. */
  growth: readonly [number, number, number]
  /**
   * Scoop rule (rule-based, on whenever the ornament amount is above 0, except 'chance'):
   * - 'stage': phrase-start notes of at least `stageScoopMin` s, or long notes after upward leaps of 5+
   * - 'long-song': long notes at phrase starts or after upward leaps of 3+
   * - 'chance': long notes with probability `scoop` × ρ
   * Never on gallop strokes.
   */
  scoopRule: 'stage' | 'long-song' | 'chance'
  scoopSeconds: number
  /** Probabilities, multiplied by ρ (0 = never). */
  scoop: number
  grace: number
  hammer: number
  mordent: number
  trill: number
  fall: number
  trotSlide: number
  /** Where graces go: stressed long notes (long song) or accented notes (Inner Mongolian). */
  graceOn: 'stressed-long' | 'accented'
  /** Where hammers go: accented hoofbeats (tatlaga) or quarter notes and longer on strong beats. */
  hammerOn: 'hoofbeat' | 'strong-quarter'
  /** Where trills go: the peak of a phrase, at most one per phrase (long song), or any long note. */
  trillOn: 'phrase-peak' | 'long'
  /** Audible slide from the previous pitch on the same string when the hand shifts 5+ stops. */
  shiftSlides: boolean
  vibrato: {
    shape: VibratoShape
    /** Automatic vibrato: stopped notes over AUTO_VIBRATO_MIN (0.6 s), long notes, very long notes, or none (notated only). */
    auto: 'over-0.9' | 'long' | 'very-long' | null
    placement: VibratoPlan['placement']
  }
  shurankhai: boolean
  /** Automatic open drone on the male string under female-string melody. */
  autoDrone: boolean
  frames: { open: boolean; close: boolean }
  /** 'accent-release-fast': accent-release on fast notes, swell otherwise. */
  bow: 'swell' | 'accent-release' | 'abrupt' | 'accent-release-fast'
  /** Bow drifts towards the bridge over the end of the climax phrase. */
  positionRamp: boolean
  timing: {
    /** Onset jitter, standard deviation in seconds. */
    jitter: number
    /** Rubato: ascending notes and phrase-final long notes are lengthened. */
    rubato: boolean
    /** Extra silence before each phrase start after the first, s. */
    breathGap: number
  }
  /** The dance tune repeats until stopped. */
  loop: boolean
}

export const PRESETS: Readonly<Record<PresetStyle, StylePreset>> = {
  'khalkh-stage': {
    density: 0,
    growth: [1, 1, 1],
    scoopRule: 'stage',
    scoopSeconds: 0.09,
    scoop: 0,
    grace: 0,
    hammer: 0,
    mordent: 0,
    trill: 0,
    fall: 0,
    trotSlide: 0,
    graceOn: 'stressed-long',
    hammerOn: 'strong-quarter',
    trillOn: 'long',
    shiftSlides: true,
    vibrato: { shape: 'lyrical', auto: 'over-0.9', placement: 'whole' },
    shurankhai: false,
    autoDrone: false,
    frames: { open: false, close: false },
    bow: 'swell',
    positionRamp: true,
    timing: { jitter: 0, rubato: false, breathGap: 0 },
    loop: false
  },
  'urtiin-duu': {
    density: { aizam: 1, suman: 0.7, besreg: 0.4 },
    growth: [0.6, 1, 1.3],
    scoopRule: 'long-song',
    scoopSeconds: 0.13,
    scoop: 0,
    grace: 0.15,
    hammer: 0,
    mordent: 0,
    trill: 0.3,
    fall: 0.5,
    trotSlide: 0,
    graceOn: 'stressed-long',
    hammerOn: 'strong-quarter',
    trillOn: 'phrase-peak',
    shiftSlides: true,
    vibrato: { shape: 'tsokhilt', auto: 'long', placement: 'end' },
    shurankhai: true,
    autoDrone: false,
    frames: { open: true, close: true },
    bow: 'swell',
    positionRamp: true,
    timing: { jitter: 0.015, rubato: true, breathGap: 0.1 },
    loop: false
  },
  tatlaga: {
    density: 0.6,
    growth: [1, 2, 2],
    scoopRule: 'stage',
    scoopSeconds: 0.09,
    scoop: 0,
    grace: 0,
    hammer: 0.25,
    mordent: 0,
    trill: 0,
    fall: 0,
    trotSlide: 0.5,
    graceOn: 'accented',
    hammerOn: 'hoofbeat',
    trillOn: 'long',
    shiftSlides: false,
    vibrato: { shape: 'lyrical', auto: null, placement: 'whole' },
    shurankhai: false,
    autoDrone: true,
    frames: { open: true, close: true },
    bow: 'accent-release',
    positionRamp: false,
    timing: { jitter: 0.01, rubato: false, breathGap: 0 },
    loop: false
  },
  'bii-ikel': {
    // Khumbaa's гулсаа (probability 0.5) and шувтраа (0.4) at the base density 0.5.
    density: 0.5,
    growth: [1, 1, 1],
    scoopRule: 'chance',
    scoopSeconds: 0.1,
    scoop: 1,
    grace: 0,
    hammer: 0,
    mordent: 0,
    trill: 0,
    fall: 0.8,
    trotSlide: 0,
    graceOn: 'accented',
    hammerOn: 'strong-quarter',
    trillOn: 'long',
    shiftSlides: false,
    vibrato: { shape: 'lyrical', auto: null, placement: 'whole' },
    shurankhai: false,
    autoDrone: false,
    frames: { open: false, close: false },
    bow: 'abrupt',
    positionRamp: false,
    timing: { jitter: 0.008, rubato: false, breathGap: 0 },
    loop: true
  },
  'inner-mongolian': {
    density: 1,
    growth: [0.6, 1, 1.3],
    scoopRule: 'long-song',
    scoopSeconds: 0.13,
    scoop: 0,
    grace: 0.25,
    hammer: 0.2,
    mordent: 0.1,
    trill: 0.35,
    fall: 0.4,
    trotSlide: 0,
    graceOn: 'accented',
    hammerOn: 'strong-quarter',
    trillOn: 'long',
    shiftSlides: true,
    vibrato: { shape: 'nogula', auto: 'very-long', placement: 'whole' },
    shurankhai: false,
    autoDrone: false,
    frames: { open: true, close: false },
    bow: 'accent-release-fast',
    positionRamp: false,
    timing: { jitter: 0.008, rubato: false, breathGap: 0 },
    loop: false
  }
}

/** Ornament density ρ = base × amount × growth(k). */
export function density(style: PresetStyle, level: LongSongLevel, amount: number, repeat: number): number {
  const p = PRESETS[style]
  const base = typeof p.density === 'number' ? p.density : p.density[level]
  return base * amount * p.growth[Math.min(Math.max(repeat, 0), 2)]!
}

/** Shurankhai per long song: on the highest very long notes of the climax phrases. */
export const SHURANKHAI_COUNT: Readonly<Record<LongSongLevel, number>> = { aizam: 2, suman: 1, besreg: 0 }

/** Gesture timings, seconds [ENG]. */
export const ORNAMENT_TIMING = {
  /** Grace: hold the neighbour this long (uniform range), then move to the main note in `graceMove`. */
  graceHold: [0.05, 0.07],
  graceMove: 0.008,
  hammer: [0.04, 0.06],
  /** Mordent: neighbour after this long on the main note, back after as long again. */
  mordentStep: 0.04,
  trillRateHz: 6.5,
  /** Stepped trill: transition time between upper and main note. */
  trillStep: 0.013,
  trillUpperGainDb: -6,
  /** After-trill (后颤音) starts at this fraction of the note. */
  trillFrom: 0.6,
  /** The trill itself must last at least this long. */
  trillMin: 0.3,
  fall: [0.08, 0.15],
  shiftSlide: 0.05,
  trotSlide: [0.03, 0.04],
  /** A start or end gesture takes at most this fraction of the note. */
  maxShare: 0.4
} as const

/** Base vibrato per shape: depth (± cents) for notated and automatic vibrato, rate, loudness modulation, roughness. */
export const VIBRATO_SHAPES: Readonly<Record<VibratoShape, { notated: number; auto: number; rateHz: number; amDb: number; roughness: number }>> = {
  // Measured on a Mongolian State Conservatory recording (references/measurements.md): 5.0 Hz,
  // median ±13.5 cents (±7–17) on sustained notes; scaled by the note's length (see vibratoPlan).
  // Notated vibrato is a little wider than the automatic kind.
  // No added loudness modulation: on the reference the level moves slightly against the pitch
  // (r ≈ −0.3), which the soundbox resonances produce by themselves; an in-phase swell read +0.8.
  lyrical: { notated: 20, auto: 13, rateHz: 5, amDb: 0, roughness: 0 },
  tsokhilt: { notated: 50, auto: 40, rateHz: 5.2, amDb: 2, roughness: 0.08 },
  bonjignokh: { notated: 15, auto: 12, rateHz: 6.5, amDb: 1.5, roughness: 0 },
  // Aperiodic: `cents` is the largest segment depth; segments draw rate 4.5–7 Hz (see vibratoSegments).
  nogula: { notated: 50, auto: 50, rateHz: 5.75, amDb: 1, roughness: 0 }
}

/** Lyrical rate varies by up to this much per note, Hz. */
export const LYRICAL_RATE_JITTER = 0.25

/** Frames: om zee (two open double-stop strokes, "inhale, exhale") and the long-song prelude. */
export const FRAMES = {
  omZee: { stroke: 2.5, velocity: 0.55, gap: 0.3 },
  prelude: { duration: 2.5, velocity: 0.5, gap: 0.4 },
  /** Long song: the final note is held this much longer, settling together. */
  finalHold: 1
} as const

export const DRONE_LEVEL = 0.55

/** Bow-point drift over the last 40% of the climax phrase, towards the bridge. */
export const POSITION_RAMP = { share: 0.4, to: 0.4 } as const

/** Rubato factors for long songs. */
export const RUBATO = { ascending: 1.08, phraseFinal: 1.15 } as const

/** Notes shorter than this (s) count as a fast passage (accent-release in Inner Mongolian style, trot slides). */
export const FAST_NOTE = 0.3
