/**
 * Step-sequencer model and horse-gait grooves (spec §4). One step is always a sixteenth note;
 * a 4/4 bar has 16 steps and a 6/8 bar has 12. Patterns are one or two bars long, carry a
 * velocity and a pitch offset per step, and live in four banks (A–D) that can be chained.
 */

import { PAD_IDS, PAD_MIDI, padInfo, type PadId } from './kit'
import type { MidiNote, MidiSong, MidiTrack } from './midi'

export type Meter = '4/4' | '6/8'

export const STEPS_PER_BAR: Record<Meter, number> = { '4/4': 16, '6/8': 12 }

/** Longest pattern, in bars (32 steps in 4/4, 24 in 6/8). */
export const MAX_BARS = 2

/** Per-step pitch offsets span ±this many semitones. */
export const PITCH_RANGE = 12

export interface Groove {
  id: string
  name: string
  meter: Meter
  description: string
  /** MPC-style swing ratio for step pairs: 0.5 straight, 0.667 triplet, 0.75 dotted. */
  swing: number
  /** Extra per-step timing push, as a fraction of a step (repeats every bar). */
  offsets?: readonly number[]
  /** Per-step velocity multipliers (repeats every bar). */
  accents: readonly number[]
}

const FOUR_FOUR_ACCENTS = [1, 0.6, 0.75, 0.6, 0.9, 0.6, 0.75, 0.6, 0.95, 0.6, 0.75, 0.6, 0.9, 0.6, 0.75, 0.6]
const SIX_EIGHT_ACCENTS = [1, 0.55, 0.7, 0.55, 0.75, 0.55, 0.95, 0.55, 0.7, 0.55, 0.75, 0.55]
/**
 * Three hoofbeats and a suspension per beat: hind, diagonal pair, leading foreleg (the heaviest
 * landing), then the moment in the air.
 */
const GALLOP_112_ACCENTS = [0.85, 0.9, 1, 0.45, 0.75, 0.85, 0.95, 0.45, 0.8, 0.9, 1, 0.45, 0.75, 0.85, 0.95, 0.45]

export const GROOVES: readonly Groove[] = [
  { id: 'straight', name: 'Straight', meter: '4/4', swing: 0.5, accents: FOUR_FOUR_ACCENTS, description: 'Even sixteenths for modern beats.' },
  {
    id: 'gallop',
    name: 'Galloping Swing',
    meter: '4/4',
    swing: 0.667,
    accents: FOUR_FOUR_ACCENTS,
    description: 'Triplet gallop: sixteenth pairs pulled onto a triplet grid (long–short, 2:1).'
  },
  {
    // Measured horse gallops land their hoofbeats at inter-onset ratios of about 1:1:2 (Sapienza
    // lab); walk and trot are even. On the sixteenth grid that is three steps and a rest per beat.
    id: 'gallop-112',
    name: 'Gallop 1-1-2',
    meter: '4/4',
    swing: 0.5,
    accents: GALLOP_112_ACCENTS,
    description: 'Horse gallop, onsets 1:1:2 (16th–16th–8th): fill three steps a beat, the third hoof accented.'
  },
  {
    id: 'towoo',
    name: 'Töwöö trot',
    meter: '4/4',
    swing: 0.75,
    accents: FOUR_FOUR_ACCENTS,
    description: 'Dotted-eighth + sixteenth pairs: the dotted trot.'
  },
  {
    id: 'joroo',
    name: 'Joroo amble',
    meter: '6/8',
    swing: 0.5,
    // Lilt: the middle eighth of each group of three arrives a touch early, the last a touch late.
    offsets: [0, 0, -0.08, 0, 0.06, 0, 0, 0, -0.08, 0, 0.06, 0],
    accents: SIX_EIGHT_ACCENTS,
    description: '6/8 ambling-horse feel with two accented pulses per bar.'
  },
  { id: 'six-eight', name: 'Straight 6/8', meter: '6/8', swing: 0.5, accents: SIX_EIGHT_ACCENTS, description: 'Even 6/8 without lilt.' }
]

export function getGroove(id: string): Groove {
  return GROOVES.find((g) => g.id === id) ?? GROOVES[0]!
}

/** Timing offset for a step, as a fraction of one step's duration. */
export function stepOffset(groove: Groove, step: number): number {
  const inBar = step % STEPS_PER_BAR[groove.meter]
  const swing = inBar % 2 === 1 ? (groove.swing - 0.5) * 2 : 0
  return swing + (groove.offsets?.[inBar] ?? 0)
}

export function stepAccent(groove: Groove, step: number): number {
  return groove.accents[step % groove.accents.length] ?? 1
}

export function stepSeconds(bpm: number): number {
  return 60 / bpm / 4
}

export interface Pattern {
  meter: Meter
  /** STEPS_PER_BAR[meter] × bars (1 or 2). */
  steps: number
  /** Velocity per step: 0 = off, otherwise 0–1. */
  cells: Record<PadId, number[]>
  /** Pitch offset per step in semitones (±PITCH_RANGE); always 0 where the step is off. */
  pitch: Record<PadId, number[]>
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const clampPitch = (semitones: number) => clamp(Math.round(finite(semitones)), -PITCH_RANGE, PITCH_RANGE)

export function emptyPattern(meter: Meter, bars = 1): Pattern {
  const steps = STEPS_PER_BAR[meter] * clamp(Math.round(bars), 1, MAX_BARS)
  const cells = {} as Record<PadId, number[]>
  const pitch = {} as Record<PadId, number[]>
  for (const id of PAD_IDS) {
    cells[id] = new Array<number>(steps).fill(0)
    pitch[id] = new Array<number>(steps).fill(0)
  }
  return { meter, steps, cells, pitch }
}

/** Bars in a pattern (1 or 2). */
export function patternBars(pattern: Pattern): number {
  return clamp(Math.round(pattern.steps / STEPS_PER_BAR[pattern.meter]), 1, MAX_BARS)
}

export function isEmptyPattern(pattern: Pattern): boolean {
  return PAD_IDS.every((pad) => pattern.cells[pad].every((v) => !(v > 0)))
}

/**
 * Sets a step's velocity (clamped to 0–1). Turning a step off also clears its pitch offset.
 * Steps outside the pattern (e.g. a live-recorded step of a bar that was just removed) are ignored.
 */
export function setCell(pattern: Pattern, pad: PadId, step: number, velocity: number): Pattern {
  if (!Number.isInteger(step) || step < 0 || step >= pattern.steps) return pattern
  const v = clamp(finite(velocity), 0, 1)
  const row = pattern.cells[pad].slice()
  row[step] = v
  const next = { ...pattern, cells: { ...pattern.cells, [pad]: row } }
  if (v > 0 || !pattern.pitch[pad][step]) return next
  const pitchRow = pattern.pitch[pad].slice()
  pitchRow[step] = 0
  return { ...next, pitch: { ...pattern.pitch, [pad]: pitchRow } }
}

export function toggleCell(pattern: Pattern, pad: PadId, step: number, velocity = 0.9): Pattern {
  return setCell(pattern, pad, step, pattern.cells[pad][step]! > 0 ? 0 : velocity)
}

/** Sets a step's pitch offset (rounded, clamped to ±PITCH_RANGE). Steps that are off are left alone. */
export function setPitch(pattern: Pattern, pad: PadId, step: number, semitones: number): Pattern {
  if (!(pattern.cells[pad][step]! > 0)) return pattern
  const row = pattern.pitch[pad].slice()
  row[step] = clampPitch(semitones)
  return { ...pattern, pitch: { ...pattern.pitch, [pad]: row } }
}

/**
 * Converts a pattern to another meter and/or length, bar by bar: each bar keeps the steps that
 * fit the new bar length, and bars added at the end repeat the existing ones.
 */
export function reshapePattern(pattern: Pattern, meter: Meter, bars: number): Pattern {
  const out = emptyPattern(meter, bars)
  const oldBars = patternBars(pattern)
  const oldPer = STEPS_PER_BAR[pattern.meter]
  const per = STEPS_PER_BAR[meter]
  const keep = Math.min(per, oldPer)
  for (const pad of PAD_IDS) {
    for (let bar = 0; bar < out.steps / per; bar++) {
      const from = (bar % oldBars) * oldPer
      for (let i = 0; i < keep; i++) {
        out.cells[pad][bar * per + i] = pattern.cells[pad][from + i] ?? 0
        out.pitch[pad][bar * per + i] = pattern.pitch[pad][from + i] ?? 0
      }
    }
  }
  return out
}

/** Changes the pattern length to 1 or 2 bars; lengthening repeats the first bar. */
export function resizePattern(pattern: Pattern, bars: number): Pattern {
  return reshapePattern(pattern, pattern.meter, bars)
}

/**
 * Builds a pattern from compact rows such as `{ kick: 'x...x...' }` ('x' = 0.95, 'o' = 0.6).
 * Rows longer than a bar make a two-bar pattern; `pitch` maps pad → { step: semitones }.
 */
export function patternFromRows(
  meter: Meter,
  rows: Partial<Record<PadId, string>>,
  pitch: Partial<Record<PadId, Record<number, number>>> = {}
): Pattern {
  const longest = Math.max(0, ...Object.values(rows).map((r) => r?.length ?? 0))
  let pattern = emptyPattern(meter, Math.ceil(longest / STEPS_PER_BAR[meter]))
  for (const [pad, row] of Object.entries(rows) as [PadId, string][]) {
    ;[...row].slice(0, pattern.steps).forEach((ch, step) => {
      if (ch === 'x') pattern = setCell(pattern, pad, step, 0.95)
      else if (ch === 'o') pattern = setCell(pattern, pad, step, 0.6)
    })
  }
  for (const [pad, steps] of Object.entries(pitch) as [PadId, Record<number, number>][]) {
    for (const [step, semitones] of Object.entries(steps)) pattern = setPitch(pattern, pad, Number(step), semitones)
  }
  return pattern
}

export interface ScheduledHit {
  pad: PadId
  /** Seconds from the start of the pattern (or of the chain, for `chainHits`). */
  time: number
  velocity: number
  /** Pitch offset in semitones. */
  pitch: number
  /** Step within its own pattern. */
  step: number
}

/** Every hit of one pass through the pattern with groove timing applied. */
export function patternHits(pattern: Pattern, groove: Groove, bpm: number): ScheduledHit[] {
  const dt = stepSeconds(bpm)
  const hits: ScheduledHit[] = []
  for (let step = 0; step < pattern.steps; step++) {
    const time = (step + stepOffset(groove, step)) * dt
    for (const pad of PAD_IDS) {
      const v = pattern.cells[pad][step]!
      if (v > 0) {
        hits.push({ pad, time: Math.max(0, time), velocity: Math.min(1, v * stepAccent(groove, step)), pitch: pattern.pitch[pad][step] ?? 0, step })
      }
    }
  }
  return hits
}

// ---------------------------------------------------------------------------------------------
// Banks and chaining

export const BANK_IDS = ['A', 'B', 'C', 'D'] as const
export type BankId = (typeof BANK_IDS)[number]

/** One pattern bank: a pattern and the groove it plays with. */
export interface Bank {
  pattern: Pattern
  grooveId: string
  /** Preset the bank was loaded from, until it is edited. */
  presetId: string | null
}

export function emptyBank(grooveId: string, bars = 1): Bank {
  const groove = getGroove(grooveId)
  return { pattern: emptyPattern(groove.meter, bars), grooveId: groove.id, presetId: null }
}

/** Non-empty banks in chain order (A→B→C→D). */
export function chainOrder(banks: Record<BankId, Bank>): BankId[] {
  return BANK_IDS.filter((id) => !isEmptyPattern(banks[id].pattern))
}

/** The bank the chain plays after `bank`: the next non-empty one, wrapping (itself if no other has content). */
export function nextInChain(banks: Record<BankId, Bank>, bank: BankId): BankId {
  const i = BANK_IDS.indexOf(bank)
  for (let k = 1; k <= BANK_IDS.length; k++) {
    const id = BANK_IDS[(i + k) % BANK_IDS.length]!
    if (!isEmptyPattern(banks[id].pattern)) return id
  }
  return bank
}

/** Playback position: the bank playing and the step within its pattern. */
export interface Cursor {
  bank: BankId
  step: number
}

export interface PlayOptions {
  chain: boolean
  loop: boolean
  /** Bank selected while playing; it takes over at the next bar line. */
  cue: BankId | null
}

/** Where playback starts: the selected bank, or in chain mode the next non-empty bank when it is empty. */
export function startCursor(banks: Record<BankId, Bank>, bank: BankId, chain: boolean): Cursor {
  return { bank: chain && isEmptyPattern(banks[bank].pattern) ? nextInChain(banks, bank) : bank, step: 0 }
}

/**
 * The step after `cursor`, or null when playback without loop is over. A cued bank starts from
 * its first step at the next bar line. In chain mode a finished pass moves on to the next
 * non-empty bank; without loop the chain stops after its last bank (wrapping past D).
 */
export function nextCursor(cursor: Cursor, banks: Record<BankId, Bank>, { chain, loop, cue }: PlayOptions): Cursor | null {
  const { pattern } = banks[cursor.bank]
  const step = cursor.step + 1
  const barLine = step >= pattern.steps || step % STEPS_PER_BAR[pattern.meter] === 0
  if (cue && cue !== cursor.bank && barLine) return { bank: cue, step: 0 }
  if (step < pattern.steps) return { bank: cursor.bank, step }
  if (chain) {
    const next = nextInChain(banks, cursor.bank)
    if (!loop && BANK_IDS.indexOf(next) <= BANK_IDS.indexOf(cursor.bank)) return null
    return { bank: next, step: 0 }
  }
  return loop ? { bank: cursor.bank, step: 0 } : null
}

export interface ChainPart {
  pattern: Pattern
  groove: Groove
}

/** What playback exports: the whole chain from A when chaining, otherwise just `bank`. */
export function exportParts(banks: Record<BankId, Bank>, bank: BankId, chain: boolean): ChainPart[] {
  const order = chain ? chainOrder(banks) : []
  return (order.length ? order : [bank]).map((id) => ({ pattern: banks[id].pattern, groove: getGroove(banks[id].grooveId) }))
}

/** Passes through `parts` needed for an export of at least `minBars` bars. */
export function exportRepeats(parts: readonly ChainPart[], minBars = 4): number {
  const bars = parts.reduce((n, p) => n + patternBars(p.pattern), 0)
  return bars > 0 ? Math.max(1, Math.ceil(minBars / bars)) : 1
}

/** Hits of `parts` played back to back, `repeats` times, and the total length in seconds. */
export function chainHits(parts: readonly ChainPart[], bpm: number, repeats = 1): { hits: ScheduledHit[]; seconds: number } {
  const dt = stepSeconds(bpm)
  const hits: ScheduledHit[] = []
  let start = 0
  for (let r = 0; r < repeats; r++) {
    for (const part of parts) {
      for (const h of patternHits(part.pattern, part.groove, bpm)) hits.push({ ...h, time: start + h.time })
      start += part.pattern.steps * dt
    }
  }
  return { hits, seconds: start }
}

/**
 * Percussion pads that carry pitch offsets can't stay on the GM drum channel (a different note
 * is a different drum), so they move to a melodic track of their own: the pad's sounding pitch
 * in `audio/beat-kit.ts` plus the offset, with a fitting GM program (0-based).
 */
const TUNED_DRUMS: Partial<Record<PadId, { note: number; program: number }>> = {
  colLegno: { note: 58, program: 115 }, // woodblock, on the female string's B♭3
  bodyTap: { note: 44, program: 115 },
  sub808: { note: 29, program: 38 }, // synth bass
  snare: { note: 54, program: 118 }, // synth drum
  hihat: { note: 62, program: 118 },
  clap: { note: 80, program: 118 },
  kick: { note: 24, program: 118 },
  cymbal: { note: 59, program: 118 },
  shamanDrum: { note: 35, program: 116 }, // taiko
  bells: { note: 81, program: 112 } // tinkle bell
}

/**
 * `parts` played `repeats` times as a MIDI song: fiddle pads on a melodic track with their pitch
 * offsets, percussion on GM channel 10, and every percussion pad that uses pitch offsets on a
 * tuned track of its own. The time signature is the first part's.
 */
export function chainMidi(parts: readonly ChainPart[], bpm: number, repeats = 1): MidiSong {
  const ppq = 96
  const ticksPerStep = ppq / 4
  const dt = stepSeconds(bpm)
  const { hits } = chainHits(parts, bpm, repeats)
  const tuned = PAD_IDS.filter((pad) => PAD_MIDI[pad].track === 'drums' && TUNED_DRUMS[pad] && hits.some((h) => h.pad === pad && h.pitch !== 0))
  const morin: MidiNote[] = []
  const drums: MidiNote[] = []
  const tunedNotes = new Map<PadId, MidiNote[]>(tuned.map((pad) => [pad, []]))
  for (const h of hits) {
    const map = PAD_MIDI[h.pad]
    const tick = Math.round((h.time / dt) * ticksPerStep)
    const velocity = Math.max(1, Math.round(h.velocity * 127))
    const pitched = (note: number) => clamp(note + h.pitch, 0, 127)
    const tunedRow = tunedNotes.get(h.pad)
    if (map.track === 'morin') morin.push({ tick, duration: ticksPerStep, note: pitched(map.note), velocity })
    else if (tunedRow) tunedRow.push({ tick, duration: ticksPerStep, note: pitched(TUNED_DRUMS[h.pad]!.note), velocity })
    else drums.push({ tick, duration: ticksPerStep, note: map.note, velocity })
  }
  // Melodic channels from 1 up, skipping 9 (GM percussion).
  const tunedTracks: MidiTrack[] = tuned.map((pad, i) => ({
    name: `${padInfo(pad).label} (tuned)`,
    channel: i < 8 ? i + 1 : i + 2,
    program: TUNED_DRUMS[pad]!.program,
    notes: tunedNotes.get(pad)!
  }))
  return {
    ppq,
    tempoBpm: bpm,
    timeSignature: parts[0]?.pattern.meter === '6/8' ? [6, 8] : [4, 4],
    tracks: [{ name: 'Morin Khuur', channel: 0, program: 110, notes: morin }, { name: 'Percussion', channel: 9, notes: drums }, ...tunedTracks]
  }
}

// ---------------------------------------------------------------------------------------------
// Presets and persistence

export const PRESET_PATTERNS: readonly { id: string; name: string; groove: string; bpm: number; pattern: Pattern }[] = [
  {
    id: 'joroo-gallop',
    name: 'Joroo Gallop',
    groove: 'joroo',
    bpm: 108,
    pattern: patternFromRows('6/8', {
      bodyTap: 'x.o.o.x.o.o.',
      colLegno: '....x.....x.',
      maleOpen: 'x.....x.....',
      hihat: 'o.o.o.o.o.o.',
      shamanDrum: 'x...........'
    })
  },
  {
    id: 'steppe-hiphop',
    name: 'Steppe Hip-Hop',
    groove: 'gallop',
    bpm: 88,
    pattern: patternFromRows('4/4', {
      kick: 'x......x..x.....',
      snare: '....x.......x...',
      hihat: 'x.o.x.o.x.o.x.oo',
      sub808: 'x.........x.....',
      colLegno: '.......o......o.',
      femaleOpen: 'x...............'
    })
  },
  {
    id: 'folk-metal',
    name: 'Folk-Metal Stomp',
    groove: 'straight',
    bpm: 130,
    pattern: patternFromRows('4/4', {
      kick: 'x.x...x.x.x...x.',
      snare: '....x.......x...',
      bodyTap: 'x...x...x...x...',
      colLegno: '..x...x...x...x.',
      cymbal: 'x...............',
      maleOpen: 'x.......x.......'
    })
  },
  {
    id: 'towoo-trot',
    name: 'Töwöö Trot',
    groove: 'towoo',
    bpm: 96,
    pattern: patternFromRows('4/4', {
      bodyTap: 'x.x.x.x.x.x.x.x.',
      pizzicato: 'x...o...x...o...',
      bells: '..o...o...o...o.',
      shamanDrum: 'x.......x.......'
    })
  },
  {
    // Two bars; the 808 and pizzicato lines use pitch offsets (B♭ minor pentatonic).
    id: 'steppe-trap',
    name: 'Steppe Trap (2 bars)',
    groove: 'straight',
    bpm: 140,
    pattern: patternFromRows(
      '4/4',
      {
        kick: 'x......x..x.....x......x.....x..',
        snare: '........x...............x.......',
        hihat: 'x.x.x.x.x.x.xxx.x.x.x.x.x.xxx.xx',
        sub808: 'x......x..x.....x......x.....x..',
        pizzicato: '..x..x......x.....x..x......x...',
        colLegno: '..............o...............o.'
      },
      {
        sub808: { 10: 3, 16: -2, 23: -2, 29: 5 },
        pizzicato: { 5: 3, 12: 5, 18: 7, 21: 5, 28: 3 }
      }
    )
  }
]

/** Fresh banks: the first preset in A, the others empty with the same groove. */
export function defaultBanks(): Record<BankId, Bank> {
  const first = PRESET_PATTERNS[0]!
  return {
    A: { pattern: first.pattern, grooveId: first.groove, presetId: first.id },
    B: emptyBank(first.groove),
    C: emptyBank(first.groove),
    D: emptyBank(first.groove)
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Repairs a pattern read from storage (v1 had velocity rows only); null when it isn't a pattern. */
export function normalizePattern(raw: unknown): Pattern | null {
  if (!isRecord(raw) || !isRecord(raw.cells)) return null
  const cells = raw.cells
  const meter: Meter = raw.meter === '6/8' ? '6/8' : '4/4'
  // Without a usable step count, the rows' own length tells one bar from two.
  const longest = Math.max(0, ...PAD_IDS.map((pad) => (Array.isArray(cells[pad]) ? (cells[pad] as unknown[]).length : 0)))
  const out = emptyPattern(meter, (finite(raw.steps) || longest) / STEPS_PER_BAR[meter] || 1)
  const pitch = isRecord(raw.pitch) ? raw.pitch : {}
  for (const pad of PAD_IDS) {
    const vRow = cells[pad]
    const pRow = pitch[pad]
    for (let i = 0; i < out.steps; i++) {
      const v = clamp(Array.isArray(vRow) ? finite(vRow[i]) : 0, 0, 1)
      out.cells[pad][i] = v
      out.pitch[pad][i] = v > 0 && Array.isArray(pRow) ? clampPitch(finite(pRow[i])) : 0
    }
  }
  return out
}

function restoreBank(raw: unknown): Bank | null {
  if (!isRecord(raw)) return null
  const pattern = normalizePattern(raw.pattern)
  if (!pattern) return null
  const groove = GROOVES.find((g) => g.id === raw.grooveId) ?? GROOVES.find((g) => g.meter === pattern.meter)!
  return {
    pattern: groove.meter === pattern.meter ? pattern : reshapePattern(pattern, groove.meter, patternBars(pattern)),
    grooveId: groove.id,
    presetId: PRESET_PATTERNS.some((p) => p.id === raw.presetId) ? (raw.presetId as string) : null
  }
}

/**
 * Banks from persisted Beat Maker state of any version, repairing bad data. Version 1 stored a
 * single `pattern` / `grooveId` / `presetId`, which becomes bank A (the others start empty).
 * Returns `fallback` when nothing usable is stored.
 */
export function restoreBanks(persisted: unknown, fallback: { banks: Record<BankId, Bank>; bank: BankId }): { banks: Record<BankId, Bank>; bank: BankId } {
  const s = isRecord(persisted) ? persisted : {}
  const raw = isRecord(s.banks) ? s.banks : 'pattern' in s ? { A: { pattern: s.pattern, grooveId: s.grooveId, presetId: s.presetId } } : null
  if (!raw) return fallback
  const a = restoreBank(raw.A) ?? fallback.banks.A
  const banks = { A: a } as Record<BankId, Bank>
  for (const id of BANK_IDS.slice(1)) banks[id] = restoreBank(raw[id]) ?? emptyBank(a.grooveId)
  const bank = BANK_IDS.find((id) => id === s.bank) ?? 'A'
  return { banks, bank }
}
