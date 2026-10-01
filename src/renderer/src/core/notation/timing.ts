/**
 * Musical time for `.mkhuur.json`, using Tone.js conventions so songs schedule directly on the
 * Transport: positions are "bars:beats:sixteenths" where a beat is a QUARTER note (so a 6/8 bar
 * holds 3 beats), durations are "4n", "8n.", "8t", "2m", and `tempoBpm` counts quarter notes.
 * Everything is converted to quarter-note "beats".
 */

export interface TimeSignature {
  beats: number
  unit: number
}

export function parseTimeSignature(value: string): TimeSignature | null {
  const m = /^(\d{1,2})\/(1|2|4|8|16)$/.exec(value.trim())
  if (!m) return null
  const beats = Number(m[1])
  return beats > 0 ? { beats, unit: Number(m[2]) } : null
}

export function quartersPerBar(ts: TimeSignature): number {
  return (ts.beats * 4) / ts.unit
}

const POSITION_RE = /^(\d+):(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/

/** "bars:beats:sixteenths" → quarter-note beats from the start of the song. */
export function parsePosition(value: string, ts: TimeSignature): number | null {
  const m = POSITION_RE.exec(value.trim())
  if (!m) return null
  const bars = Number(m[1])
  const beats = Number(m[2])
  const sixteenths = m[3] === undefined ? 0 : Number(m[3])
  return bars * quartersPerBar(ts) + beats + sixteenths / 4
}

/** Inverse of parsePosition, used when writing songs (e.g. recorded takes). */
export function formatPosition(quarterBeats: number, ts: TimeSignature): string {
  const perBar = quartersPerBar(ts)
  const bars = Math.floor(quarterBeats / perBar + 1e-9)
  const rest = quarterBeats - bars * perBar
  const beats = Math.floor(rest + 1e-9)
  const sixteenths = Math.round((rest - beats) * 4 * 1000) / 1000
  return `${bars}:${beats}:${sixteenths}`
}

const DURATION_RE = /^(\d+)(n|t|m)(\.)?$/

/** "4n" | "8n." | "8t" | "1m" → quarter-note beats. */
export function parseDuration(value: string, ts: TimeSignature): number | null {
  const m = DURATION_RE.exec(value.trim())
  if (!m) return null
  const d = Number(m[1])
  if (d <= 0) return null
  let beats: number
  if (m[2] === 'm') beats = d * quartersPerBar(ts)
  else {
    beats = 4 / d
    if (m[2] === 't') beats *= 2 / 3
  }
  return m[3] ? beats * 1.5 : beats
}

export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm
}
