/**
 * Which style a song is played in: the song's own `style` field, else keywords in its genre, else
 * the Khalkh stage default (the conflict analysis in the research notes recommends it for composed
 * and unlabelled pieces).
 */

import type { Song } from '../notation'
import type { LongSongLevel, StyleId } from './types'

export const STYLES: readonly { id: StyleId; name: string; description: string }[] = [
  {
    id: 'as-written',
    name: 'As written',
    description:
      'Only what the file writes: its notes, articulations (notated vibrato, accents, tremolo…) and tempo changes. Nothing is added: no ornaments, no automatic vibrato on long notes, no rubato or framing strokes.'
  },
  {
    id: 'khalkh-stage',
    name: 'Khalkh stage',
    description: 'Composed and stage pieces: fixed rhythm, slides only into long phrase starts and wide leaps, lyrical vibrato on long notes.'
  },
  {
    id: 'urtiin-duu',
    name: 'Long song (urtiin duu)',
    description: 'Free rubato, wide vibrato, grace notes, trills and falls, a khuur prelude and a held final note.'
  },
  {
    id: 'tatlaga',
    name: 'Tatlaga',
    description: 'Gait and animal pieces: accented strokes, trot slides, finger hammers, an open drone under the female string, open-string framing strokes.'
  },
  { id: 'bii-ikel', name: 'Bii / ikel (Western)', description: 'Western Mongolian dance tunes: abrupt strokes, slides into long notes, falls at phrase ends.' },
  {
    id: 'inner-mongolian',
    name: 'Inner Mongolian',
    description: 'Matouqin practice: graces, hammers, mordents, after-trills, irregular vibrato on very long notes, an open-string opening.'
  }
]

/** Genre keywords, checked in order (plan §4.1). */
const GENRE_RULES: readonly [RegExp, StyleId][] = [
  [/urtiin|urtyn|long[ -]?song|уртын|урт дуу|айзам|суман|бэсрэг|\baizam\b|\bsuman\b|\bbesreg\b/i, 'urtiin-duu'],
  [/tatlaga|татлага|явдал|\byavdal\b/i, 'tatlaga'],
  [/\bbii\b|biyelgee|бий|биелгээ|\bikel\b|икэл/i, 'bii-ikel'],
  [/inner mongol|matouqin|马头琴|өвөр/i, 'inner-mongolian']
]

export function resolveStyle(song: Song): StyleId {
  if (song.style) return song.style
  for (const [re, style] of GENRE_RULES) if (re.test(song.genre)) return style
  return 'khalkh-stage'
}

/**
 * Long-song sub-genre from the genre text; an unqualified long song is played as aizam, the full
 * (and most ornamented) form [ENG].
 */
export function resolveLevel(song: Song): LongSongLevel {
  if (/бэсрэг|besreg/i.test(song.genre)) return 'besreg'
  if (/суман|suman/i.test(song.genre)) return 'suman'
  return 'aizam'
}

/** Borjgin long-song style: smaller, subtler ornaments and the bönjignökh vibrato [Yoon pp.148–149]. */
export function isBorjgin(song: Song): boolean {
  return /borjgin|borjigin|боржигин|боржгин/i.test(song.genre)
}
