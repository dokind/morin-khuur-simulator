import { describe, expect, it } from 'vitest'
import { parseSong, verifySong, type RawSong } from '../notation'
import { analyzeSong, neighbour, pitchContext, reachable } from './phrases'
import { density } from './presets'
import { STAGE_ETUDE, STAGE_ETUDE_MIDI } from './stage-etude.fixture'
import { songClock } from './tempo'



describe('pitch set and neighbours', () => {
  it('keeps pitch classes used at least twice and records the semitones the melody steps by', () => {
    const ctx = pitchContext(STAGE_ETUDE_MIDI)
    expect([...ctx.classes].sort((a, b) => a - b)).toEqual([0, 2, 5, 7, 9, 10]) // E (once) is a passing note
    expect([...ctx.semitoneSteps].sort((a, b) => a - b)).toEqual([4, 9]) // E–F and A–B♭
  })

  it('uses every class when fewer than three recur', () => {
    expect([...pitchContext([60, 62, 67, null, 60]).classes].sort((a, b) => a - b)).toEqual([0, 2, 7])
  })

  it('never picks an unstepped semitone', () => {
    const ctx = pitchContext(STAGE_ETUDE_MIDI)
    expect(neighbour(60, -1, ctx)).toBe(-2) // into C from B♭, never B♮
    expect(neighbour(62, 1, ctx)).toBe(3) // D up to F: E is not in the set
    expect(neighbour(58, -1, ctx)).toBe(-1) // B♭ down to A: the song steps A–B♭
    expect(neighbour(57, 1, ctx)).toBe(1)
    expect(neighbour(57, 1, ctx, { semitone: false })).toBe(3) // A up to C
  })

  it('respects preference order, physical fit and the whole-tone fallback', () => {
    const ctx = pitchContext([53, 55, 58, 60, 62, 53, 55, 58, 60, 62]) // F G B♭ C D
    expect(neighbour(58, 1, ctx, { distances: [4, 3, 2], semitone: false })).toBe(4) // B♭ → D
    expect(neighbour(53, 1, ctx, { distances: [4, 3, 2], semitone: false })).toBe(2) // F → G: no A or A♭
    expect(neighbour(60, -1, ctx, { fits: (o) => reachable(1, o) })).toBeNull() // a stop of 1: nothing below fits
    const far = pitchContext([66, 68, 71, 66, 68, 71]) // nothing a second or third below E
    expect(neighbour(64, -1, far, { fallback: true })).toBe(-2)
    expect(neighbour(64, -1, far)).toBeNull()
  })

  it('keeps ornament notes on the string within one hand frame', () => {
    expect(reachable(0, -1)).toBe(false) // below the nut
    expect(reachable(3, -3)).toBe(true)
    expect(reachable(3, 5)).toBe(false) // beyond the little finger's third
    expect(reachable(23, 2)).toBe(false) // off the modelled string
  })
})

describe('phrase analysis', () => {
  it('finds phrases at the 4-bar lines, the climax, and bars 4–7 as the first repeat of 0–3', () => {
    const song = parseSong(STAGE_ETUDE).song!
    const report = verifySong(song)
    const a = analyzeSong(song, report, songClock(song))
    const bars = a.phrases.map((p) => report.checks[p.first]!.note.time)
    expect(bars).toEqual(['0:0:0', '4:0:0', '8:0:0', '12:0:0'])
    expect(report.checks[a.phrases[a.climax!]!.first]!.note.time).toBe('8:0:0') // the phrase holding the high C4
    const k = (time: string) => a.notes[report.checks.findIndex((c) => c.note.time === time)]!.repeat
    expect(k('0:0:0')).toBe(0)
    expect(k('4:0:0')).toBe(1)
    expect(k('6:1:0')).toBe(1)
    expect(k('8:0:0')).toBe(0)
  })

  it('ends phrases at rests and held notes', () => {
    const raw: RawSong = {
      title: 'Phrases',
      tuning: { maleString: 'F3', femaleString: 'Bb3' },
      tempoBpm: 60,
      timeSignature: '4/4',
      notes: [
        { time: '0:0:0', pitch: 'C4', duration: '4n', string: 'female', technique: 'cuticle_side_stop', finger: 'index', bow: 'tatakh' },
        { time: '0:1:0', pitch: 'D4', duration: '4n', string: 'female', technique: 'cuticle_side_stop', finger: 'middle', bow: 'tülekhe' },
        { time: '0:3:0', pitch: 'C4', duration: '4n', string: 'female', technique: 'cuticle_side_stop', finger: 'index', bow: 'tatakh' },
        { time: '1:0:0', pitch: 'D4', duration: '2n', string: 'female', technique: 'cuticle_side_stop', finger: 'middle', bow: 'tülekhe' },
        { time: '1:2:0', pitch: 'F4', duration: '4n', string: 'female', technique: 'cuticle_side_stop', finger: 'pinky', bow: 'tatakh' },
        { time: '1:3:0', pitch: 'D4', duration: '4n', string: 'female', technique: 'cuticle_side_stop', finger: 'middle', bow: 'tülekhe' }
      ]
    }
    const song = parseSong(raw).song!
    const report = verifySong(song)
    const a = analyzeSong(song, report, songClock(song))
    expect(a.notes.map((n) => n.phraseEnd)).toEqual([false, true, false, true, false, true]) // rest, held half note, last note
    expect(a.notes.map((n) => n.phraseStart)).toEqual([true, false, true, false, true, false])
    expect(a.notes[3]!.long && a.notes[3]!.strongBeat).toBe(true)
    expect(a.notes.map((n) => n.leap)).toEqual([0, 2, -2, 2, 3, -3])
  })
})

describe('ornament density', () => {
  it('grows with repetition in long song and Inner Mongolian style and stays constant on stage', () => {
    for (const style of ['urtiin-duu', 'inner-mongolian'] as const) {
      const r = [0, 1, 2, 5].map((k) => density(style, 'aizam', 1, k))
      expect(r[0]).toBeLessThan(r[1]!)
      expect(r[1]).toBeLessThan(r[2]!)
      expect(r[2]).toBe(r[3])
    }
    expect(new Set([0, 1, 2, 3].map((k) => density('khalkh-stage', 'aizam', 1, k))).size).toBe(1)
    expect(new Set([0, 1, 2].map((k) => density('bii-ikel', 'aizam', 1, k))).size).toBe(1)
  })

  it('orders long-song sub-genres aizam > suman > besreg and scales with the amount', () => {
    expect(density('urtiin-duu', 'aizam', 1, 1)).toBeGreaterThan(density('urtiin-duu', 'suman', 1, 1))
    expect(density('urtiin-duu', 'suman', 1, 1)).toBeGreaterThan(density('urtiin-duu', 'besreg', 1, 1))
    expect(density('tatlaga', 'aizam', 2, 0)).toBeCloseTo(2 * density('tatlaga', 'aizam', 1, 0))
    expect(density('inner-mongolian', 'aizam', 0, 2)).toBe(0)
  })
})
