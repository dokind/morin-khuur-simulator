/**
 * Physical & phrasing verification of a parsed song (spec §5.3). Every note is checked against
 * what a real player can do on two hovering strings:
 *  - the pitch must be reachable on the chosen string (range, open-string, harmonic nodes)
 *  - one string sounds one pitch at a time
 *  - side-stop fingering must be plausible in first position and fingers must not cross
 *  - bowed notes alternate tatakh / tülekhe unless slurred or separated by a rest
 * Errors mean "physically impossible as written" and fail the note; warnings are style/teaching hints.
 */

import {
  allowedFingers,
  contactPositionMm,
  FINGER_NUMBER,
  harmonicNode,
  MAX_STOP,
  openMidi,
  otherString,
  partialForInterval,
  TUNINGS,
  VIBRATING_LENGTH_MM,
  type StringId,
  type Tuning
} from '../instrument'
import { midiToFreq, midiToName } from '../pitch'
import { BOW_INFO, isGlissando, TECHNIQUES } from '../techniques'
import type { Issue, Song, SongNote } from './types'

export interface NoteCheck {
  note: SongNote
  /** Semitones above the open string, or null for unpitched notes. */
  stop: number | null
  /** Distance from the nut of the finger contact (stop or harmonic node), in mm. */
  contactMm: number | null
  /** Harmonic partial for tsatsal notes. */
  partial: number | null
  /** Physically expected sounding frequency; natural harmonics use just (not tempered) ratios. */
  expectedFreq: number | null
  issues: Issue[]
  passed: boolean
}

export interface VerificationReport {
  checks: NoteCheck[]
  songIssues: Issue[]
  errors: number
  warnings: number
  passed: number
  total: number
  /** Fraction of notes without errors, 0–1. */
  score: number
}

const EPS = 1e-6
/** A rest at least this long (in beats) lets the player retake the bow in the same direction. */
const RETAKE_GAP_BEATS = 0.5
/** Consecutive notes further apart than this are not checked for finger crossing. */
const FINGER_CONTEXT_BEATS = 1
const FIRST_POSITION_MAX_STOP = 7
const ARTIFICIAL_INTERVALS = [24, 19, 12, 28]

const name = (midi: number) => midiToName(midi)
const stringLabel = (s: StringId) => (s === 'male' ? 'male (Arga)' : 'female (Bilag)')

export function verifySong(song: Song): VerificationReport {
  const tuning: Tuning = { id: 'song', name: '', male: song.tuning.male, female: song.tuning.female, scaleTonic: 0 }
  const songIssues: Issue[] = []

  if (!TUNINGS.some((t) => t.male === tuning.male && t.female === tuning.female)) {
    songIssues.push({
      severity: 'info',
      noteIndex: null,
      code: 'custom-tuning',
      message: `Custom tuning ${name(tuning.male)}–${name(tuning.female)}.`
    })
  }
  if (song.notes.length === 0) songIssues.push({ severity: 'warning', noteIndex: null, code: 'empty', message: 'Song has no notes.' })

  const checks: NoteCheck[] = []
  const lastOnString: Partial<Record<StringId, SongNote>> = {}
  let prevBowed: SongNote | null = null
  let prevFingered: { note: SongNote; stop: number; contactMm: number } | null = null

  for (const note of song.notes) {
    const issues: Issue[] = []
    const add = (severity: Issue['severity'], code: string, message: string) =>
      issues.push({ severity, noteIndex: note.index, code, message })
    const info = TECHNIQUES[note.technique]
    const check: NoteCheck = { note, stop: null, contactMm: null, partial: null, expectedFreq: null, issues, passed: true }

    if (note.stringInferred && note.string) add('info', 'string-inferred', `No string given; playing on the ${stringLabel(note.string)} string.`)

    const sounding = info.kind !== 'percussive'
    if (note.pitch !== null && note.string === null) {
      add('error', 'unplayable', `${name(note.pitch)} is outside the range of both strings.`)
    }

    if (note.pitch !== null && note.string !== null) {
      const open = openMidi(tuning, note.string)
      const d = note.pitch - open

      if (info.kind === 'harmonic') {
        if (note.technique === 'tsatsal_harmonic') {
          const partial = partialForInterval(d)
          if (partial === null) {
            const options = [12, 19, 24, 28].map((i) => name(open + i)).join(', ')
            add(
              'error',
              'not-a-harmonic',
              `${name(note.pitch)} is not a natural harmonic of the ${stringLabel(note.string)} string (open ${name(open)}); natural harmonics are ${options}.`
            )
          } else {
            const node = harmonicNode(partial)
            check.partial = partial
            check.stop = d
            check.contactMm = node.nodeFraction * VIBRATING_LENGTH_MM
            check.expectedFreq = midiToFreq(open) * partial
          }
        } else {
          const found = ARTIFICIAL_INTERVALS.map((i) => ({ i, base: d - i })).find(({ base }) => base >= 1 && base <= MAX_STOP)
          if (!found) {
            add('error', 'not-a-harmonic', `${name(note.pitch)} cannot be produced as an artificial harmonic on the ${stringLabel(note.string)} string.`)
          } else {
            const partial = partialForInterval(found.i)!
            check.partial = partial
            check.stop = found.base
            check.contactMm = contactPositionMm(found.base)
            check.expectedFreq = midiToFreq(open + found.base) * partial
          }
        }
      } else {
        check.stop = d
        if (d < 0) {
          add(sounding ? 'error' : 'warning', 'below-open', `${name(note.pitch)} is below the open ${stringLabel(note.string)} string (${name(open)}).`)
        } else if (d > MAX_STOP) {
          add(sounding ? 'error' : 'warning', 'above-range', `${name(note.pitch)} is above the playable range of the ${stringLabel(note.string)} string.`)
        } else {
          if (sounding) check.expectedFreq = midiToFreq(note.pitch)
          if (d > 0) check.contactMm = contactPositionMm(d)
        }

        if (note.technique === 'open' && d !== 0) {
          add('error', 'open-mismatch', `Marked "open" but ${name(note.pitch)} is not the open ${stringLabel(note.string)} string (${name(open)}).`)
        }
        if ((note.technique === 'cuticle_side_stop' || note.technique === 'fingernail_side_stop') && d === 0) {
          add('warning', 'stop-on-open', `${name(note.pitch)} is the open string; mark it "open".`)
        }
        if (info.kind === 'stopped' && d > 0 && d <= MAX_STOP && note.technique !== 'open') {
          if (note.finger === null) add('warning', 'missing-finger', `No finger given for the side-stopped ${name(note.pitch)}.`)
          else if (note.technique === 'erkhii_darakh' ? note.finger !== 'thumb' : note.finger !== 'thumb' && !allowedFingers(d).includes(note.finger)) {
            add('warning', 'finger-unusual', `The ${note.finger} finger is unusual for ${name(note.pitch)} in first position (expected ${allowedFingers(d).join(' or ')}).`)
          }
        }
        if (note.finger !== null && d === 0) add('warning', 'finger-on-open', 'A finger is given for an open-string note.')
        if (note.technique === 'erkhii_darakh') {
          // Sources differ on the string: most describe the thumb on the thin female string (C on the
          // B♭ string in first position); some schools hook it under the male string for extended,
          // high notes. Both are accepted; only a low thumb stop on the male string is flagged.
          if (note.string === 'male' && d > 0 && d < 5) add('warning', 'thumb-low', 'On the male string, thumb playing is used for extended, upper-register notes.')
        } else if (note.finger === 'thumb') {
          add('warning', 'thumb-technique', 'A thumb stop is notated as "erkhii_darakh".')
        }
        if (isGlissando(note.technique) && note.glideTo === null && !lastOnString[note.string]) {
          add('info', 'glide-from-below', 'No previous note on this string to slide from; the glissando rises into the note from a step below.')
        }
      }

      if (note.glideTo !== null) {
        const g = note.glideTo - open
        if (g < 0 || g > MAX_STOP) add('error', 'glide-out-of-range', `Glissando target ${name(note.glideTo)} is not reachable on the same string.`)
      }

      if (note.technique === 'double_stop') {
        const other = otherString(note.string)
        const dronePitch = note.drone ?? openMidi(tuning, other)
        const ds = dronePitch - openMidi(tuning, other)
        if (ds < 0 || ds > MAX_STOP) add('error', 'drone-out-of-range', `Drone ${name(dronePitch)} is not playable on the ${stringLabel(other)} string.`)
      }
    }

    // --- One pitch per string -------------------------------------------------------------
    if (sounding && note.string) {
      const occupied: StringId[] = note.technique === 'double_stop' ? [note.string, otherString(note.string)] : [note.string]
      for (const s of occupied) {
        const last = lastOnString[s]
        if (last && note.startBeats < last.startBeats + last.durationBeats - EPS) {
          add('error', 'string-overlap', `Overlaps note #${last.index + 1} on the ${stringLabel(s)} string — one string sounds one pitch at a time.`)
        }
        lastOnString[s] = note
      }
    }

    // --- Bow direction ----------------------------------------------------------------------
    if (info.needsBow && note.bow === null) add('warning', 'missing-bow', 'No bow direction (tatakh / tülekhe) given.')
    if (!info.needsBow && note.bow !== null) add('info', 'bow-ignored', `The bow direction is not used for ${info.name.toLowerCase()}.`)
    if (info.needsBow && note.bow !== null) {
      if (note.slur) {
        if (!prevBowed) add('warning', 'slur-without-previous', 'Slurred note has no previous bow stroke to continue.')
        else if (prevBowed.bow !== note.bow) {
          add('warning', 'slur-bow-change', `A slur continues the previous ${BOW_INFO[prevBowed.bow!].name} stroke, but this note is marked ${BOW_INFO[note.bow].name}.`)
        }
      } else if (prevBowed && prevBowed.bow === note.bow) {
        const gap = note.startBeats - (prevBowed.startBeats + prevBowed.durationBeats)
        if (gap < RETAKE_GAP_BEATS - EPS) {
          add('warning', 'bow-repeat', `Two ${BOW_INFO[note.bow].name} strokes in a row without a slur or rest — alternate tatakh and tülekhe.`)
        }
      }
      prevBowed = note
    }

    // --- Finger kinematics ------------------------------------------------------------------
    if (note.finger && note.finger !== 'thumb' && check.stop !== null && check.contactMm !== null && info.kind === 'stopped') {
      const stop = check.stop
      if (prevFingered && prevFingered.note.finger && note.startBeats - prevFingered.note.startBeats <= FINGER_CONTEXT_BEATS + EPS) {
        const bothFirstPosition = stop <= FIRST_POSITION_MAX_STOP && prevFingered.stop <= FIRST_POSITION_MAX_STOP
        const fa = FINGER_NUMBER[prevFingered.note.finger]
        const fb = FINGER_NUMBER[note.finger]
        const crossed = (fb > fa && check.contactMm < prevFingered.contactMm - EPS) || (fb < fa && check.contactMm > prevFingered.contactMm + EPS)
        if (bothFirstPosition && crossed) {
          add(
            'warning',
            'finger-crossing',
            `The ${note.finger} finger (${check.contactMm.toFixed(0)} mm) would sit on the wrong side of the ${prevFingered.note.finger} finger (${prevFingered.contactMm.toFixed(0)} mm) — needs a position shift.`
          )
        }
      }
      prevFingered = { note, stop, contactMm: check.contactMm }
    }

    check.passed = !issues.some((i) => i.severity === 'error')
    checks.push(check)
  }

  const all = [...songIssues, ...checks.flatMap((c) => c.issues)]
  const passed = checks.filter((c) => c.passed).length
  return {
    checks,
    songIssues,
    errors: all.filter((i) => i.severity === 'error').length,
    warnings: all.filter((i) => i.severity === 'warning').length,
    passed,
    total: checks.length,
    score: checks.length ? passed / checks.length : 0
  }
}
