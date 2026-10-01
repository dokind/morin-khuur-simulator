/**
 * Song time in seconds, honouring the song's `tempoMap` (a written ritardando or a faster second
 * section). The map is tempo notation, so it applies in every style including 'as-written';
 * `NotePerformance.timeOffset` and `durationScale` are relative to this clock.
 */

import { beatsToSeconds, type Song } from '../notation'

export interface SongClock {
  /** Seconds from the start of the song to a position in quarter beats. */
  seconds(beats: number): number
  /** Quarter-note tempo at a position, bpm. */
  bpmAt(beats: number): number
}

interface Segment {
  b0: number
  /** End in beats (Infinity for the last segment). */
  b1: number
  /** Tempo at b0 and b1; it changes linearly per beat in between. */
  t0: number
  t1: number
  /** Seconds at b0. */
  s0: number
}

const EPS = 1e-9

const tempoIn = (g: Segment, beats: number): number =>
  g.t1 === g.t0 || !Number.isFinite(g.b1) ? g.t0 : g.t0 + ((g.t1 - g.t0) * (beats - g.b0)) / (g.b1 - g.b0)

/** Seconds from g.b0 to `beats` inside the segment: ∫ 60 / tempo(b) db. */
function secondsIn(g: Segment, beats: number): number {
  const dx = beats - g.b0
  if (Math.abs(g.t1 - g.t0) < EPS || !Number.isFinite(g.b1) || dx <= 0) return (60 * dx) / g.t0
  const k = (g.t1 - g.t0) / (g.b1 - g.b0)
  return (60 / k) * Math.log((g.t0 + k * dx) / g.t0)
}

/**
 * Clock for a song played at `bpm` (the Song Tester's tempo). Every tempo in the map is scaled by
 * bpm / song.tempoBpm, so a slower practice tempo slows the whole map. Without a map this is
 * exactly `beatsToSeconds(beats, bpm)`.
 */
export function songClock(song: Song, bpm: number = song.tempoBpm): SongClock {
  const map = song.tempoMap ?? []
  if (map.length === 0) return { seconds: (beats) => beatsToSeconds(beats, bpm), bpmAt: () => bpm }

  const scale = bpm / song.tempoBpm
  const segments: Segment[] = []
  let b = 0
  let t = song.tempoBpm * scale
  let s = 0
  const close = (b1: number, t1: number) => {
    const g: Segment = { b0: b, b1, t0: t, t1, s0: s }
    segments.push(g)
    s += secondsIn(g, b1)
    b = b1
    t = t1
  }
  for (const p of map) {
    const target = p.bpm * scale
    if (p.beats <= b + EPS) t = target // a change at the current point (or a ramp of zero length) is a jump
    else if (p.ramp) close(p.beats, target)
    else {
      close(p.beats, t)
      t = target
    }
  }
  segments.push({ b0: b, b1: Infinity, t0: t, t1: t, s0: s })

  const find = (beats: number): Segment => {
    for (let i = segments.length - 1; i > 0; i--) if (beats >= segments[i]!.b0) return segments[i]!
    return segments[0]!
  }
  return {
    seconds: (beats) => {
      const g = find(beats)
      return g.s0 + secondsIn(g, beats)
    },
    bpmAt: (beats) => tempoIn(find(beats), Math.max(beats, 0))
  }
}
