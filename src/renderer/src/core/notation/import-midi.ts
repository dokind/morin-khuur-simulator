/** Standard MIDI File (format 0/1) reader and MIDI → melody extraction for song import. */

import type { MelodyInput } from './melody'
import type { TimeSignature } from './timing'

export interface MidiFileNote {
  tick: number
  durationTicks: number
  /** Quarter-note beats (tick / PPQ). */
  startBeats: number
  durationBeats: number
  midi: number
  /** 1–127. */
  velocity: number
  /** 0–15 (9 = General MIDI percussion). */
  channel: number
}

export interface MidiFileTrack {
  name: string
  notes: MidiFileNote[]
}

export interface MidiFile {
  format: number
  /** Ticks per quarter note (derived for SMPTE timing). */
  ppq: number
  /** Earliest tempo in the file, or null when it has none (players assume 120). */
  tempoBpm: number | null
  /** Distinct tempos in time order, counting the first (1 = constant tempo; repeats are not counted). */
  tempoChanges: number
  /** Earliest time signature in the file. */
  timeSignature: TimeSignature | null
  /** Distinct time signatures in time order, counting the first. */
  timeSignatureChanges: number
  /** Every time-signature event, in time order. */
  timeSignatureEvents: { tick: number; value: TimeSignature }[]
  /** Key signature sharps (+) / flats (−) from the earliest key-signature event. */
  keyFifths: number | null
  tracks: MidiFileTrack[]
}

export interface MidiImportOptions {
  /** Track index to take the melody from (default: the busiest non-percussion track/channel). */
  track?: number
  /** Channel within the track (default: its busiest non-percussion channel). */
  channel?: number
  /** Overrides the title stored in the file. */
  title?: string
}

const PERCUSSION = 9

class Reader {
  pos: number
  constructor(
    readonly bytes: Uint8Array,
    start = 0,
    readonly end = bytes.length
  ) {
    this.pos = start
  }
  get done() {
    return this.pos >= this.end
  }
  u8(): number {
    if (this.pos >= this.end) throw new Error('Unexpected end of MIDI data.')
    return this.bytes[this.pos++]!
  }
  u16() {
    return (this.u8() << 8) | this.u8()
  }
  u32() {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0
  }
  varLen(): number {
    let value = 0
    for (let i = 0; i < 4; i++) {
      const b = this.u8()
      value = (value << 7) | (b & 0x7f)
      if (!(b & 0x80)) return value
    }
    throw new Error('Malformed variable-length value in MIDI data.')
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.end) throw new Error('Unexpected end of MIDI data.')
    const out = this.bytes.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  ascii(n: number) {
    return String.fromCharCode(...this.take(n))
  }
}

/** Meta text is usually ASCII/UTF-8; older files often use Latin-1. */
function decodeText(bytes: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Latin-1 maps each byte to the code point of the same value. Built in slices: spreading a
    // long meta event into one fromCharCode call would overflow the call stack.
    text = ''
    for (let i = 0; i < bytes.length; i += 4096) text += String.fromCharCode(...bytes.subarray(i, i + 4096))
  }
  return text.replace(/\0+$/, '').trim()
}

/** Data bytes after a system common / real-time status (0xF1–0xFE, never valid in a file but seen in the wild). */
const SYSTEM_DATA_BYTES: Record<number, number> = { 0xf1: 1, 0xf2: 2, 0xf3: 1 }

/** Earliest value (stable for equal ticks) and the number of distinct values in time order. */
function timeline<T>(events: { tick: number; value: T }[], same: (a: T, b: T) => boolean): { first: T | null; distinct: number } {
  const sorted = [...events].sort((a, b) => a.tick - b.tick)
  let distinct = 0
  sorted.forEach((e, i) => {
    if (i === 0 || !same(sorted[i - 1]!.value, e.value)) distinct++
  })
  return { first: sorted[0]?.value ?? null, distinct }
}

function findHeader(bytes: Uint8Array): number {
  // Plain SMF starts with MThd; RIFF-wrapped (.rmi) files carry it a few bytes in.
  for (let i = 0; i + 4 <= Math.min(bytes.length, 256); i++) {
    if (bytes[i] === 0x4d && bytes[i + 1] === 0x54 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) return i
  }
  throw new Error('Not a Standard MIDI File (no MThd header).')
}

/** Parses a Standard MIDI File. Throws on data that is not MIDI at all; tolerates truncated tracks. */
export function parseMidi(bytes: Uint8Array): MidiFile {
  const r = new Reader(bytes, findHeader(bytes))
  r.ascii(4)
  const headerLength = r.u32()
  const headerEnd = r.pos + headerLength
  const format = r.u16()
  r.u16() // track count: every MTrk chunk is read instead, since some writers get it wrong
  const division = r.u16()
  r.pos = Math.max(r.pos, Math.min(r.end, headerEnd))
  if (format > 2) throw new Error(`Unsupported MIDI format ${format}.`)

  const tempos: { tick: number; value: number }[] = []
  const meters: { tick: number; value: TimeSignature }[] = []
  const keys: { tick: number; value: number }[] = []
  const tracks: MidiFileTrack[] = []

  // SMPTE division: ticks per second; converted to beats at the file tempo below.
  const smpte = (division & 0x8000) !== 0
  const ticksPerSecond = smpte ? (256 - (division >> 8)) * (division & 0xff) : 0

  while (!r.done) {
    if (r.end - r.pos < 8) break
    const type = r.ascii(4)
    const length = r.u32()
    const end = Math.min(r.end, r.pos + length)
    if (type !== 'MTrk') {
      r.pos = end
      continue
    }
    const t = new Reader(bytes, r.pos, end)
    r.pos = end

    let name = ''
    let tick = 0
    let status = 0
    const open = new Map<number, { tick: number; velocity: number }[]>()
    const notes: Omit<MidiFileNote, 'startBeats' | 'durationBeats'>[] = []
    const noteOff = (channel: number, midi: number) => {
      const queue = open.get(channel * 128 + midi)
      const on = queue?.shift()
      if (on) notes.push({ tick: on.tick, durationTicks: tick - on.tick, midi, velocity: on.velocity, channel })
    }

    try {
      while (!t.done) {
        tick += t.varLen()
        let byte = t.u8()
        if (byte === 0xff) {
          const metaType = t.u8()
          const data = t.take(t.varLen())
          if (metaType === 0x2f) break
          if (metaType === 0x03 && !name) name = decodeText(data)
          else if (metaType === 0x51 && data.length >= 3) {
            const microsPerQuarter = (data[0]! << 16) | (data[1]! << 8) | data[2]!
            if (microsPerQuarter > 0) tempos.push({ tick, value: microsPerQuarter })
          } else if (metaType === 0x58 && data.length >= 2 && data[0]! > 0 && data[1]! <= 6) {
            meters.push({ tick, value: { beats: data[0]!, unit: 2 ** data[1]! } })
          } else if (metaType === 0x59 && data.length >= 1) {
            keys.push({ tick, value: data[0]! > 127 ? data[0]! - 256 : data[0]! })
          }
          continue
        }
        if (byte === 0xf0 || byte === 0xf7) {
          t.take(t.varLen())
          continue
        }
        if (byte > 0xf0) {
          // Stray system common / real-time message: skip its data, keep the running status.
          t.take(SYSTEM_DATA_BYTES[byte] ?? 0)
          continue
        }
        // Meta and sysex events leave running status alone (lenient: some writers rely on it).
        if (byte & 0x80) status = byte
        else {
          if (!status) throw new Error('Running status without a previous status byte.')
          t.pos-- // data byte: reuse the running status
          byte = status
        }
        const kind = byte & 0xf0
        const channel = byte & 0x0f
        if (kind === 0xc0 || kind === 0xd0) {
          t.u8()
          continue
        }
        // Data bytes are 7-bit; masking keeps a corrupt byte from spilling into the channel/key index.
        const a = t.u8() & 0x7f
        const b = t.u8() & 0x7f
        if (kind === 0x90 && b > 0) {
          const key = channel * 128 + a
          const queue = open.get(key) ?? []
          queue.push({ tick, velocity: b })
          open.set(key, queue)
        } else if (kind === 0x80 || kind === 0x90) noteOff(channel, a)
      }
    } catch {
      // Truncated track: keep what was read.
    }
    // Notes never released end at the end of the track.
    for (const [key, queue] of open) for (let i = queue.length; i > 0; i--) noteOff(Math.floor(key / 128), key % 128)

    notes.sort((x, y) => x.tick - y.tick || x.midi - y.midi)
    tracks.push({ name, notes: notes as MidiFileNote[] })
  }

  const tempo = timeline(tempos, (a, b) => a === b)
  const meter = timeline(meters, (a, b) => a.beats === b.beats && a.unit === b.unit)
  const tempoBpm = tempo.first === null ? null : 60_000_000 / tempo.first
  // A zero SMPTE resolution or PPQ is corrupt; fall back to a common resolution rather than NaN beats.
  const ppq = smpte && ticksPerSecond > 0 ? (ticksPerSecond * 60) / (tempoBpm ?? 120) : !smpte && division > 0 ? division : 480
  for (const track of tracks) {
    for (const note of track.notes) {
      note.startBeats = note.tick / ppq
      note.durationBeats = note.durationTicks / ppq
    }
  }

  return {
    format,
    ppq,
    tempoBpm,
    tempoChanges: tempo.distinct,
    timeSignature: meter.first,
    timeSignatureChanges: meter.distinct,
    timeSignatureEvents: [...meters].sort((a, b) => a.tick - b.tick),
    keyFifths: timeline(keys, (a, b) => a === b).first,
    tracks
  }
}

const sameMeter = (a: TimeSignature, b: TimeSignature) => a.beats === b.beats && a.unit === b.unit

/**
 * The meter to write the song in: the time signature in force for most of the piece. Notation
 * programs export a pickup as a bar in its own short signature (1/4 before 3/4); such an opening bar
 * is left out of the choice, and `pickupBeats` says how far to delay the notes so the bar lines
 * after it fall on whole bars.
 */
function songMeter(file: MidiFile): { meter: TimeSignature | null; pickup: TimeSignature | null; pickupBeats: number } {
  const events = file.timeSignatureEvents
  if (!events.length) return { meter: null, pickup: null, pickupBeats: 0 }
  let end = 0
  for (const track of file.tracks) for (const n of track.notes) end = Math.max(end, n.tick + n.durationTicks)
  // Until the first event MIDI assumes 4/4.
  const changes = events[0]!.tick > 0 ? [{ tick: 0, value: { beats: 4, unit: 4 } }, ...events] : events
  const spans: { value: TimeSignature; ticks: number }[] = []
  for (const [i, e] of changes.entries()) {
    // Only the part up to the last note counts.
    const ticks = Math.min(changes[i + 1]?.tick ?? end, end) - e.tick
    if (ticks <= 0) continue
    const last = spans[spans.length - 1]
    if (last && sameMeter(last.value, e.value)) last.ticks += ticks
    else spans.push({ value: e.value, ticks })
  }
  if (!spans.length) return { meter: file.timeSignature, pickup: null, pickupBeats: 0 }

  const barTicks = (ts: TimeSignature) => ((ts.beats * 4) / ts.unit) * file.ppq
  const [first, second] = spans
  // A pickup: one bar of its own signature, shorter than a bar of the signature that follows.
  const pickup = second && Math.abs(first!.ticks - barTicks(first!.value)) <= 1 && first!.ticks < barTicks(second.value) - 1 ? first! : null
  const totals: { value: TimeSignature; ticks: number }[] = []
  for (const span of pickup ? spans.slice(1) : spans) {
    const total = totals.find((t) => sameMeter(t.value, span.value))
    if (total) total.ticks += span.ticks
    else totals.push({ ...span })
  }
  const meter = totals.reduce((best, t) => (t.ticks > best.ticks ? t : best)).value
  // Aligned only when the pickup leads into the chosen meter.
  if (!pickup || !sameMeter(second!.value, meter)) return { meter, pickup: null, pickupBeats: 0 }
  return { meter, pickup: pickup.value, pickupBeats: (barTicks(meter) - pickup.ticks) / file.ppq }
}

/** Notes per (track, channel), busiest first, percussion excluded. */
export function midiMelodyCandidates(file: MidiFile): { track: number; channel: number; name: string; notes: number }[] {
  const out: { track: number; channel: number; name: string; notes: number }[] = []
  file.tracks.forEach((track, index) => {
    const counts = new Map<number, number>()
    for (const n of track.notes) if (n.channel !== PERCUSSION) counts.set(n.channel, (counts.get(n.channel) ?? 0) + 1)
    for (const [channel, notes] of counts) out.push({ track: index, channel, name: track.name, notes })
  })
  return out.sort((a, b) => b.notes - a.notes || a.track - b.track || a.channel - b.channel)
}

/** Extracts one track/channel of a MIDI file as a melody for arrangeMelody. */
export function midiToMelody(bytes: Uint8Array, options: MidiImportOptions = {}): MelodyInput {
  const file = parseMidi(bytes)
  if (options.track !== undefined && !file.tracks[options.track]) throw new Error(`The MIDI file has no track ${options.track}.`)
  const messages: string[] = []
  const candidates = midiMelodyCandidates(file).filter(
    (c) => (options.track === undefined || c.track === options.track) && (options.channel === undefined || c.channel === options.channel)
  )
  const chosen = candidates[0]
  const notes = chosen ? file.tracks[chosen.track]!.notes.filter((n) => n.channel === chosen.channel) : []
  if (chosen) {
    const others = midiMelodyCandidates(file).length - 1
    const label = chosen.name ? `"${chosen.name}"` : `#${chosen.track + 1}`
    messages.push(`Took the melody from track ${label}, channel ${chosen.channel + 1}${others > 0 ? ` (ignored ${others} other part${others === 1 ? '' : 's'})` : ''}.`)
  } else {
    const where = options.track !== undefined || options.channel !== undefined ? ' in the chosen track/channel' : ''
    messages.push(`Found no pitched (non-percussion) notes${where}.`)
  }
  if (file.tempoChanges > 1) messages.push(`The file changes tempo ${file.tempoChanges - 1} time(s); only the first tempo is kept.`)
  const { meter, pickup, pickupBeats } = songMeter(file)
  const shown = (ts: TimeSignature) => `${ts.beats}/${ts.unit}`
  if (pickup && meter) messages.push(`Read the opening ${shown(pickup)} bar as a pickup (anacrusis) to ${shown(meter)} and aligned it so bar lines fall in place.`)
  const meterChanges = file.timeSignatureChanges - 1 - (pickup ? 1 : 0)
  if (meterChanges > 0 && meter) {
    messages.push(`The file changes time signature ${meterChanges} time(s)${pickup ? ' after the pickup' : ''}; kept ${shown(meter)}, which covers most of the piece (note timing is unaffected).`)
  }

  const fileTitle = file.format === 0 || !file.tracks[0]?.notes.length ? file.tracks[0]?.name : ''
  return {
    title: options.title ?? fileTitle ?? '',
    tempoBpm: file.tempoBpm ?? 120,
    timeSignature: meter ?? { beats: 4, unit: 4 },
    keyPc: file.keyFifths === null ? null : (((file.keyFifths * 7) % 12) + 12) % 12,
    notes: notes.map((n) => ({ startBeats: n.startBeats + pickupBeats, durationBeats: n.durationBeats, midi: n.midi, velocity: Math.min(1, n.velocity / 127), slur: false })),
    messages
  }
}
