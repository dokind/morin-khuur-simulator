import { describe, expect, it } from 'vitest'
import { parseSong, verifySong, type RawSong, type RawSongNote } from '../notation'
import { performedTiming, planPerformance } from './plan'
import { FRAMES } from './presets'
import type { PlanOptions } from './types'

const note = (n: Partial<RawSongNote>): RawSongNote => ({
  time: '0:0:0',
  pitch: 'C4',
  duration: '4n',
  string: 'female',
  technique: 'cuticle_side_stop',
  finger: 'index',
  bow: 'tatakh',
  ...n
})

/** Alternating bows so verification stays clean. */
const line = (notes: Partial<RawSongNote>[]): RawSongNote[] => notes.map((n, i) => note({ bow: i % 2 ? 'tülekhe' : 'tatakh', ...n }))

const build = (notes: RawSongNote[], extra: Partial<RawSong> & Record<string, unknown> = {}) => {
  const { song, issues } = parseSong({ title: 'Plan test', tuning: { maleString: 'F3', femaleString: 'Bb3' }, tempoBpm: 60, timeSignature: '4/4', notes, ...extra })
  expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  return { song: song!, report: verifySong(song!) }
}
const plan = (b: ReturnType<typeof build>, opts: PlanOptions = {}) => planPerformance(b.song, b.report, b.song.tempoBpm, opts)

const STOP: Record<string, { string: 'male' | 'female'; finger: RawSongNote['finger'] }> = {
  C4: { string: 'female', finger: 'index' },
  D4: { string: 'female', finger: 'middle' },
  F4: { string: 'female', finger: 'pinky' },
  G4: { string: 'female', finger: 'ring' }
}
/** A pentatonic phrase in half notes and quarters (at 60 bpm: 2 s and 1 s). */
const phrase = (bar: number): Partial<RawSongNote>[] =>
  (
    [
      ['F4', '2n', 0],
      ['D4', '4n', 2],
      ['C4', '4n', 3],
      ['D4', '2n', 4],
      ['G4', '2n', 6]
    ] as const
  ).map(([p, d, beat]) => ({
    time: `${bar + Math.floor(beat / 4)}:${beat % 4}:0`,
    pitch: p,
    duration: d,
    technique: 'cuticle_side_stop',
    ...STOP[p]
  }))

describe('as written', () => {
  it('adds nothing: no ornaments, vibrato, timing, bowing or frames', () => {
    const b = build(line([...phrase(0), ...phrase(2)].map((n) => ({ ...n, articulations: ['vibrato'], ornament: 'trill' as const }))), { genre: 'Urtiin duu', frame: { open: true } })
    const p = plan(b, { style: 'as-written' })
    expect(p.frames).toEqual([])
    expect(p.leadIn).toBe(0)
    for (const [i, n] of p.notes.entries()) {
      expect(n).toEqual({ order: i, timeOffset: 0, durationScale: 1, ornaments: [], vibrato: null, bow: 'swell', positionRamp: null, shurankhai: false, drone: null })
    }
  })

  it('is what a song asks for with style "as-written"', () => {
    expect(plan(build(line(phrase(0)), { style: 'as-written', genre: 'Tatlaga' })).style).toBe('as-written')
  })
})

describe('khalkh stage', () => {
  it('keeps a fixed rhythm and adds only scoops, shift slides and vibrato on long notes', () => {
    const b = build(line([...phrase(0), ...phrase(2), ...phrase(4)]))
    const p = plan(b)
    expect(p.style).toBe('khalkh-stage')
    expect(p.frames).toEqual([])
    for (const n of p.notes) {
      expect(n.timeOffset).toBe(0)
      expect(n.durationScale).toBe(1)
      for (const o of n.ornaments) expect(['scoop', 'shift-slide']).toContain(o.kind)
      if (n.vibrato) expect(n.vibrato.shape).toBe('lyrical')
    }
    // Long stopped notes (over 0.9 s) get the automatic lyrical vibrato.
    expect(p.notes.every((n, i) => (b.report.checks[i]!.note.durationBeats >= 1 ? n.vibrato !== null : n.vibrato === null))).toBe(true)
  })

  it('scoops phrase-start notes of 0.8 s or more from the neighbour below', () => {
    const b = build(line(phrase(0)))
    const first = plan(b).notes[0]!
    // F4 after nothing: E is not in the pitch set, so the slide starts a minor third below, on D.
    expect(first.ornaments).toEqual([{ kind: 'scoop', semitones: -3, seconds: 0.09, at: 'start' }])
  })
})

describe('long song', () => {
  const longSong = (genre: string) => build(line([...phrase(0), ...phrase(2), ...phrase(4), ...phrase(6)]), { genre, tempoBpm: 40 })

  it('lengthens rising and phrase-final notes, breathes before phrases and holds the final note', () => {
    const b = longSong('Urtiin duu')
    const p = plan(b)
    expect(p.style).toBe('urtiin-duu')
    const t = performedTiming(p, b.song, b.report, b.song.tempoBpm)
    // Onsets never cross.
    for (let i = 1; i < t.notes.length; i++) expect(t.notes[i]!.start).toBeGreaterThan(t.notes[i - 1]!.start)
    // By the end the performance has drifted later than the written time.
    const last = p.notes[p.notes.length - 1]!
    expect(last.timeOffset).toBeGreaterThan(0.3)
    const writtenLast = b.report.checks[p.notes.length - 1]!.note.durationBeats * 1.5
    expect(t.notes[t.notes.length - 1]!.duration).toBeCloseTo(writtenLast * 1.15 * 1.08 + FRAMES.finalHold, 1)
    expect(p.frames.map((f) => f.kind)).toEqual(['prelude'])
    expect(p.leadIn).toBeCloseTo(FRAMES.prelude.duration + FRAMES.prelude.gap)
  })

  it('uses tsokhilt vibrato, or bönjignökh for Borjgin songs', () => {
    expect(plan(longSong('Urtiin duu')).notes.find((n) => n.vibrato)!.vibrato!.shape).toBe('tsokhilt')
    expect(plan(longSong('Borjgin urtiin duu')).notes.find((n) => n.vibrato)!.vibrato!.shape).toBe('bonjignokh')
  })

  it('places shurankhai by sub-genre: aizam 2, suman 1, besreg 0', () => {
    const count = (genre: string) => plan(longSong(genre)).notes.filter((n) => n.shurankhai).length
    expect(count('Urtiin duu, aizam')).toBe(2)
    expect(count('Urtiin duu, suman')).toBe(1)
    expect(count('Urtiin duu, besreg')).toBe(0)
    const shurankhai = plan(longSong('aizam'), { style: 'urtiin-duu' }).notes.filter((n) => n.shurankhai)
    expect(shurankhai.every((n) => n.positionRamp === null)).toBe(true)
  })

  it('ornaments repeats more than the first hearing', () => {
    // The same two bars eight times, against eight different two-bar pairs (a body tap moves around
    // under the held first note, so the pitches and eligibility stay the same).
    const variant = (vary: boolean) =>
      build(
        [0, 2, 4, 6, 8, 10, 12, 14].flatMap((bar, k) => [
          ...line(phrase(bar)),
          note({ time: `${bar}:0:${vary ? k % 4 : 0}`, pitch: null, duration: '16n', string: null, technique: 'body_tap', finger: null, bow: null })
        ]),
        { genre: 'Urtiin duu', tempoBpm: 40 }
      )
    for (const style of ['urtiin-duu', 'inner-mongolian'] as const) {
      const count = (vary: boolean) => plan(variant(vary), { style }).notes.reduce((s, n) => s + n.ornaments.filter((o) => o.kind !== 'scoop').length, 0)
      expect(count(false)).toBeGreaterThan(count(true))
    }
    const stage = (vary: boolean) => plan(variant(vary), { style: 'khalkh-stage' }).notes.map((n) => n.ornaments)
    expect(stage(false)).toEqual(stage(true))
  })
})

describe('tatlaga', () => {
  const gallop = (extra: Partial<RawSong> = {}) =>
    build(
      line([
        { time: '0:0:0', pitch: 'F3', duration: '8n', string: 'male', technique: 'gallop', finger: null },
        { time: '0:0:2', pitch: 'C4', duration: '8n', technique: 'gallop' },
        { time: '0:1:0', pitch: 'D4', duration: '8n', technique: 'gallop', finger: 'middle' },
        { time: '0:1:2', pitch: 'F3', duration: '8n', string: 'male', technique: 'gallop', finger: null },
        { time: '0:2:0', pitch: 'C4', duration: '2n', technique: 'cuticle_side_stop' }
      ]),
      { genre: 'Tatlaga', tempoBpm: 132, ...extra }
    )

  it('frames the piece with om zee, accents both bow directions and drones under the female string', () => {
    const b = gallop()
    const p = plan(b)
    expect(p.style).toBe('tatlaga')
    expect(p.frames.map((f) => [f.kind, f.bow])).toEqual([
      ['om-zee', 'tatakh'],
      ['om-zee', 'tülekhe'],
      ['om-zee', 'tatakh'],
      ['om-zee', 'tülekhe']
    ])
    expect(p.leadIn).toBeCloseTo(2 * FRAMES.omZee.stroke + FRAMES.omZee.gap)
    expect(p.notes.map((n) => n.bow)).toEqual(['accent-release', 'accent-release', 'accent-release', 'accent-release', 'accent-release'])
    expect(p.notes.map((n) => n.drone !== null)).toEqual([false, true, true, false, true])
    // Gallop strokes never get scoops, graces, trills or falls.
    for (const [i, n] of p.notes.entries()) if (b.report.checks[i]!.note.technique === 'gallop') for (const o of n.ornaments) expect(['trot-slide', 'hammer']).toContain(o.kind)
  })

  it('never drones where the male string is busy', () => {
    const b = build(
      [
        note({ time: '0:0:0', pitch: 'C4', duration: '2n' }),
        note({ time: '0:1:0', pitch: 'F3', duration: '4n', string: 'male', technique: 'open', finger: null, bow: 'tülekhe' }),
        note({ time: '0:2:0', pitch: 'D4', duration: '4n', finger: 'middle', bow: 'tülekhe' })
      ],
      { genre: 'Tatlaga' }
    )
    expect(plan(b).notes.map((n) => n.drone !== null)).toEqual([false, false, true])
    expect(plan(b, { style: 'khalkh-stage' }).notes.every((n) => n.drone === null)).toBe(true)
  })

  it('switches frames with the song\'s frame hint', () => {
    expect(plan(gallop({ frame: { open: false } })).frames.map((f) => f.start >= 0)).toEqual([true, true])
    expect(plan(gallop({ frame: { open: false, close: false } })).frames).toEqual([])
    expect(plan(gallop({ frame: { open: false, close: false } })).leadIn).toBe(0)
    expect(plan(build(line(phrase(0)), { frame: { open: true } })).frames.map((f) => f.kind)).toEqual(['om-zee', 'om-zee'])
  })
})

describe('bii / ikel and Inner Mongolian', () => {
  it('bii tunes use abrupt strokes, no automatic vibrato, and loop', () => {
    const b = build(line([...phrase(0), ...phrase(2)]), { genre: 'Bii biyelgee' })
    const p = plan(b)
    expect(p.loop).toBe(true)
    expect(p.notes.every((n) => n.vibrato === null)).toBe(true)
    expect(p.notes[0]!.bow).toBe('abrupt')
  })

  it('Inner Mongolian style opens with om zee and uses irregular vibrato only on very long notes', () => {
    const b = build(line([...phrase(0), ...phrase(2)]), { genre: 'Inner Mongolian', tempoBpm: 40 })
    const p = plan(b)
    expect(p.frames.map((f) => f.kind)).toEqual(['om-zee', 'om-zee'])
    for (const [i, n] of p.notes.entries()) {
      const d = b.report.checks[i]!.note.durationBeats * 1.5
      if (n.vibrato) expect(d).toBeGreaterThanOrEqual(1.5 - 0.1)
      if (n.vibrato) expect(n.vibrato.shape).toBe('nogula')
    }
  })
})

describe('hints and physical limits', () => {
  it('honours note-level ornament hints in any expressive style', () => {
    const b = build(line([{ ...phrase(0)[0]!, ornament: 'trill' }, { ...phrase(0)[1]!, ornament: 'none' }, ...phrase(0).slice(2)]))
    const p = plan(b, { style: 'khalkh-stage' })
    expect(p.notes[0]!.ornaments.map((o) => o.kind)).toEqual(['trill'])
    expect(p.notes[0]!.ornaments[0]).toMatchObject({ at: 'end', semitones: 2, rateHz: 6.5, from: 0.6 }) // F up to G: no A or A♭ in the set
    expect(p.notes[0]!.vibrato).toBeNull() // no automatic vibrato under a trill
    expect(plan(b, { style: 'urtiin-duu' }).notes[1]!.ornaments).toEqual([])
  })

  it('drops hints the hand cannot play and never ornaments below the nut', () => {
    const b = build(
      line([
        { time: '0:0:0', pitch: 'Bb3', duration: '2n', technique: 'open', finger: null, ornament: 'scoop' },
        { time: '0:2:0', pitch: 'Bb3', duration: '2n', technique: 'open', finger: null, ornament: 'fall' },
        { time: '1:0:0', pitch: 'Bb3', duration: '2n', technique: 'open', finger: null, ornament: 'hammer' },
        { time: '1:2:0', pitch: 'D4', duration: '2n', finger: 'middle', technique: 'cuticle_side_stop' },
        { time: '2:0:0', pitch: 'C4', duration: '2n', technique: 'cuticle_side_stop' }
      ])
    )
    const p = plan(b, { style: 'inner-mongolian' })
    expect(p.notes[0]!.ornaments).toEqual([])
    expect(p.notes[1]!.ornaments).toEqual([])
    expect(p.notes[2]!.ornaments.map((o) => [o.kind, o.semitones])).toEqual([['hammer', 4]]) // an upper note on an open string is fine
  })

  it('slides into a stop from the open string at most, never past the nut', () => {
    // C4 is two stops up the female string: the whole tone below is the open B♭3. B3 is one stop
    // up: a tone below is under the nut, and the semitone to B♭ is not a step of this melody (nor
    // is B–C, so C4 does not slide from B3 either).
    const b = build(
      line([
        { time: '0:0:0', pitch: 'C4', duration: '2n', ornament: 'scoop' },
        { time: '0:2:0', pitch: 'D4', duration: '2n', finger: 'middle' },
        { time: '1:0:0', pitch: 'F4', duration: '2n', finger: 'pinky' },
        { time: '1:2:0', pitch: 'B3', duration: '2n', ornament: 'scoop' }
      ])
    )
    for (const style of ['khalkh-stage', 'urtiin-duu', 'inner-mongolian'] as const) {
      const p = plan(b, { style })
      expect(p.notes[0]!.ornaments.map((o) => [o.kind, o.semitones])).toEqual([['scoop', -2]])
      expect(p.notes[3]!.ornaments).toEqual([])
    }
  })

  it('never scoops a slurred continuation or a short phrase start (stage)', () => {
    // From the open male string up to a long G4 (no shift slide across strings): scooped when bowed
    // anew, glided in legato when slurred.
    const leap = (slur: boolean) =>
      plan(
        build(
          line([
            { time: '0:0:0', pitch: 'F3', duration: '2n', string: 'male', technique: 'open', finger: null },
            { time: '0:2:0', pitch: 'G4', duration: '2n', finger: 'ring', ...(slur ? { slur, bow: 'tatakh' as const } : {}) }
          ])
        ),
        { style: 'khalkh-stage' }
      )
    expect(leap(false).notes[1]!.ornaments.map((o) => o.kind)).toEqual(['scoop'])
    expect(leap(true).notes[1]!.ornaments).toEqual([])
    // A phrase start under 0.8 s is not scooped (the 2 s one is: see 'scoops phrase-start notes').
    const short = plan(build(line([{ time: '0:0:0', pitch: 'F4', duration: '8n', finger: 'pinky' }, { time: '0:0:2', pitch: 'D4', duration: '8n', finger: 'middle' }])), { style: 'khalkh-stage' })
    expect(short.notes.every((n) => n.ornaments.length === 0)).toBe(true)
  })

  it('applies vibrato placement and treats it as asking for vibrato', () => {
    const b = build(line([{ ...phrase(0)[1]!, time: '0:0:0', vibratoPlacement: 'start' }, { ...phrase(0)[2]!, time: '0:1:0', articulations: ['vibrato'] }]), { genre: 'Tatlaga' })
    const p = plan(b)
    expect(p.notes[0]!.vibrato).toMatchObject({ placement: 'start', shape: 'lyrical' })
    expect(p.notes[1]!.vibrato).toMatchObject({ placement: 'whole' })
    expect(plan(b, { style: 'bii-ikel' }).notes[1]!.vibrato).not.toBeNull()
  })

  it('turns automatic ornaments off at amount 0, and multiplies the song\'s own amount', () => {
    const b = build(line([...phrase(0), ...phrase(2), ...phrase(4)]), { genre: 'Inner Mongolian' })
    expect(plan(b, { amount: 0 }).notes.every((n) => n.ornaments.length === 0)).toBe(true)
    const quiet = build(line([...phrase(0), ...phrase(2), ...phrase(4)]), { genre: 'Inner Mongolian', ornamentAmount: 0 })
    expect(plan(quiet, { amount: 2 }).notes.every((n) => n.ornaments.length === 0)).toBe(true)
  })

  it('never ornaments harmonics, plucks or percussion', () => {
    const b = build([
      note({ time: '0:0:0', pitch: 'F4', duration: '2n', string: 'male', technique: 'tsatsal_harmonic', finger: 'ring', ornament: 'trill', articulations: ['vibrato'] }),
      note({ time: '0:2:0', pitch: 'C4', duration: '2n', technique: 'pizzicato', bow: null, ornament: 'scoop' }),
      note({ time: '1:0:0', pitch: null, duration: '2n', string: null, technique: 'body_tap', finger: null, bow: null })
    ])
    for (const style of ['khalkh-stage', 'urtiin-duu', 'tatlaga', 'bii-ikel', 'inner-mongolian'] as const) {
      for (const n of plan(b, { style }).notes) {
        expect(n.ornaments).toEqual([])
        expect(n.vibrato).toBeNull()
        expect(n.drone).toBeNull()
      }
    }
  })

  it('schedules against the tempo map, which is notation and applies as written too', () => {
    const b = build(line(phrase(0)), { tempoMap: [{ time: '0:3:0', bpm: 30 }] })
    const p = plan(b, { style: 'as-written' })
    const t = performedTiming(p, b.song, b.report, 60)
    expect(t.notes.map((n) => n.start)).toEqual([0, 2, 3, 5, 9])
    expect(t.notes[2]!.duration).toBeCloseTo(2)
  })
})

describe('edge cases', () => {
  it('plans an empty song', () => {
    const b = build([], { genre: 'Tatlaga' })
    expect(plan(b)).toEqual({ style: 'tatlaga', notes: [], frames: [], leadIn: 0 })
  })
})

describe('determinism', () => {
  it('gives the same plan for the same input', () => {
    const raw = () => line([...phrase(0), ...phrase(2), ...phrase(4)])
    for (const style of ['urtiin-duu', 'tatlaga', 'bii-ikel', 'inner-mongolian'] as const) {
      expect(plan(build(raw(), { genre: 'x' }), { style })).toEqual(plan(build(raw(), { genre: 'x' }), { style }))
    }
    // A different title draws differently.
    const a = plan(build(raw()), { style: 'inner-mongolian' })
    const other = parseSong({ title: 'Another title', tuning: { maleString: 'F3', femaleString: 'Bb3' }, tempoBpm: 60, timeSignature: '4/4', notes: raw() }).song!
    const c = planPerformance(other, verifySong(other), 60, { style: 'inner-mongolian' })
    expect(c.notes.map((n) => n.timeOffset)).not.toEqual(a.notes.map((n) => n.timeOffset))
  })
})
