/** Minimal Standard MIDI File (format 1) writer for pattern and song export. */

export interface MidiNote {
  tick: number
  duration: number
  note: number
  /** 1–127 */
  velocity: number
}

export interface MidiTrack {
  name: string
  /** 0–15 (9 = General MIDI percussion). */
  channel: number
  /** General MIDI program (0-based), omitted for percussion. */
  program?: number
  notes: MidiNote[]
}

export interface MidiSong {
  ppq: number
  tempoBpm: number
  /** Time signature numerator/denominator. */
  timeSignature?: [number, number]
  tracks: MidiTrack[]
}

function varLen(value: number): number[] {
  let v = Math.max(0, Math.round(value))
  const bytes = [v & 0x7f]
  while ((v >>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80)
  return bytes
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const u16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0) & 0x7f)

function chunk(type: string, data: number[]): number[] {
  return [...ascii(type), ...u32(data.length), ...data]
}

interface TrackEvent {
  tick: number
  /** Tie-break at equal ticks: meta (0) before note-off (1) before note-on (2). */
  order: number
  bytes: number[]
}

function trackChunk(events: TrackEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const data: number[] = []
  let last = 0
  for (const e of events) {
    data.push(...varLen(e.tick - last), ...e.bytes)
    last = e.tick
  }
  data.push(0x00, 0xff, 0x2f, 0x00) // end of track
  return chunk('MTrk', data)
}

export function encodeMidi(song: MidiSong): Uint8Array {
  const [num, den] = song.timeSignature ?? [4, 4]
  const tempo = Math.round(60_000_000 / song.tempoBpm)
  const conductor = trackChunk([
    { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] },
    { tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, num, Math.log2(den), 24, 8] }
  ])

  const tracks = song.tracks.map((t) => {
    const name = ascii(t.name)
    const events: TrackEvent[] = [{ tick: 0, order: 0, bytes: [0xff, 0x03, ...varLen(name.length), ...name] }]
    if (t.program !== undefined) events.push({ tick: 0, order: 0, bytes: [0xc0 | t.channel, t.program & 0x7f] })
    for (const n of t.notes) {
      const tick = Math.round(n.tick)
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity)))
      events.push({ tick, order: 2, bytes: [0x90 | t.channel, n.note & 0x7f, vel] })
      events.push({ tick: tick + Math.max(1, Math.round(n.duration)), order: 1, bytes: [0x80 | t.channel, n.note & 0x7f, 0] })
    }
    return trackChunk(events)
  })

  const header = chunk('MThd', [...u16(1), ...u16(tracks.length + 1), ...u16(song.ppq)])
  return new Uint8Array([...header, ...conductor, ...tracks.flat()])
}
