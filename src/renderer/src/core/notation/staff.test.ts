import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jianpuMeasures } from './jianpu'
import { parseSong } from './parse'
import { staffKey, staffLine, staffMeasures, staffPitch, staffRange, type StaffItem, type StaffMeasure, type StaffNoteItem } from './staff'
import { parseTimeSignature, quartersPerBar } from './timing'
import type { RawSong, RawSongNote, Song, SongNote } from './types'

const TPQ = 48
const TICKS: Record<string, number> = { w: 192, h: 96, q: 48, '8': 24, '16': 12, '32': 6, '64': 3 }
/** Written length of an item in 48ths of a quarter note, recomputed from its notation alone. */
const written = (i: StaffItem) => TICKS[i.duration]! * (2 - 2 ** -i.dots) * (i.triplet ? 2 / 3 : 1)

const code = (i: StaffItem) => `${i.duration}${'.'.repeat(i.dots)}${i.triplet ? 't' : ''}`
/** Compact view of a measure: "q bb/3", "8. c/4(n)~" (tied), "hr" (rest). */
const show = (m: StaffMeasure) =>
  m.items.map((i) => (i.kind === 'rest' ? `${code(i)}r` : `${code(i)} ${i.key}${i.accidental ? `(${i.accidental})` : ''}${i.tie ? '~' : ''}`))
const layout = (song: Song) => staffMeasures(song).map(show)
const noteItems = (measures: StaffMeasure[]) => measures.flatMap((m) => m.items).filter((i): i is StaffNoteItem => i.kind === 'note')
/** Note indexes in staff order, each run of tied pieces counted once. */
const order = (measures: StaffMeasure[]) => noteItems(measures).flatMap((i, k, all) => (k > 0 && all[k - 1]!.tie ? [] : [i.noteIndex]))

const n = (time: string, pitch: string | null, duration: string, extra: Partial<RawSongNote> = {}): RawSongNote => ({
  time,
  pitch,
  duration,
  string: pitch === null ? null : 'male',
  technique: pitch === null ? 'body_tap' : 'open',
  finger: null,
  bow: null,
  ...extra
})

const build = (notes: RawSongNote[], extra: Partial<RawSong> = {}): Song => {
  const raw: RawSong = { title: 'Test', tuning: { maleString: 'F3', femaleString: 'Bb3' }, tempoBpm: 90, timeSignature: '4/4', key: 'Bb', notes, ...extra }
  const { song, issues } = parseSong(raw)
  expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  return song!
}

/** Invariants every layout must satisfy. */
function expectConsistent(song: Song, measures: StaffMeasure[]) {
  const barTicks = Math.round(quartersPerBar(song.timeSignature) * TPQ)
  expect(measures.length).toBeGreaterThan(0)
  measures.forEach((m, index) => {
    expect(m.index).toBe(index)
    expect(m.beats).toBe(quartersPerBar(song.timeSignature))
    expect(m.startBeats).toBeCloseTo(index * m.beats, 9)
    let t = index * barTicks
    for (const item of m.items) {
      // A measure rest is written as a whole rest in every meter and lasts the bar.
      const measureRest = item.kind === 'rest' && item.measureRest
      if (measureRest) expect(code(item)).toBe('w')
      const length = measureRest ? barTicks : written(item)
      expect(Number.isInteger(length)).toBe(true)
      expect(item.dots).toBeLessThanOrEqual(2)
      if (item.triplet) expect(item.dots).toBe(0)
      expect(Math.round(item.beats * TPQ)).toBe(length)
      expect(item.beats).toBeCloseTo(length / TPQ, 9)
      expect(Math.round(item.startBeats * TPQ)).toBe(t)
      t += length
    }
    expect(t).toBe((index + 1) * barTicks)
    const total = m.items.reduce((sum, i) => sum + i.beats, 0)
    expect(total).toBeCloseTo(m.beats, 9)
    if (m.items.some((i) => i.kind === 'rest' && i.measureRest)) expect(m.items).toHaveLength(1)
  })
  // A tie always leads straight into the next piece of the same note.
  const flat = measures.flatMap((m) => m.items)
  flat.forEach((item, k) => {
    if (item.kind !== 'note') return
    if (item.tie) {
      const next = flat[k + 1]
      expect(next?.kind).toBe('note')
      expect((next as StaffNoteItem).noteIndex).toBe(item.noteIndex)
      expect((next as StaffNoteItem).key).toBe(item.key)
      expect((next as StaffNoteItem).accidental).toBeNull()
    }
    expect(item.percussion).toBe(item.key === 'b/4' && song.notes.find((s) => s.index === item.noteIndex)!.pitch === null)
  })
}

describe('staffKey', () => {
  it('uses the song key as a major key signature', () => {
    expect(staffKey(build([], { key: 'Bb' }))).toEqual({ name: 'Bb', tonicPc: 10, fifths: -2 })
    expect(staffKey(build([], { key: 'D' }))).toEqual({ name: 'D', tonicPc: 2, fifths: 2 })
    expect(staffKey(build([], { key: 'F#' }))).toEqual({ name: 'Gb', tonicPc: 6, fifths: -6 })
    expect(staffKey(build([], { key: 'C' }))).toMatchObject({ name: 'C', fifths: 0 })
  })

  it('derives the key from the tuning when the song names none, like the jianpu view', () => {
    expect(staffKey(build([], { key: undefined }))).toEqual({ name: 'F', tonicPc: 5, fifths: -1 })
    expect(staffKey(build([], { key: undefined, tuning: { maleString: 'G3', femaleString: 'C4' } }))).toMatchObject({ name: 'G', fifths: 1 })
  })
})

describe('staffPitch', () => {
  const key = (name: string) => staffKey(build([], { key: name }))

  it('spells scale notes with the key and octave of the written letter', () => {
    expect(staffPitch(70, key('Bb'))).toBe('bb/4')
    expect(staffPitch(53, key('Bb'))).toBe('f/3')
    expect(staffPitch(63, key('Bb'))).toBe('eb/4')
    expect(staffPitch(66, key('D'))).toBe('f#/4')
    // C♭5 sounds as B4 but is written on the C line of octave 5.
    expect(staffPitch(71, key('Gb'))).toBe('cb/5')
    expect(staffPitch(63, key('B'))).toBe('d#/4')
  })

  it('writes other notes with flats in flat keys and C, sharps in sharp keys', () => {
    expect(staffPitch(61, key('C'))).toBe('db/4')
    expect(staffPitch(66, key('Bb'))).toBe('gb/4')
    expect(staffPitch(71, key('Bb'))).toBe('b/4')
    expect(staffPitch(70, key('D'))).toBe('a#/4')
    expect(staffPitch(65, key('G'))).toBe('f/4')
    expect(staffPitch(65, key('B'))).toBe('f/4')
  })
})

describe('staffLine and staffRange', () => {
  it('counts treble-staff lines as VexFlow does, ledger lines included', () => {
    expect(staffLine('e/4')).toBe(1)
    expect(staffLine('f/5')).toBe(5)
    expect(staffLine('b/4')).toBe(3)
    expect(staffLine('c/4')).toBe(0)
    expect(staffLine('c#/4')).toBe(0)
    expect(staffLine('f/3')).toBe(-2)
    expect(staffLine('c/3')).toBe(-3.5)
    expect(staffLine('g/6')).toBe(9)
    expect(staffLine('bb/6')).toBe(10)
  })

  it('finds the highest and lowest noteheads, from a B♭6 harmonic down to a C3 open string', () => {
    const high = build([n('0:0:0', 'F3', '4n'), n('0:1:0', 'Bb6', '4n', { string: 'female', technique: 'tsatsal_harmonic' }), n('1:0:0', null, '4n')])
    const measures = staffMeasures(high)
    expect(staffRange(measures)).toEqual({ highest: 10, lowest: -2 })
    // Percussion sits on the middle line; a bar of rests has no range.
    expect(staffRange(measures.slice(1))).toEqual({ highest: 3, lowest: 3 })
    expect(staffRange(staffMeasures(build([])))).toBeNull()
    const folk = build([n('0:0:0', 'C3', '4n'), n('0:1:0', 'D3', '4n'), n('0:2:0', 'G3', '4n', { string: 'female' })], {
      tuning: { maleString: 'C3', femaleString: 'G3' },
      key: 'C'
    })
    expect(staffRange(staffMeasures(folk))).toEqual({ highest: -1.5, lowest: -3.5 })
  })
})

describe('staffMeasures in 4/4', () => {
  it('writes a B♭-major scale without accidentals', () => {
    const song = build(['F3', 'G3', 'A3', 'Bb3', 'C4', 'D4', 'Eb4', 'F4'].map((p, i) => n(`${Math.floor(i / 4)}:${i % 4}:0`, p, '4n')))
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([
      ['q f/3', 'q g/3', 'q a/3', 'q bb/3'],
      ['q c/4', 'q d/4', 'q eb/4', 'q f/4']
    ])
    expect(noteItems(measures).map((i) => i.noteIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expectConsistent(song, measures)
  })

  it('keeps accidentals until the bar line, per octave, and restates them in the next bar', () => {
    const song = build([
      n('0:0:0', 'B3', '4n'),
      n('0:1:0', 'B3', '4n'),
      n('0:2:0', 'B4', '4n'),
      n('0:3:0', 'Bb3', '4n'),
      n('1:0:0', 'B3', '4n'),
      n('1:1:0', 'E4', '4n'),
      n('1:2:0', 'F#4', '4n'),
      n('1:3:0', 'Gb4', '4n')
    ])
    expect(layout(song)).toEqual([
      ['q b/3(n)', 'q b/3', 'q b/4(n)', 'q bb/3(b)'],
      ['q b/3(n)', 'q e/4(n)', 'q gb/4(b)', 'q gb/4']
    ])
  })

  it('spells with sharps in sharp keys', () => {
    const song = build([n('0:0:0', 'F#4', '4n'), n('0:1:0', 'F4', '4n'), n('0:2:0', 'Bb3', '4n'), n('0:3:0', 'A#3', '4n')], { key: 'G' })
    expect(layout(song)).toEqual([['q f#/4', 'q f/4(n)', 'q a#/3(#)', 'q a#/3']])
  })

  it('writes dotted values and splits off-beat dotted notes at the beat', () => {
    const song = build([
      n('0:0:0', 'F3', '4n.'),
      n('0:1:2', 'G3', '8n'),
      n('0:2:0', 'A3', '8n.'),
      n('0:2:3', 'Bb3', '16n'),
      n('0:3:0', 'C4', '8n'),
      n('0:3:2', 'D4', '8n'),
      n('1:0:0', 'Eb4', '2n.'),
      n('1:3:0', 'F4', '16n'),
      n('1:3:1', 'G4', '8n.'),
      n('2:0:0', 'F4', '8n'),
      n('2:0:2', 'D4', '8n.'),
      n('2:1:1', 'C4', '16n')
    ])
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([
      ['q. f/3', '8 g/3', '8. a/3', '16 bb/3', '8 c/4', '8 d/4'],
      ['h. eb/4', '16 f/4', '8. g/4'],
      ['8 f/4', '8 d/4~', '16 d/4', '16 c/4', '8r', 'hr']
    ])
    expectConsistent(song, measures)
  })

  it('ties notes across bar lines and keeps the accidental on the first piece only', () => {
    const song = build([n('0:3:0', 'B3', '2n'), n('1:1:0', 'B3', '4n'), n('1:2:0', 'D4', '2m')])
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([
      ['hr', 'qr', 'q b/3(n)~'],
      ['q b/3', 'q b/3(n)', 'h d/4~'],
      ['w d/4~'],
      ['h d/4', 'hr']
    ])
    const pieces = noteItems(measures).filter((i) => i.noteIndex === 2)
    expect(pieces.map((p) => p.tie)).toEqual([true, true, false])
    expect(pieces.reduce((sum, p) => sum + p.beats, 0)).toBe(8)
    expectConsistent(song, measures)
  })

  it('splits a note that starts off the beat at the beat, and a whole note at the bar line', () => {
    const song = build([n('0:0:2', 'F3', '4n'), n('0:1:2', 'G3', '8n'), n('0:2:0', 'A3', '1n')])
    expect(layout(song)).toEqual([
      ['8r', '8 f/3~', '8 f/3', '8 g/3', 'h a/3~'],
      ['h a/3', 'hr']
    ])
  })

  it('writes eighth and quarter triplets inside 3:2 groups', () => {
    const song = build([
      n('0:0:0', 'F3', '8t'),
      n('0:0:1.3333333', 'G3', '8t'),
      n('0:0:2.6666667', 'A3', '8t'),
      n('0:1:0', 'Bb3', '4t'),
      n('0:1:2.6666667', 'C4', '8t'),
      n('0:2:0', 'D4', '4t'),
      n('0:2:2.6666667', 'Eb4', '4t'),
      n('0:3:1.3333333', 'F4', '4t'),
      n('1:0:0', 'G4', '2t'),
      n('1:1:1.3333333', 'F4', '4t')
    ])
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([
      ['8t f/3', '8t g/3', '8t a/3', 'qt bb/3', '8t c/4', 'qt d/4', 'qt eb/4', 'qt f/4'],
      ['ht g/4', 'qt f/4', 'hr']
    ])
    expect(noteItems(measures).every((i) => i.triplet)).toBe(true)
    expectConsistent(song, measures)
  })

  it('writes 64th notes', () => {
    const song = build([n('0:0:0', 'F3', '64n'), n('0:0:0.25', 'G3', '64n'), n('0:0:0.5', 'A3', '64n'), n('0:0:0.75', 'Bb3', '64n'), n('0:0:1', 'C4', '8n.')])
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([['64 f/3', '64 g/3', '64 a/3', '64 bb/3', '8. c/4', 'qr', 'hr']])
    expect(noteItems(measures).map((i) => i.noteIndex)).toEqual([0, 1, 2, 3, 4])
    expectConsistent(song, measures)
  })

  it('writes notes shorter than the grid as 64ths that delay what follows', () => {
    const song = build([n('0:0:0', 'F3', '128n'), n('0:0:0.125', 'G3', '128n'), n('0:0:0.25', 'A3', '256n'), n('0:0:0.375', 'Bb3', '128n'), n('0:0:0.5', 'C4', '8n')])
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([['64 f/3', '64 g/3', '64 a/3', '64 bb/3', '16. c/4', '32r', '16r', 'qr', 'hr']])
    expect(noteItems(measures).map((i) => i.noteIndex)).toEqual([0, 1, 2, 3, 4])
    expectConsistent(song, measures)
  })

  it('keeps a note on the staff when it lies a tick from a bar line or from its neighbours', () => {
    // A tick of the grid (1/48 of a beat) is too short to write, so these boundaries move.
    const tick = 1 / 12
    const song = build([n('0:3:0', 'F3', '4n'), n(`0:3:${4 - tick}`, 'G3', '64n'), n(`1:0:${3 * tick}`, 'A3', '8n'), n(`1:0:${9 * tick}`, 'Bb3', '4n')])
    const measures = staffMeasures(song)
    expect(order(measures)).toEqual([0, 1, 2, 3])
    expectConsistent(song, measures)
  })

  it('keeps an off-beat head that fits one value in one piece', () => {
    expect(layout(build([n('0:0:1', 'F3', '4n.')]))).toEqual([['16r', '8. f/3~', '8. f/3', '16r', 'hr']])
    expect(layout(build([n('0:0:0', 'F3', '8t'), n('0:0:1.3333333', 'G3', '4n')]))).toEqual([['8t f/3', 'qt g/3~', '8t g/3', 'qtr', 'hr']])
  })

  it('writes a triplet that takes two places of a shorter triplet group as one value', () => {
    const late = build([n('0:0:0', 'F3', '2n'), n('0:2:0', 'G3', '2t'), n('0:3:1.3333333', 'A3', '4t')])
    expect(layout(late)).toEqual([['h f/3', 'ht g/3', 'qt a/3']])
    expectConsistent(late, staffMeasures(late))
    const early = build([n('0:0:0', 'F3', '4t'), n('0:0:2.6666667', 'G3', '2t')])
    expect(layout(early)).toEqual([['qt f/3', 'ht g/3', 'hr']])
  })

  it('fills gaps with exact rests and empty measures with a measure rest', () => {
    const song = build([n('0:0:0', 'F3', '4n'), n('0:2:0', 'G3', '8n'), n('0:2:3', 'A3', '16n'), n('2:1:0', 'Bb3', '8n')])
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([['q f/3', 'qr', '8 g/3', '16r', '16 a/3', 'qr'], ['wr'], ['qr', '8 bb/3', '8r', 'hr']])
    expect(measures[1]!.items[0]).toMatchObject({ kind: 'rest', measureRest: true, beats: 4 })
    expectConsistent(song, measures)
  })

  it('writes a pickup as rests before the first note', () => {
    const four = build([n('0:3:0', 'F3', '4n'), n('1:0:0', 'Bb3', '1n')])
    expect(layout(four)).toEqual([['hr', 'qr', 'q f/3'], ['w bb/3']])
    const three = build([n('0:2:0', 'F3', '4n'), n('1:0:0', 'Bb3', '2n.')], { timeSignature: '3/4' })
    expect(layout(three)).toEqual([['hr', 'q f/3'], ['h. bb/3']])
    const eighthPickup = build([n('0:3:2', 'F3', '8n'), n('1:0:0', 'Bb3', '1n')])
    expect(layout(eighthPickup)).toEqual([['hr', 'qr', '8r', '8 f/3'], ['w bb/3']])
  })

  it('draws unpitched notes as percussion on the middle line', () => {
    const song = build([n('0:0:0', null, '8n'), n('0:0:2', null, '16n'), n('0:0:3', null, '16n'), n('0:1:0', null, '4n', { technique: 'string_slap' })])
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([['8 b/4', '16 b/4', '16 b/4', 'q b/4', 'hr']])
    expect(noteItems(measures).every((i) => i.percussion && i.accidental === null)).toBe(true)
    expectConsistent(song, measures)
  })

  it('keeps the top line where notes overlap', () => {
    const song = build([
      // Together: the higher note wins.
      n('0:0:0', 'F3', '4n'),
      n('0:0:0', 'D4', '4n', { string: 'female' }),
      // A lower note under a held one is left out; a percussion hit too.
      n('0:1:0', 'C4', '2n'),
      n('0:1:2', 'G3', '8n'),
      n('0:2:0', null, '8n'),
      // A higher note cuts the held one short.
      n('1:0:0', 'F3', '2n'),
      n('1:1:0', 'C4', '4n', { string: 'female' })
    ])
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([
      ['q d/4', 'h c/4', 'qr'],
      ['q f/3', 'q c/4', 'hr']
    ])
    expect(noteItems(measures).map((i) => i.noteIndex)).toEqual([1, 2, 5, 6])
    expectConsistent(song, measures)
  })

  it('writes a lower note that outlasts a held higher one from where that one ends', () => {
    // A string crossing: A3 starts under the held C4 and is the only note sounding after it.
    const crossing = build([n('0:0:0', 'C4', '2n', { string: 'female' }), n('0:1:2', 'A3', '2n')])
    const measures = staffMeasures(crossing)
    expect(measures.map(show)).toEqual([['h c/4', 'q. a/3', '8r']])
    expect(noteItems(measures).map((i) => i.noteIndex)).toEqual([0, 1])
    expectConsistent(crossing, measures)
    // A drone under a melody note comes back when the melody stops.
    const drone = build([n('0:0:0', 'F3', '1n'), n('0:1:0', 'C4', '4n', { string: 'female' })])
    expect(layout(drone)).toEqual([['q f/3', 'q c/4', 'h f/3']])
    expect(noteItems(staffMeasures(drone)).map((i) => i.noteIndex)).toEqual([0, 1, 0])
    // Of notes starting together a shorter higher one comes first.
    expect(layout(build([n('0:0:0', 'F3', '2n'), n('0:0:0', 'D4', '4n', { string: 'female' })]))).toEqual([['q d/4', 'q f/3', 'hr']])
  })

  it('reports SongNote.index (file order) even when the file is out of order', () => {
    const song = build([n('0:1:0', 'C4', '4n'), n('0:0:0', 'F3', '4n')])
    expect(noteItems(staffMeasures(song)).map((i) => [i.key, i.noteIndex])).toEqual([
      ['f/3', 1],
      ['c/4', 0]
    ])
  })

  it('gives an empty song one measure rest', () => {
    const song = build([])
    expect(layout(song)).toEqual([['wr']])
  })
})

describe('staffMeasures in compound and other meters', () => {
  it('groups 6/8 in dotted quarters', () => {
    const song = build(
      [
        n('0:0:0', 'F3', '8n'),
        n('0:0:2', 'F3', '8n'),
        n('0:1:0', 'F3', '8n'),
        n('0:1:2', 'C4', '8n'),
        n('0:2:0', 'Bb3', '8n'),
        n('0:2:2', 'Bb3', '8n'),
        n('1:0:0', 'F3', '4n.'),
        n('1:1:2', 'G3', '4n'),
        n('1:2:2', 'A3', '8n'),
        n('2:0:0', 'Bb3', '4n'),
        n('2:1:0', 'C4', '4n'),
        n('3:0:0', 'D4', '2n'),
        n('4:0:0', 'Eb4', '2n.')
      ],
      { timeSignature: '6/8' }
    )
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([
      ['8 f/3', '8 f/3', '8 f/3', '8 c/4', '8 bb/3', '8 bb/3'],
      ['q. f/3', 'q g/3', '8 a/3'],
      ['q bb/3', '8 c/4~', '8 c/4', '8r', '8r'],
      ['q. d/4~', '8 d/4', '8r', '8r'],
      ['h. eb/4']
    ])
    expectConsistent(song, measures)
  })

  it('writes 6/8 rests per dotted-quarter beat and measure rests as one rest', () => {
    const song = build([n('0:2:0', 'F3', '8n'), n('2:1:2', 'G3', '8n')], { timeSignature: '6/8' })
    const measures = staffMeasures(song)
    expect(measures.map(show)).toEqual([['q.r', '8r', '8 f/3', '8r'], ['wr'], ['q.r', '8 g/3', '8r', '8r']])
    expect(measures[1]!.items[0]).toMatchObject({ measureRest: true, beats: 3 })
    expectConsistent(song, measures)
  })

  it('writes 3/4 with dotted half measures and a rest per beat after beat 1', () => {
    const song = build([n('0:0:0', 'F3', '2n.'), n('1:1:0', 'G3', '4n'), n('2:0:0', 'A3', '4n')], { timeSignature: '3/4' })
    expect(layout(song)).toEqual([['h. f/3'], ['qr', 'q g/3', 'qr'], ['q a/3', 'qr', 'qr']])
  })

  it('fills bars that have no single rest value (5/4, 7/8)', () => {
    const five = build([n('1:0:0', 'F3', '4n')], { timeSignature: '5/4' })
    const measures = staffMeasures(five)
    expect(measures.map(show)).toEqual([['wr'], ['q f/3', 'qr', 'hr', 'qr']])
    expect(measures[0]!.items[0]).toMatchObject({ kind: 'rest', measureRest: true, beats: 5 })
    expectConsistent(five, measures)
    const seven = build([n('0:0:0', 'F3', '8n'), n('1:0:0', 'G3', '8n')], { timeSignature: '7/8' })
    expectConsistent(seven, staffMeasures(seven))
    expect(layout(seven)[0]![0]).toBe('8 f/3')
  })

  it.each(['9/8', '5/4', '5/8', '9/4', '7/8', '6/8', '3/4', '2/4', '12/8', '5/16', '2/2'])('writes an empty %s bar as one measure rest', (signature) => {
    const song = build([n('1:0:0', 'F3', '8n')], { timeSignature: signature })
    const measures = staffMeasures(song)
    expect(show(measures[0]!)).toEqual(['wr'])
    expect(measures[0]!.items[0]).toMatchObject({ kind: 'rest', measureRest: true, startBeats: 0, beats: quartersPerBar(song.timeSignature) })
    expect(measures[1]!.items.some((i) => i.kind === 'rest' && i.measureRest)).toBe(false)
    expectConsistent(song, measures)
  })
})

describe('bundled songs', () => {
  const SONGS_DIR = join(__dirname, '../../../../../songs')
  const files = readdirSync(SONGS_DIR).filter((f) => f.endsWith('.mkhuur.json'))

  it.each(files)('%s lays out into full measures with every note on the staff', (file) => {
    const { song } = parseSong(JSON.parse(readFileSync(join(SONGS_DIR, file), 'utf8')))
    const measures = staffMeasures(song!)
    expectConsistent(song!, measures)
    expect(measures).toHaveLength(jianpuMeasures(song!).length)
    const shown = new Set(noteItems(measures).map((i) => i.noteIndex))
    expect([...shown].sort((a, b) => a - b)).toEqual(song!.notes.map((s) => s.index).sort((a, b) => a - b))
    for (const item of noteItems(measures)) {
      const note = song!.notes.find((s) => s.index === item.noteIndex)!
      expect(item.percussion).toBe(note.pitch === null)
    }
    // Written lengths match the file: pieces of each note add up to its duration.
    for (const note of song!.notes) {
      const beats = noteItems(measures)
        .filter((i) => i.noteIndex === note.index)
        .reduce((sum, i) => sum + i.beats, 0)
      expect(beats).toBeCloseTo(note.durationBeats, 6)
    }
  })

  it('writes Etude 3 (6/8 gallop with percussion) as expected', () => {
    const file = files.find((f) => f.startsWith('03-'))!
    const { song } = parseSong(JSON.parse(readFileSync(join(SONGS_DIR, file), 'utf8')))
    expect(layout(song!)).toEqual([
      ['8 f/3', '8 f/3', '8 f/3', '8 c/4', '8 bb/3', '8 bb/3'],
      ['8 f/3', '8 f/3', '8 f/3', '8 d/4', '8 c/4', '8 bb/3'],
      ['8 b/4', '16 b/4', '16 b/4', '8 b/4', '8 b/4', '16 b/4', '16 b/4', '8 b/4'],
      ['h. d/4']
    ])
  })
})

describe('staffMeasures on arbitrary input', () => {
  // Deterministic PRNG (mulberry32) so failures reproduce.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const base = build([])
  const noteShape: Omit<SongNote, 'index' | 'startBeats' | 'durationBeats' | 'pitch'> = {
    time: '0:0:0',
    string: 'male',
    stringInferred: false,
    technique: 'open',
    finger: null,
    bow: null,
    slur: false,
    velocity: 0.8,
    articulations: [],
    glideTo: null,
    drone: null
  }
  const signatures = ['4/4', '3/4', '2/4', '6/8', '9/8', '12/8', '3/8', '5/4', '7/8', '2/2', '6/16', '5/16']
  /** Lengths in 48ths of a quarter: grid values, odd ticks, and some shorter than the grid can write. */
  const lengths = [0.3, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 16, 18, 20, 21, 24, 30, 32, 36, 42, 48, 60, 64, 72, 84, 96, 100, 150, 200, 300]

  /**
   * The top line, tick by tick, computed independently of the layout: the note sounding at each
   * tick of the 48-per-quarter grid that is highest, then latest to start, then first in the song.
   * On the grid a note lasts at least a tick and starts after every note that ended before it.
   * Returns the note indexes in the order they take over the line.
   */
  function expectedLine(song: Song): number[] {
    const spans: { note: SongNote; start: number; end: number }[] = []
    for (const note of song.notes) {
      const after = spans.filter((s) => s.note.startBeats + s.note.durationBeats <= note.startBeats + 1e-6).map((s) => s.start + 1)
      const start = Math.max(0, Math.round(note.startBeats * TPQ), ...after)
      spans.push({ note, start, end: Math.max(start + 1, Math.round((note.startBeats + note.durationBeats) * TPQ)) })
    }
    const height = (p: number | null) => p ?? -Infinity
    const line: number[] = []
    const last = spans.reduce((end, s) => Math.max(end, s.end), 0)
    for (let t = 0; t < last; t++) {
      let top: (typeof spans)[number] | null = null
      for (const s of spans) {
        if (s.start > t || s.end <= t) continue
        const d = top ? height(s.note.pitch) - height(top.note.pitch) : 1
        if (!top || d > 0 || ((d === 0 || Number.isNaN(d)) && s.start > top.start)) top = s
      }
      if (top && line.at(-1) !== top.note.index) line.push(top.note.index)
      if (!top && line.at(-1) !== -1) line.push(-1)
    }
    return line.filter((i) => i >= 0)
  }

  it.each(signatures)('always fills %s measures exactly with valid values and writes the whole top line', (signature) => {
    const random = rng(signature.charCodeAt(0) * 31 + signature.length)
    const timeSignature = parseTimeSignature(signature)!
    for (let round = 0; round < 60; round++) {
      // Some rounds are one line of notes, the rest overlap.
      const monophonic = round % 3 === 0
      const count = 1 + Math.floor(random() * 24)
      const notes: SongNote[] = []
      let t = Math.floor(random() * 60)
      for (let index = 0; index < count; index++) {
        const ticks = lengths[Math.floor(random() * lengths.length)]!
        const gap = random() < 0.3 ? Math.floor(random() * 60) : random() < 0.2 ? lengths[Math.floor(random() * 4)]! : 0
        const start = !monophonic && random() < 0.15 ? Math.max(0, t - Math.floor(random() * 40)) : t + gap
        const pitch = random() < 0.2 ? null : 53 + Math.floor(random() * 30)
        notes.push({ ...noteShape, index, startBeats: start / TPQ, durationBeats: ticks / TPQ, pitch })
        t = start + ticks
      }
      notes.sort((a, b) => a.startBeats - b.startBeats || a.index - b.index)
      const lengthBeats = notes.reduce((end, s) => Math.max(end, s.startBeats + s.durationBeats), 0)
      const song: Song = { ...base, timeSignature, keyPc: Math.floor(random() * 12), notes, lengthBeats }
      const measures = staffMeasures(song)
      expectConsistent(song, measures)
      // Nothing that is ever on top disappears, however short, and the order is kept.
      expect(order(measures)).toEqual(expectedLine(song))
      if (monophonic) expect(order(measures)).toEqual(notes.map((s) => s.index))
    }
  })
})
