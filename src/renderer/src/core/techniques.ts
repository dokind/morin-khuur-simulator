/**
 * Catalogue of Morin Khuur playing techniques (spec §3). The ids are the values allowed in the
 * `technique` field of `.mkhuur.json` songs.
 */

export type TechniqueId =
  | 'open'
  | 'cuticle_side_stop'
  | 'fingernail_side_stop'
  | 'tsatsal_harmonic'
  | 'artificial_harmonic'
  | 'pizzicato'
  | 'col_legno'
  | 'body_tap'
  | 'string_slap'
  | 'horse_whinny'
  | 'gallop'
  | 'vibrato'
  | 'tremolo'
  | 'gulsuulakh_glissando'
  | 'shuvtrakh_glissando'
  | 'shigshikh_glissando'
  | 'tsokhilgo'
  | 'erkhii_darakh'
  | 'double_stop'
  | 'sul_ponticello'
  | 'sul_tasto'

/**
 * How a technique produces sound:
 * - `stopped`: bowed note at a side-stopped (or open) pitch; articulations like vibrato live here
 * - `harmonic`: bowed with a light touch at a node
 * - `plucked`: pitched without the bow (pizzicato, tsokhilgo finger strikes)
 * - `percussive`: struck; pitch optional (body tap has none)
 * - `gesture`: a scripted multi-note gesture (horse whinny)
 */
export type TechniqueKind = 'stopped' | 'harmonic' | 'plucked' | 'percussive' | 'gesture'

export interface TechniqueInfo {
  id: TechniqueId
  name: string
  /** Transliterated Mongolian name from the spec; empty where the spec gives none. */
  mongolian: string
  kind: TechniqueKind
  /** A pitch is mandatory in notation. */
  needsPitch: boolean
  /** A bow direction (tatakh / tülekhe) is mandatory in notation. */
  needsBow: boolean
  description: string
}

const T = (
  id: TechniqueId,
  name: string,
  mongolian: string,
  kind: TechniqueKind,
  needsPitch: boolean,
  needsBow: boolean,
  description: string
): TechniqueInfo => ({ id, name, mongolian, kind, needsPitch, needsBow, description })

export const TECHNIQUES: Record<TechniqueId, TechniqueInfo> = {
  open: T('open', 'Open string', '', 'stopped', true, true, 'Bowing the unstopped string.'),
  cuticle_side_stop: T(
    'cuticle_side_stop',
    'Cuticle side-stop',
    '',
    'stopped',
    true,
    true,
    'Stopping the hovering string from the side with the cuticle groove.'
  ),
  fingernail_side_stop: T(
    'fingernail_side_stop',
    'Fingernail side-stop',
    '',
    'stopped',
    true,
    true,
    'Stopping the hovering string from the side with the fingernail.'
  ),
  tsatsal_harmonic: T(
    'tsatsal_harmonic',
    'Natural harmonic',
    'Tsatsal',
    'harmonic',
    true,
    true,
    'Lightly touching a node (1/2, 1/3, 1/4, 1/5) for a bell-like overtone.'
  ),
  artificial_harmonic: T(
    'artificial_harmonic',
    'Artificial harmonic',
    'Khuuramch tsatsal',
    'harmonic',
    true,
    true,
    'Stopping a note with the cuticle and brushing a higher node with another finger.'
  ),
  pizzicato: T('pizzicato', 'Pizzicato', 'Huruugaar tatakh', 'plucked', true, false, 'Plucking the string with a finger.'),
  col_legno: T(
    'col_legno',
    'Col legno',
    'Numny modoor tsoxikh',
    'percussive',
    false,
    false,
    'Striking the string with the wooden bow stick for a dry click.'
  ),
  body_tap: T(
    'body_tap',
    'Body tap',
    'Hairtsag tsoxikh',
    'percussive',
    false,
    false,
    'Knocking the soundbox with the knuckles — galloping hooves (doroo).'
  ),
  string_slap: T('string_slap', 'String slap', 'Utas tsoxikh', 'percussive', false, false, 'Slapping or snapping the string.'),
  horse_whinny: T(
    'horse_whinny',
    'Horse whinny',
    'Moriin insee',
    'gesture',
    true,
    true,
    'Rapid slide to the high register with flutter tremolo, imitating a neighing horse.'
  ),
  gallop: T('gallop', 'Galloping bow', 'Morin joroo', 'stopped', true, true, 'Rhythmic bowing that mimics horse gaits.'),
  vibrato: T('vibrato', 'Vibrato', 'Chichiree', 'stopped', true, true, 'Rocking the fingernail on the contact point.'),
  tremolo: T('tremolo', 'Tremolo', 'Dalallaga', 'stopped', true, true, 'Very fast push/pull alternation at the bow tip.'),
  gulsuulakh_glissando: T(
    'gulsuulakh_glissando',
    'Smooth glissando',
    'Gulsuulakh',
    'stopped',
    true,
    true,
    'Seamless, lyrical legato slide between pitches along the vibrating string — the long-song glide.'
  ),
  shuvtrakh_glissando: T(
    'shuvtrakh_glissando',
    'Whipped glissando',
    'Shuvtrakh',
    'stopped',
    true,
    true,
    'Fast, sharp stripping slide across positions for dramatic effect.'
  ),
  shigshikh_glissando: T(
    'shigshikh_glissando',
    'Trembling glissando',
    'Shigshikh',
    'stopped',
    true,
    true,
    'A shaking slide that combines vibrato micro-shakes with the change of position.'
  ),
  tsokhilgo: T('tsokhilgo', 'Finger strike', 'Tsokhilgo', 'plucked', true, false, 'Snapping a left-hand finger sharply onto the string.'),
  erkhii_darakh: T(
    'erkhii_darakh',
    'Thumb playing',
    'Erkhii darakh',
    'stopped',
    true,
    true,
    'The thumb stops a string from its side or from underneath — most often the thin female string (C on the B♭ string); some schools hook it under the male string for extended, high notes.'
  ),
  double_stop: T(
    'double_stop',
    'Double-stop drone',
    'Khos utas zereg',
    'stopped',
    true,
    true,
    'Bowing both strings: the male string drones under the female melody.'
  ),
  sul_ponticello: T(
    'sul_ponticello',
    'Sul ponticello',
    'Teewiin oir tatakh',
    'stopped',
    true,
    true,
    'Bowing against the bridge for a raspy, overtone-rich tone.'
  ),
  sul_tasto: T('sul_tasto', 'Sul tasto', 'Khüzüüni oir tatakh', 'stopped', true, true, 'Bowing near the neck for a soft, airy tone.')
}

export const TECHNIQUE_IDS = Object.keys(TECHNIQUES) as TechniqueId[]

export function isTechniqueId(value: string): value is TechniqueId {
  return value in TECHNIQUES
}

/** Older ids still accepted in song files. */
const TECHNIQUE_ALIASES: Record<string, TechniqueId> = { glissando: 'gulsuulakh_glissando' }

/** Resolves a technique id from a song file, including legacy aliases. */
export function resolveTechnique(value: string): TechniqueId | null {
  if (isTechniqueId(value)) return value
  return TECHNIQUE_ALIASES[value] ?? null
}

export function isGlissando(id: TechniqueId): boolean {
  return id === 'gulsuulakh_glissando' || id === 'shuvtrakh_glissando' || id === 'shigshikh_glissando'
}

/** Bow strokes. Tatakh = pull, Tülekhe = push (spec §3, rows 8–9). */
export type BowDirection = 'tatakh' | 'tülekhe'

export const BOW_INFO: Record<BowDirection, { name: string; english: string }> = {
  tatakh: { name: 'Tatakh', english: 'Pull' },
  tülekhe: { name: 'Tülekhe', english: 'Push' }
}

/** Accepts the ASCII spelling "tulekhe" as an alias. */
export function parseBow(value: unknown): BowDirection | null | undefined {
  if (value === null) return null
  if (value === 'tatakh') return 'tatakh'
  if (value === 'tülekhe' || value === 'tulekhe') return 'tülekhe'
  return undefined
}

export function oppositeBow(bow: BowDirection): BowDirection {
  return bow === 'tatakh' ? 'tülekhe' : 'tatakh'
}

/**
 * On-screen direction of each stroke on bow pads, visualisers and arrow keys, from the player's
 * point of view. Tatakh (pull) is the right hand moving away from the instrument — to the right —
 * as in the spec's technique table (Right Arrow) and the Mongolian/Chinese teaching sources; the
 * generated playground mockup labels it the other way round. Flip this one constant to change it.
 */
export const SCREEN_DIRECTION: Record<BowDirection, -1 | 1> = { tatakh: 1, tülekhe: -1 }
