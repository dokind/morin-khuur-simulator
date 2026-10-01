import { chooseString, FINGERS, type Finger, type StringId, type Tuning } from '../instrument'
import { parseNote, parsePitchClass } from '../pitch'
import { parseBow, resolveTechnique, TECHNIQUES } from '../techniques'
import { parseDuration, parsePosition, parseTimeSignature, type TimeSignature } from './timing'
import {
  ARTICULATIONS,
  ORNAMENT_HINTS,
  STYLE_IDS,
  VIBRATO_PLACEMENTS,
  type Articulation,
  type FrameHint,
  type Issue,
  type OrnamentHint,
  type Song,
  type SongNote,
  type TempoPoint,
  type VibratoPlacement
} from './types'

export interface ParseResult {
  /** Null only when song-level fields are unusable; malformed notes are skipped individually. */
  song: Song | null
  issues: Issue[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Structural parsing of `.mkhuur.json`. Musical/physical rules live in verify.ts. */
export function parseSong(input: unknown): ParseResult {
  const issues: Issue[] = []
  const songError = (code: string, message: string) => issues.push({ severity: 'error', noteIndex: null, code, message })

  if (!isObject(input)) {
    songError('not-an-object', 'Song file must be a JSON object.')
    return { song: null, issues }
  }

  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : null
  if (!title) songError('missing-title', 'Missing "title".')

  const tuningRaw = input.tuning
  let male: number | null = null
  let female: number | null = null
  if (isObject(tuningRaw)) {
    male = typeof tuningRaw.maleString === 'string' ? parseNote(tuningRaw.maleString) : null
    female = typeof tuningRaw.femaleString === 'string' ? parseNote(tuningRaw.femaleString) : null
  }
  if (male === null || female === null) {
    songError('bad-tuning', '"tuning" needs "maleString" and "femaleString" note names such as "F3" and "Bb3".')
  } else if (female <= male) {
    songError('bad-tuning', 'The female (Bilag) string must be tuned above the male (Arga) string.')
  }

  const tempoBpm = typeof input.tempoBpm === 'number' && input.tempoBpm >= 20 && input.tempoBpm <= 400 ? input.tempoBpm : null
  if (tempoBpm === null) songError('bad-tempo', '"tempoBpm" must be a number between 20 and 400.')

  const timeSignature = typeof input.timeSignature === 'string' ? parseTimeSignature(input.timeSignature) : null
  if (!timeSignature) songError('bad-time-signature', '"timeSignature" must look like "4/4" or "6/8".')

  let keyPc: number | null = null
  if (input.key !== undefined) {
    keyPc = typeof input.key === 'string' ? parsePitchClass(input.key) : null
    if (keyPc === null) issues.push({ severity: 'warning', noteIndex: null, code: 'bad-key', message: `Unrecognised "key"; ignoring it.` })
  }

  if (!Array.isArray(input.notes)) songError('missing-notes', '"notes" must be an array.')

  if (!title || male === null || female === null || female <= male || tempoBpm === null || !timeSignature || !Array.isArray(input.notes)) {
    return { song: null, issues }
  }

  const hints = parseSongHints(input, timeSignature, issues)

  const tuning: Tuning = { id: 'song', name: 'Song tuning', male, female, scaleTonic: male % 12 }
  const notes: SongNote[] = []

  input.notes.forEach((raw: unknown, index: number) => {
    const noteIssues: Issue[] = []
    const err = (code: string, message: string) => noteIssues.push({ severity: 'error', noteIndex: index, code, message })

    if (!isObject(raw)) {
      err('bad-note', 'Note must be an object.')
      issues.push(...noteIssues)
      return
    }

    const startBeats = typeof raw.time === 'string' ? parsePosition(raw.time, timeSignature) : null
    if (startBeats === null) err('bad-time', `"time" must be "bars:beats:sixteenths", got ${JSON.stringify(raw.time)}.`)

    const durationBeats = typeof raw.duration === 'string' ? parseDuration(raw.duration, timeSignature) : null
    if (durationBeats === null) err('bad-duration', `"duration" must look like "4n", "8n.", "8t" or "1m", got ${JSON.stringify(raw.duration)}.`)

    const technique = typeof raw.technique === 'string' ? resolveTechnique(raw.technique) : null
    if (!technique) err('bad-technique', `Unknown technique ${JSON.stringify(raw.technique)}.`)

    let pitch: number | null = null
    if (raw.pitch !== undefined && raw.pitch !== null) {
      pitch = typeof raw.pitch === 'string' ? parseNote(raw.pitch) : null
      if (pitch === null) err('bad-pitch', `Unrecognised pitch ${JSON.stringify(raw.pitch)}.`)
    } else if (technique && TECHNIQUES[technique].needsPitch) {
      err('missing-pitch', `Technique "${technique}" needs a pitch.`)
    }

    let string: StringId | null = null
    let stringInferred = false
    if (raw.string === 'male' || raw.string === 'female') string = raw.string
    else if (raw.string !== undefined && raw.string !== null) err('bad-string', `"string" must be "male" or "female".`)
    else if (pitch !== null) {
      string = chooseString(pitch, tuning)?.string ?? null
      stringInferred = string !== null
    }

    let finger: Finger | null = null
    if (raw.finger !== undefined && raw.finger !== null) {
      if (typeof raw.finger === 'string' && (FINGERS as readonly string[]).includes(raw.finger)) finger = raw.finger as Finger
      else err('bad-finger', `"finger" must be one of ${FINGERS.join(', ')} or null.`)
    }

    const bow = parseBow(raw.bow ?? null)
    if (bow === undefined) err('bad-bow', `"bow" must be "tatakh", "tülekhe" or null.`)

    const articulations: Articulation[] = []
    if (raw.articulations !== undefined) {
      if (!Array.isArray(raw.articulations)) err('bad-articulations', '"articulations" must be an array.')
      else
        for (const a of raw.articulations) {
          if ((ARTICULATIONS as readonly unknown[]).includes(a)) articulations.push(a as Articulation)
          else noteIssues.push({ severity: 'warning', noteIndex: index, code: 'unknown-articulation', message: `Ignoring unknown articulation ${JSON.stringify(a)}.` })
        }
    }

    const optionalPitch = (key: 'glideTo' | 'drone'): number | null => {
      const v = raw[key]
      if (v === undefined || v === null) return null
      const midi = typeof v === 'string' ? parseNote(v) : null
      if (midi === null) err(`bad-${key}`, `Unrecognised "${key}" pitch ${JSON.stringify(v)}.`)
      return midi
    }
    const glideTo = optionalPitch('glideTo')
    const drone = optionalPitch('drone')

    const velocity = typeof raw.velocity === 'number' ? Math.min(1, Math.max(0, raw.velocity)) : 0.8

    const hint = <T extends string>(key: 'ornament' | 'vibratoPlacement', allowed: readonly T[]): T | undefined => {
      const v = raw[key]
      if (v === undefined) return undefined
      if ((allowed as readonly unknown[]).includes(v)) return v as T
      noteIssues.push({ severity: 'warning', noteIndex: index, code: `bad-${key}`, message: `Ignoring "${key}" ${JSON.stringify(v)}; expected ${allowed.join(', ')}.` })
      return undefined
    }
    const ornament = hint<OrnamentHint>('ornament', ORNAMENT_HINTS)
    const vibratoPlacement = hint<VibratoPlacement>('vibratoPlacement', VIBRATO_PLACEMENTS)

    issues.push(...noteIssues)
    if (noteIssues.some((i) => i.severity === 'error')) return

    notes.push({
      index,
      time: raw.time as string,
      startBeats: startBeats!,
      durationBeats: durationBeats!,
      pitch,
      string,
      stringInferred,
      technique: technique!,
      finger,
      bow: bow ?? null,
      slur: raw.slur === true,
      velocity,
      articulations,
      glideTo,
      drone,
      ...(ornament !== undefined ? { ornament } : {}),
      ...(vibratoPlacement !== undefined ? { vibratoPlacement } : {})
    })
  })

  notes.sort((a, b) => a.startBeats - b.startBeats || a.index - b.index)
  const lengthBeats = notes.reduce((end, n) => Math.max(end, n.startBeats + n.durationBeats), 0)

  return {
    song: {
      title,
      composer: typeof input.composer === 'string' ? input.composer : '',
      genre: typeof input.genre === 'string' ? input.genre : '',
      description: typeof input.description === 'string' ? input.description : '',
      source: typeof input.source === 'string' ? input.source : '',
      tuning: { male, female },
      tempoBpm,
      timeSignature,
      keyPc,
      notes,
      lengthBeats,
      ...hints
    },
    issues
  }
}

/**
 * Song-level performance hints and the tempo map. Bad values are warnings and are dropped: they
 * only affect expressive playback, never whether the song can be played.
 */
function parseSongHints(input: Record<string, unknown>, ts: TimeSignature, issues: Issue[]): Pick<Song, 'style' | 'ornamentAmount' | 'tempoMap' | 'frame'> {
  const warn = (code: string, message: string) => issues.push({ severity: 'warning', noteIndex: null, code, message })
  const hints: Pick<Song, 'style' | 'ornamentAmount' | 'tempoMap' | 'frame'> = {}

  if (input.style !== undefined) {
    if ((STYLE_IDS as readonly unknown[]).includes(input.style)) hints.style = input.style as Song['style']
    else warn('bad-style', `Ignoring "style" ${JSON.stringify(input.style)}; expected ${STYLE_IDS.join(', ')}.`)
  }

  if (input.ornamentAmount !== undefined) {
    const a = input.ornamentAmount
    if (typeof a === 'number' && a >= 0 && a <= 2) hints.ornamentAmount = a
    else warn('bad-ornament-amount', '"ornamentAmount" must be a number from 0 to 2; ignoring it.')
  }

  if (input.tempoMap !== undefined) {
    if (!Array.isArray(input.tempoMap)) warn('bad-tempo-map', '"tempoMap" must be an array; ignoring it.')
    else {
      const points: TempoPoint[] = []
      input.tempoMap.forEach((p: unknown, i: number) => {
        const beats = isObject(p) && typeof p.time === 'string' ? parsePosition(p.time, ts) : null
        const bpm = isObject(p) && typeof p.bpm === 'number' && p.bpm >= 20 && p.bpm <= 400 ? p.bpm : null
        const ramp = isObject(p) ? p.ramp : undefined
        if (beats === null || bpm === null || (ramp !== undefined && typeof ramp !== 'boolean')) {
          warn('bad-tempo-point', `Ignoring tempoMap entry #${i + 1}: it needs "time" ("bars:beats:sixteenths"), "bpm" (20–400) and an optional boolean "ramp".`)
        } else points.push({ beats, bpm, ramp: ramp === true })
      })
      // Stable sort: of two points at the same time, the later one in the file wins.
      points.sort((a, b) => a.beats - b.beats)
      if (points.length) hints.tempoMap = points
    }
  }

  if (input.frame !== undefined) {
    const f = input.frame
    if (isObject(f) && (f.open === undefined || typeof f.open === 'boolean') && (f.close === undefined || typeof f.close === 'boolean')) {
      const frame: FrameHint = {}
      if (f.open !== undefined) frame.open = f.open as boolean
      if (f.close !== undefined) frame.close = f.close as boolean
      hints.frame = frame
    } else warn('bad-frame', '"frame" must be an object with optional boolean "open" and "close"; ignoring it.')
  }

  return hints
}
