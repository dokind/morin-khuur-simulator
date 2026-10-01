/**
 * MusicXML (score-partwise, or score-timewise converted to it) → melody for arrangeMelody.
 * One part and one voice are read; ties merge into single notes, chords keep their top note and
 * slurs mark every note after the first under the slur as `slur: true`. Pitches are sounding
 * pitches: a transposing part's <transpose> is applied to its written notes and key. Repeats,
 * first/second endings and D.C. / D.S. / Fine / Coda jumps are played out as written.
 */

import type { MelodyInput, MelodyNote } from './melody'
import type { TimeSignature } from './timing'
import { parseXml, xmlChild, xmlChildren, xmlPath, xmlText, type XmlElement } from './xml'

export interface MusicXmlImportOptions {
  /** Part index in document order (default: the first part with pitched notes). */
  part?: number
  /** Overrides the title stored in the file. */
  title?: string
}

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
/** Note <type> / metronome <beat-unit> values in quarter notes. */
const NOTE_TYPE_QUARTERS: Record<string, number> = {
  maxima: 32,
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  '128th': 0.03125
}
const DEFAULT_TEMPO = 90
const EPS = 1e-6
/** A rest at least this long (beats) closes any slur still open (e.g. one ending in another voice). */
const SLUR_BREAK_BEATS = 1
/** Plays of one repeated section are capped here (a `times` attribute can ask for any number). */
const MAX_REPEAT_PLAYS = 16
/** Playing out repeats and jumps stops after this many bars. */
const MAX_PLAYED_BARS = 20_000

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

interface NoteEvent {
  start: number
  duration: number
  midi: number
  velocity: number
  tieStart: boolean
  tieStop: boolean
  slurStarts: string[]
  slurStops: string[]
  /** Order of appearance, to keep chords stable. */
  order: number
}

/** One bar of the melody part, read once in document order. */
interface ParsedBar {
  /** Notes of the chosen voice; starts are relative to the bar. */
  events: NoteEvent[]
  /** Quarter notes the bar actually lasts. */
  length: number
  /** Quarter notes in a full bar of the time signature in force. */
  barLength: number
  graces: number
  malformed: number
}

interface Ending {
  start: number
  end: number
  /** Passes the ending is played on, or null when its number is unreadable (played on every pass). */
  passes: number[] | null
  label: string
}

/** Repeat barlines and endings, by bar index. */
interface RepeatMarks {
  /** Bars that open a repeated section. */
  forward: Set<number>
  /** Bars that close one: stated total plays (null when not stated) and whether it also repeats after a D.C./D.S. */
  backward: Map<number, { times: number | null; afterJump: boolean }>
  endings: Ending[]
}

/** Segno / coda signs and D.C. / D.S. / Fine / To Coda instructions, by bar index. */
interface JumpMarks {
  segnos: { bar: number; label: string }[]
  codas: { bar: number; label: string }[]
  toCoda: Map<number, string>
  daCapo: Set<number>
  dalSegno: Map<number, string>
  fine: Set<number>
}

const num = (el: XmlElement | undefined): number | null => {
  const text = xmlText(el)
  if (!text) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/** First number in free text such as "c. 120" or "96-104". */
const leadingNumber = (el: XmlElement | undefined): number | null => {
  const m = /\d+(?:\.\d+)?/.exec(xmlText(el))
  return m ? Number(m[0]) : null
}

/** score-timewise nests parts in measures; regroup it as score-partwise. */
function toPartwise(root: XmlElement): XmlElement {
  if (root.name !== 'score-timewise') return root
  const parts = new Map<string, XmlElement>()
  for (const measure of xmlChildren(root, 'measure')) {
    for (const part of xmlChildren(measure, 'part')) {
      const id = part.attrs.id ?? ''
      if (!parts.has(id)) parts.set(id, { name: 'part', attrs: { id }, children: [] })
      parts.get(id)!.children.push({ name: 'measure', attrs: measure.attrs, children: part.children })
    }
  }
  const header = root.children.filter((c) => typeof c === 'string' || c.name !== 'measure')
  return { name: 'score-partwise', attrs: root.attrs, children: [...header, ...parts.values()] }
}

function timeOf(attributes: XmlElement): TimeSignature | null {
  const time = xmlChild(attributes, 'time')
  if (!time) return null
  // Compound numerators like "3+2" add up.
  const beats = xmlText(xmlChild(time, 'beats'))
    .split('+')
    .reduce((sum, b) => sum + Number(b), 0)
  const unit = num(xmlChild(time, 'beat-type'))
  return Number.isFinite(beats) && beats > 0 && unit && unit > 0 ? { beats, unit } : null
}

/** Written pitch → MIDI, or null when malformed (octave outside 0–9, absurd alteration). */
function midiOf(pitch: XmlElement): number | null {
  const step = STEP_PC[xmlText(xmlChild(pitch, 'step')).toUpperCase()]
  const octave = num(xmlChild(pitch, 'octave'))
  const alter = Math.round(num(xmlChild(pitch, 'alter')) ?? 0)
  if (step === undefined || octave === null || !Number.isInteger(octave) || octave < 0 || octave > 9 || Math.abs(alter) > 2) return null
  return (octave + 1) * 12 + step + alter
}

/** Semitones from written to sounding pitch for a transposing part (0 when none). */
function transposeOf(attributes: XmlElement): number | null {
  const transpose = xmlChild(attributes, 'transpose')
  if (!transpose) return null
  const chromatic = Math.round(num(xmlChild(transpose, 'chromatic')) ?? 0)
  const octaves = Math.round(num(xmlChild(transpose, 'octave-change')) ?? 0)
  const semitones = chromatic + 12 * octaves
  return Math.abs(semitones) <= 48 ? semitones : 0
}

/** Tempo in quarter notes per minute from a <direction> or <sound>, if it has one. */
function tempoOf(el: XmlElement): number | null {
  const sounds = el.name === 'sound' ? [el] : xmlChildren(el, 'sound')
  for (const s of sounds) {
    const t = Number(s.attrs.tempo)
    if (s.attrs.tempo !== undefined && Number.isFinite(t) && t > 0) return t
  }
  if (el.name !== 'direction') return null
  for (const type of xmlChildren(el, 'direction-type')) {
    const metronome = xmlChild(type, 'metronome')
    const perMinute = leadingNumber(xmlChild(metronome, 'per-minute'))
    const unit = NOTE_TYPE_QUARTERS[xmlText(xmlChild(metronome, 'beat-unit'))]
    const dots = xmlChildren(metronome, 'beat-unit-dot').length
    if (perMinute && unit) return perMinute * unit * (2 - 0.5 ** dots)
  }
  return null
}

/** Length of a note from its <type>, dots and tuplet ratio, in quarter notes (null without a type). */
function notatedQuarters(note: XmlElement): number | null {
  const base = NOTE_TYPE_QUARTERS[xmlText(xmlChild(note, 'type'))]
  if (!base) return null
  const dots = xmlChildren(note, 'dot').length
  const modification = xmlChild(note, 'time-modification')
  const actual = num(xmlChild(modification, 'actual-notes'))
  const normal = num(xmlChild(modification, 'normal-notes'))
  const tuplet = actual && normal && actual > 0 && normal > 0 ? normal / actual : 1
  return base * (2 - 0.5 ** dots) * tuplet
}

const isPitchedNote = (n: XmlElement) => !!xmlChild(n, 'pitch') && !xmlChild(n, 'grace')

/** Reads one part of a MusicXML document as a melody. */
export function musicXmlToMelody(xml: string, options: MusicXmlImportOptions = {}): MelodyInput {
  const root = toPartwise(parseXml(xml))
  if (root.name !== 'score-partwise') throw new Error(`Not a MusicXML score (root element <${root.name}>).`)
  const parts = xmlChildren(root, 'part')
  if (parts.length === 0) throw new Error('The MusicXML score has no parts.')

  let partIndex = options.part ?? parts.findIndex((p) => xmlChildren(p, 'measure').some((m) => xmlChildren(m, 'note').some(isPitchedNote)))
  if (partIndex < 0) partIndex = 0
  const part = parts[partIndex]
  if (!part) throw new Error(`The MusicXML score has no part ${options.part}.`)
  const messages: string[] = []
  const scorePart = xmlChildren(xmlChild(root, 'part-list'), 'score-part').find((sp) => sp.attrs.id === part.attrs.id)
  const partName = xmlText(xmlChild(scorePart, 'part-name'))
  if (parts.length > 1) messages.push(`Took the melody from part ${partName ? `"${partName}"` : `#${partIndex + 1}`} (ignored ${parts.length - 1} other part${parts.length === 2 ? '' : 's'}).`)

  const measures = xmlChildren(part, 'measure')
  const allNotes = measures.flatMap((m) => xmlChildren(m, 'note'))
  const voices = new Set(allNotes.filter(isPitchedNote).map((n) => xmlText(xmlChild(n, 'voice')) || '1'))
  const voice = voices.has('1') || voices.size === 0 ? '1' : [...voices].sort((a, b) => Number(a) - Number(b))[0]!
  if (voices.size > 1) messages.push(`Read voice ${voice} only (the part has ${voices.size} voices).`)

  let divisions = 1
  let divisionsKnown = false
  let transpose = 0
  let timeSignature: TimeSignature | null = null
  let meter: TimeSignature | null = null
  let barLength = 4
  let timeChanges = 0
  let keyPc: number | null = null

  // Each bar is read once in document order (attributes carry over from bar to bar); the bars are
  // then laid out in playing order, repeats included.
  const bars: ParsedBar[] = []
  for (const measure of measures) {
    let cursor = 0
    let maxCursor = 0
    let lastStart = 0
    const bar: ParsedBar = { events: [], length: 0, barLength: 0, graces: 0, malformed: 0 }

    for (const el of xmlChildren(measure)) {
      if (el.name === 'attributes') {
        const d = num(xmlChild(el, 'divisions'))
        if (d !== null && d > 0) {
          divisions = d
          divisionsKnown = true
        }
        const semitones = transposeOf(el)
        if (semitones !== null) {
          if (semitones !== 0 && semitones !== transpose) messages.push(`Transposed the written part ${semitones > 0 ? 'up' : 'down'} ${Math.abs(semitones)} semitone(s) to concert pitch.`)
          transpose = semitones
        }
        const ts = timeOf(el)
        if (ts) {
          if (meter && (ts.beats !== meter.beats || ts.unit !== meter.unit)) timeChanges++
          meter = ts
          timeSignature ??= ts
          barLength = (ts.beats * 4) / ts.unit
        }
        const fifths = num(xmlPath(el, 'key', 'fifths'))
        if (keyPc === null && fifths !== null) keyPc = (((Math.round(fifths) * 7 + transpose) % 12) + 12) % 12
      } else if (el.name === 'backup' || el.name === 'forward') {
        const d = (num(xmlChild(el, 'duration')) ?? 0) / divisions
        cursor = Math.max(0, cursor + (el.name === 'backup' ? -d : d))
        maxCursor = Math.max(maxCursor, cursor)
      } else if (el.name === 'note') {
        const pitch = xmlChild(el, 'pitch')
        const inVoice = !!pitch && !xmlChild(el, 'cue') && (xmlText(xmlChild(el, 'voice')) || '1') === voice
        if (xmlChild(el, 'grace')) {
          if (inVoice) bar.graces++
          continue
        }
        const rawDuration = Math.max(0, num(xmlChild(el, 'duration')) ?? 0)
        if (!divisionsKnown && rawDuration > 0) {
          // No <divisions> before the first note: infer it from the note's written type.
          const quarters = notatedQuarters(el)
          if (quarters) {
            divisions = rawDuration / quarters
            messages.push(`The score declares no divisions; inferred ${+divisions.toFixed(3)} per quarter note from the note types.`)
          } else messages.push('The score declares no divisions; assuming durations are in quarter notes.')
          divisionsKnown = true
        }
        const duration = rawDuration / divisions
        const chord = !!xmlChild(el, 'chord')
        const start = chord ? lastStart : cursor
        if (!chord) {
          lastStart = cursor
          cursor += duration
          maxCursor = Math.max(maxCursor, cursor)
        }
        if (!pitch || !inVoice) continue
        const written = midiOf(pitch)
        if (written === null) {
          bar.malformed++
          continue
        }

        const ties = [...xmlChildren(el, 'tie'), ...xmlChildren(xmlChild(el, 'notations'), 'tied')].map((t) => t.attrs.type)
        const slurs = xmlChildren(xmlChild(el, 'notations'), 'slur')
        const dynamics = Number(el.attrs.dynamics)
        bar.events.push({
          start,
          duration,
          midi: written + transpose,
          // MusicXML dynamics are a percentage of forte (MIDI velocity 90).
          velocity: el.attrs.dynamics !== undefined && Number.isFinite(dynamics) ? Math.min(1, Math.max(0.05, (dynamics * 0.9) / 127)) : 0.8,
          tieStart: ties.includes('start'),
          tieStop: ties.includes('stop'),
          slurStarts: slurs.filter((s) => s.attrs.type === 'start').map((s) => s.attrs.number ?? '1'),
          slurStops: slurs.filter((s) => s.attrs.type === 'stop').map((s) => s.attrs.number ?? '1'),
          order: 0
        })
      }
    }

    bar.length = maxCursor > EPS ? maxCursor : barLength
    bar.barLength = barLength
    bars.push(bar)
  }

  // Repeat barlines are usually written in every part, jumps and signs often only in the top one.
  const repeatPart = [part, ...parts].find((p) => xmlChildren(p, 'measure').some((m) => xmlChildren(m, 'barline').some((b) => xmlChild(b, 'repeat') || xmlChild(b, 'ending')))) ?? part
  const barLabel = (bar: number) => measures[bar]?.attrs.number ?? String(bar + 1)
  const plan = playbackOrder(measures.length, readRepeats(xmlChildren(repeatPart, 'measure')), readJumps(parts, measures.length), barLabel, messages)

  const events: NoteEvent[] = []
  let order = 0
  let measureStart = 0
  let graces = 0
  let malformed = 0
  const opening = bars[0]
  // Pickup (anacrusis): start the opening bar late so later barlines fall on whole bars.
  if (opening && measures.length > 1 && plan[0] === 0 && opening.length < opening.barLength - EPS) {
    measureStart = opening.barLength - opening.length
    messages.push('Aligned the pickup (anacrusis) so bar lines fall in place.')
  }
  /** Where playback resumes after a jump (repeat, skipped ending, D.C. / D.S., To Coda). */
  const jumpTimes: number[] = []
  for (const [k, index] of plan.entries()) {
    const bar = bars[index]!
    if (k > 0 && index !== plan[k - 1]! + 1) jumpTimes.push(measureStart)
    for (const e of bar.events) events.push({ ...e, start: measureStart + e.start, slurStarts: [...e.slurStarts], slurStops: [...e.slurStops], order: order++ })
    graces += bar.graces
    malformed += bar.malformed
    measureStart += bar.length
  }

  if (malformed) messages.push(`Skipped ${malformed} note(s) with an unreadable pitch.`)
  if (graces) messages.push(`Left out ${plural(graces, 'grace note')} (ornaments are not arranged).`)
  if (timeChanges) messages.push(`The score changes time signature ${timeChanges} time(s); only the first is kept (note timing is unaffected).`)
  // The melody part's tempo marks, else the first part's that has any (often only the top part does).
  const tempos = [part, ...parts].reduce<number[]>((found, p) => (found.length ? found : tempoMarks(p)), [])
  const tempo = tempos[0] ?? null
  const tempoChanges = tempos.filter((t, i) => i > 0 && Math.abs(t - tempos[i - 1]!) > EPS).length
  if (tempoChanges) messages.push(`The score changes tempo ${tempoChanges} time(s); only the first tempo is kept.`)

  // Ties: merge each continuation into the note it continues (same pitch, ending where it starts).
  events.sort((a, b) => a.start - b.start || a.order - b.order)
  const merged: NoteEvent[] = []
  const openTies = new Map<number, NoteEvent>()
  for (const e of events) {
    const held = e.tieStop ? openTies.get(e.midi) : undefined
    if (held && Math.abs(held.start + held.duration - e.start) < EPS) {
      held.duration += e.duration
      // A slur that starts and ends inside one tied note is only drawn over the tie: drop it, or it
      // would stay open and slur the rest of the piece.
      for (const n of e.slurStops) {
        const at = held.slurStarts.lastIndexOf(n)
        if (at >= 0) held.slurStarts.splice(at, 1)
        else held.slurStops.push(n)
      }
      held.slurStarts.push(...e.slurStarts)
      if (!e.tieStart) openTies.delete(e.midi)
      continue
    }
    merged.push(e)
    if (e.tieStart) openTies.set(e.midi, e)
    else openTies.delete(e.midi)
  }

  // Chords: keep the top note of each onset; slur marks on any chord note count for the onset.
  const onsets: NoteEvent[] = []
  let chordNotes = 0
  for (const e of merged) {
    const prev = onsets[onsets.length - 1]
    if (prev && Math.abs(prev.start - e.start) < EPS) {
      chordNotes++
      const slurStarts = [...prev.slurStarts, ...e.slurStarts]
      const slurStops = [...prev.slurStops, ...e.slurStops]
      const top = e.midi > prev.midi ? e : prev
      onsets[onsets.length - 1] = { ...top, slurStarts, slurStops }
    } else onsets.push(e)
  }
  if (chordNotes) messages.push(`Kept the top note of each chord (${plural(chordNotes, 'note')} removed).`)

  // Slurs: every note after the first under an open slur continues the bow. No slur carries across a
  // jump: one from the repeated body into the 1st ending opens again on the next pass, and that pass
  // jumps to the 2nd ending, so its stop would never come.
  const openSlurs = new Set<string>()
  let prevEnd = -Infinity
  let nextJump = 0
  const notes: MelodyNote[] = onsets.map((e) => {
    let jumped = false
    for (; nextJump < jumpTimes.length && e.start >= jumpTimes[nextJump]! - EPS; nextJump++) jumped = true
    if (jumped || e.start - prevEnd >= SLUR_BREAK_BEATS - EPS) openSlurs.clear()
    prevEnd = Math.max(prevEnd, e.start + e.duration)
    const slur = openSlurs.size > 0
    for (const n of e.slurStops) openSlurs.delete(n)
    for (const n of e.slurStarts) openSlurs.add(n)
    return { startBeats: e.start, durationBeats: e.duration, midi: e.midi, velocity: e.velocity, slur }
  })

  // Page credits: many exporters put the displayed title and composer only there.
  const credit = (type: string) => {
    const c = xmlChildren(root, 'credit').find((el) => xmlChildren(el, 'credit-type').some((t) => xmlText(t) === type))
    return xmlChildren(c, 'credit-words')
      .map((w) => xmlText(w))
      .filter(Boolean)
      .join(' ')
  }
  const title = options.title ?? (xmlText(xmlPath(root, 'work', 'work-title')) || xmlText(xmlChild(root, 'movement-title')) || credit('title'))
  const composer = xmlText(xmlChildren(xmlChild(root, 'identification'), 'creator').find((c) => c.attrs.type === 'composer')) || credit('composer')
  return {
    title,
    ...(composer ? { composer } : {}),
    tempoBpm: tempo ?? DEFAULT_TEMPO,
    timeSignature: timeSignature ?? { beats: 4, unit: 4 },
    keyPc,
    notes,
    messages
  }
}

/** Every tempo marking under `root`, in document order. */
function tempoMarks(root: XmlElement): number[] {
  const tempos: number[] = []
  const pending: XmlElement[] = [root]
  while (pending.length) {
    const el = pending.pop()!
    if (el.name === 'direction' || el.name === 'sound') {
      // tempoOf reads a direction's own <sound>s, so its children are not visited again.
      const t = tempoOf(el)
      if (t !== null) tempos.push(t)
      continue
    }
    const children = xmlChildren(el)
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!)
  }
  return tempos
}

/** Passes listed in an ending's number, e.g. "1", "1, 2" or "1-3"; null when unreadable. */
function endingPasses(label: string): number[] | null {
  const passes: number[] = []
  for (const item of label.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+)\.?(?:-(\d+)\.?)?$/.exec(item)
    if (!m) return null
    const from = Number(m[1])
    const to = Math.min(Number(m[2] ?? m[1]), from + MAX_REPEAT_PLAYS)
    for (let p = from; p <= to; p++) passes.push(p)
  }
  return passes.length ? passes : null
}

/** Repeat barlines and first/second endings of one part. */
function readRepeats(measures: XmlElement[]): RepeatMarks {
  const forward = new Set<number>()
  const backward = new Map<number, { times: number | null; afterJump: boolean }>()
  const opened: { start: number; end: number | null; label: string }[] = []
  let open: (typeof opened)[number] | null = null
  for (const [i, measure] of measures.entries()) {
    for (const barline of xmlChildren(measure, 'barline')) {
      // A barline without a location is the bar's right-hand one.
      const left = barline.attrs.location === 'left'
      const repeat = xmlChild(barline, 'repeat')
      if (repeat?.attrs.direction === 'forward') forward.add(left ? i : i + 1)
      else if (repeat?.attrs.direction === 'backward' && (!left || i > 0)) {
        const times = Number(repeat.attrs.times)
        backward.set(left ? i - 1 : i, {
          times: repeat.attrs.times !== undefined && Number.isInteger(times) && times >= 1 ? times : null,
          afterJump: repeat.attrs['after-jump'] === 'yes'
        })
      }
      const ending = xmlChild(barline, 'ending')
      if (ending?.attrs.type === 'start') {
        open = { start: i, end: null, label: (ending.attrs.number ?? '').trim() }
        opened.push(open)
      } else if ((ending?.attrs.type === 'stop' || ending?.attrs.type === 'discontinue') && open) {
        open.end = i
        open = null
      }
    }
  }
  const endings = opened.map((e, k): Ending => {
    // An ending left open runs to its first end-repeat before the next ending, else covers one bar.
    const limit = opened[k + 1]?.start ?? measures.length
    let end = e.end ?? e.start
    for (let b = e.start; e.end === null && b < limit; b++) {
      if (backward.has(b)) {
        end = b
        break
      }
    }
    return { start: e.start, end: Math.max(e.start, Math.min(end, limit - 1)), passes: endingPasses(e.label), label: e.label }
  })
  return { forward, backward, endings }
}

/** Jump instructions of a <sound>; true when it has any (its direction's words are then not read). */
function soundJumps(sound: XmlElement, bar: number, marks: JumpMarks): boolean {
  const a = sound.attrs
  if (a.dacapo === 'yes') marks.daCapo.add(bar)
  if (a.dalsegno !== undefined) marks.dalSegno.set(bar, a.dalsegno)
  if (a.segno !== undefined) marks.segnos.push({ bar, label: a.segno })
  if (a.coda !== undefined) marks.codas.push({ bar, label: a.coda })
  if (a.tocoda !== undefined) marks.toCoda.set(bar, a.tocoda)
  if (a.fine !== undefined) marks.fine.add(bar)
  return ['dacapo', 'dalsegno', 'segno', 'coda', 'tocoda', 'fine'].some((k) => a[k] !== undefined)
}

/** Jumps written only as text ("D.C. al Fine", "To Coda", "Fine") or as a segno / coda sign. */
function wordJumps(direction: XmlElement, bar: number, marks: JumpMarks): void {
  const types = xmlChildren(direction, 'direction-type')
  const text = types
    .flatMap((t) => xmlChildren(t, 'words'))
    .map((w) => xmlText(w))
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  if (/^(?:d\. ?c\.?|dc|da capo)(?![a-z])/.test(text)) marks.daCapo.add(bar)
  else if (/^(?:d\. ?s\.?|ds|dal segno)(?![a-z])/.test(text)) marks.dalSegno.set(bar, '')
  else if (/\bto coda\b/.test(text)) marks.toCoda.set(bar, '')
  else if (/^fine\W*$/.test(text)) marks.fine.add(bar)
  else if (types.some((t) => xmlChild(t, 'segno'))) marks.segnos.push({ bar, label: '' })
  else if (types.some((t) => xmlChild(t, 'coda')) || /^coda\b/.test(text)) marks.codas.push({ bar, label: '' })
}

/** Segno / coda signs and jump instructions from every part (exporters often write them in the top part only). */
function readJumps(parts: XmlElement[], count: number): JumpMarks {
  const marks: JumpMarks = { segnos: [], codas: [], toCoda: new Map(), daCapo: new Set(), dalSegno: new Map(), fine: new Set() }
  for (const part of parts) {
    for (const [i, measure] of xmlChildren(part, 'measure').entries()) {
      if (i >= count) break
      for (const el of xmlChildren(measure)) {
        if (el.name === 'sound') soundJumps(el, i, marks)
        else if (el.name === 'direction') {
          if (!xmlChildren(el, 'sound').map((s) => soundJumps(s, i, marks)).includes(true)) wordJumps(el, i, marks)
        } else if (el.name === 'barline') {
          // A sign on a bar's right-hand barline marks the start of the next bar.
          const at = (el.attrs.location ?? 'right') === 'right' ? i + 1 : i
          if (xmlChild(el, 'segno')) marks.segnos.push({ bar: at, label: el.attrs.segno ?? '' })
          if (xmlChild(el, 'coda')) marks.codas.push({ bar: at, label: el.attrs.coda ?? '' })
        }
      }
    }
  }
  return marks
}

const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/**
 * Bar indices in playing order. Follows repeats (`times` plays, inferred from the endings when not
 * stated), first/second endings and D.C. / D.S. jumps with al Fine / al Coda. As is conventional,
 * repeats are not taken again after a jump (unless marked after-jump) and the last ending (or the
 * one holding the Fine) is played. Each jump is followed once, so the result is always finite; a
 * note is added to `messages` saying what was expanded and what could not be followed.
 */
function playbackOrder(count: number, repeats: RepeatMarks, jumps: JumpMarks, barLabel: (bar: number) => string, messages: string[]): number[] {
  const { forward, backward, endings } = repeats

  // Endings that follow one another form a group: the 1st, 2nd… endings of one repeated section. An
  // ending for a pass the group already has (the "1." of a section that starts right after it) begins
  // a new group, as does an unreadable one that opens a repeated section.
  const groups: Ending[][] = []
  for (const e of endings) {
    const group = groups[groups.length - 1]
    const taken = new Set(group?.flatMap((g) => g.passes ?? []))
    const continues = e.passes ? !e.passes.some((p) => taken.has(p)) : !forward.has(e.start)
    if (group && continues && e.start === group[group.length - 1]!.end + 1) group.push(e)
    else groups.push([e])
  }
  const endingAt = new Map<number, { ending: Ending; group: Ending[] }>()
  const groupOf = new Map<number, Ending[]>()
  for (const group of groups) {
    for (const ending of group) {
      endingAt.set(ending.start, { ending, group })
      for (let b = ending.start; b <= ending.end; b++) groupOf.set(b, group)
    }
  }
  const lastPass = (group: Ending[]) => Math.max(1, ...group.flatMap((e) => e.passes ?? []))
  // After a D.C./D.S. the section is played once more: through the ending holding the Fine, else the last one.
  const endingAfterJump = (group: Ending[]) =>
    group.find((e) => [...jumps.fine].some((b) => b >= e.start && b <= e.end)) ?? group.find((e) => e.passes?.includes(lastPass(group))) ?? group[group.length - 1]
  const lastOfGroup = new Set(groups.map((g) => g[g.length - 1]!.end))
  // A group holding an end-repeat closes its section: a later end-repeat starts after it.
  const closesSection = new Set([...backward.keys()].flatMap((b) => groupOf.get(b)?.slice(-1).map((e) => e.end) ?? []))

  /** One message per kind of problem, naming the first few bars it occurs in. */
  const report = (at: number[], one: (where: string) => string, many: (where: string) => string) => {
    const names = at.map(barLabel)
    if (names.length === 1) messages.push(one(`bar ${names[0]}`))
    else if (names.length > 1) messages.push(many(`bars ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`))
  }
  const unreadable = endings.filter((e) => !e.passes)
  report(
    unreadable.map((e) => e.start),
    (where) => `Could not read the ending number${unreadable[0]!.label ? ` "${unreadable[0]!.label}"` : ''} in ${where}; played that ending on every pass.`,
    (where) => `Could not read ${unreadable.length} ending numbers (${where}); played those endings on every pass.`
  )

  // Where each end-repeat jumps back to: the last start-repeat since the previous repeated section.
  const target = new Map<number, number>()
  const times = new Map<number, number>()
  const capped: { bar: number; wanted: number }[] = []
  let sectionStart = 0
  for (let bar = 0; bar < count; bar++) {
    if (forward.has(bar)) sectionStart = bar
    const repeat = backward.get(bar)
    if (repeat) {
      target.set(bar, sectionStart)
      const group = groupOf.get(bar)
      const wanted = repeat.times ?? (group ? Math.max(2, lastPass(group)) : 2)
      if (wanted > MAX_REPEAT_PLAYS) capped.push({ bar, wanted })
      times.set(bar, Math.min(wanted, MAX_REPEAT_PLAYS))
      if (!group) sectionStart = bar + 1
    }
    if (closesSection.has(bar)) sectionStart = bar + 1
  }
  report(
    capped.map((c) => c.bar),
    (where) => `The repeat ending in ${where} asks for ${capped[0]!.wanted} plays; played it ${MAX_REPEAT_PLAYS} times.`,
    (where) => `${capped.length} repeats (${where}) ask for more than ${MAX_REPEAT_PLAYS} plays; played each ${MAX_REPEAT_PLAYS} times.`
  )
  const targets = new Set(target.values())
  report(
    [...forward].filter((bar) => bar < count && !targets.has(bar)),
    (where) => `The start-repeat in ${where} has no end-repeat; played that section once.`,
    (where) => `Start-repeats in ${where} have no end-repeat; played those sections once.`
  )

  const segnoFor = (label: string, from: number) =>
    (jumps.segnos.find((s) => label !== '' && s.label === label) ?? jumps.segnos.findLast((s) => s.bar <= from) ?? jumps.segnos[0])?.bar
  const codaFor = (label: string, from: number) => {
    const after = jumps.codas.filter((c) => c.bar > from)
    return (after.find((c) => label !== '' && c.label === label) ?? after[0])?.bar
  }

  const order: number[] = []
  /** Jumps back taken per repeated section (keyed by its first bar). */
  const plays = new Map<number, number>()
  /** D.C. / D.S. / To Coda instructions already followed: each is followed once. */
  const followed = new Set<string>()
  let pass = 1
  let jumped = false
  let repeatsTaken = 0
  let endingsSkipped = 0
  const jumpNames: string[] = []
  let alFine = false
  let alCoda = false
  const noCoda: number[] = []
  const noSegno: number[] = []
  const jumpTo = (bar: number, kind: string) => {
    jumped = true
    jumpNames.push(kind)
    plays.clear()
    pass = 1
    return bar
  }

  let bar = 0
  while (bar < count) {
    const at = endingAt.get(bar)
    if (at) {
      const { ending, group } = at
      const once = jumped && !group.some((e) => backward.get(e.end)?.afterJump)
      if (ending.passes && !(once ? ending === endingAfterJump(group) : ending.passes.includes(pass))) {
        endingsSkipped++
        if (ending === group[group.length - 1]) pass = 1
        bar = ending.end + 1
        continue
      }
    }
    if (order.length >= MAX_PLAYED_BARS) {
      messages.push(`Playing out the repeats would take more than ${MAX_PLAYED_BARS.toLocaleString('en')} bars; stopped there.`)
      break
    }
    order.push(bar)

    if (jumped && jumps.fine.has(bar)) {
      alFine = true
      break
    }
    const toCoda = jumps.toCoda.get(bar)
    if (jumped && toCoda !== undefined && !followed.has(`coda ${bar}`)) {
      followed.add(`coda ${bar}`)
      const coda = codaFor(toCoda, bar)
      if (coda !== undefined) {
        alCoda = true
        bar = coda
        continue
      }
      noCoda.push(bar)
    }
    const repeat = backward.get(bar)
    if (repeat && (!jumped || repeat.afterJump)) {
      const start = target.get(bar)!
      const done = plays.get(start) ?? 0
      if (done < times.get(bar)! - 1) {
        plays.set(start, done + 1)
        pass = done + 2
        repeatsTaken++
        bar = start
        continue
      }
      pass = 1
    }
    if (jumps.daCapo.has(bar) && !followed.has(`dc ${bar}`)) {
      followed.add(`dc ${bar}`)
      bar = jumpTo(0, 'D.C.')
      continue
    }
    const dalSegno = jumps.dalSegno.get(bar)
    if (dalSegno !== undefined && !followed.has(`ds ${bar}`)) {
      followed.add(`ds ${bar}`)
      const segno = segnoFor(dalSegno, bar)
      if (segno !== undefined && segno < count) {
        bar = jumpTo(segno, 'D.S.')
        continue
      }
      noSegno.push(bar)
    }
    if (lastOfGroup.has(bar)) pass = 1
    bar++
  }
  report(
    noCoda,
    (where) => `Found "To Coda" in ${where} but no coda sign after it; played on.`,
    (where) => `Found "To Coda" in ${where} but no coda sign after them; played on.`
  )
  report(
    noSegno,
    (where) => `Found a D.S. (dal segno) in ${where} but no segno sign; ignored the jump.`,
    (where) => `Found D.S. (dal segno) in ${where} but no segno sign; ignored the jumps.`
  )

  const expanded: string[] = []
  if (repeatsTaken) expanded.push(plural(repeatsTaken, 'repeat'))
  if (endingsSkipped) expanded.push('first/second endings')
  if (jumpNames.length) expanded.push(`${[...new Set(jumpNames)].join(' and ')}${alCoda ? ' al Coda' : alFine ? ' al Fine' : ''}`)
  if (expanded.length) messages.push(`Played ${listed(expanded)} as written (${plural(count, 'bar')} in the score, ${order.length} played).`)
  return order
}
