import { describe, expect, it } from 'vitest'
import { degreeOf, durationMarks, jianpuMeasures, referenceTonic } from './jianpu'
import { parseSong } from './parse'
import { formatPosition, parseDuration, parsePosition, parseTimeSignature } from './timing'
import type { RawSong, RawSongNote } from './types'
import { verifySong } from './verify'

const FOUR = parseTimeSignature('4/4')!
const SIX_EIGHT = parseTimeSignature('6/8')!

describe('timing', () => {
  it('parses Tone.js bars:beats:sixteenths positions in quarter beats', () => {
    expect(parsePosition('0:0:0', FOUR)).toBe(0)
    expect(parsePosition('1:2:2', FOUR)).toBe(6.5)
    expect(parsePosition('1:0:0', SIX_EIGHT)).toBe(3)
    expect(parsePosition('2:1', FOUR)).toBe(9)
    expect(parsePosition('bar 1', FOUR)).toBeNull()
  })

  it('formats positions back', () => {
    expect(formatPosition(6.5, FOUR)).toBe('1:2:2')
    expect(formatPosition(3.5, SIX_EIGHT)).toBe('1:0:2')
  })

  it('parses durations including dots, triplets and measures', () => {
    expect(parseDuration('4n', FOUR)).toBe(1)
    expect(parseDuration('8n.', FOUR)).toBe(0.75)
    expect(parseDuration('8t', FOUR)).toBeCloseTo(1 / 3)
    expect(parseDuration('1m', SIX_EIGHT)).toBe(3)
    expect(parseDuration('quarter', FOUR)).toBeNull()
  })
})

const note = (n: Partial<RawSongNote>): RawSongNote => ({
  time: '0:0:0',
  pitch: 'F3',
  duration: '4n',
  string: 'male',
  technique: 'open',
  finger: null,
  bow: 'tatakh',
  ...n
})

const song = (notes: RawSongNote[], extra: Partial<RawSong> = {}): RawSong => ({
  title: 'Test',
  tuning: { maleString: 'F3', femaleString: 'Bb3' },
  tempoBpm: 90,
  timeSignature: '4/4',
  notes,
  ...extra
})

const verify = (raw: RawSong) => {
  const { song: parsed, issues } = parseSong(raw)
  expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  return verifySong(parsed!)
}
const codes = (report: ReturnType<typeof verifySong>) => report.checks.flatMap((c) => c.issues.map((i) => i.code))

describe('parseSong', () => {
  it('rejects files without usable song-level fields', () => {
    const { song: parsed, issues } = parseSong({ title: 'x', notes: [] })
    expect(parsed).toBeNull()
    expect(issues.map((i) => i.code)).toContain('bad-tuning')
  })

  it('skips malformed notes but keeps the rest', () => {
    const { song: parsed, issues } = parseSong(song([note({}), note({ time: '0:1:0', technique: 'laser' })]))
    expect(parsed!.notes).toHaveLength(1)
    expect(issues.map((i) => i.code)).toEqual(['bad-technique'])
  })

  it('accepts the ASCII "tulekhe" spelling and infers missing strings', () => {
    const { song: parsed } = parseSong(song([note({ pitch: 'C4', string: undefined, technique: 'cuticle_side_stop', finger: 'index', bow: 'tulekhe' })]))
    expect(parsed!.notes[0]).toMatchObject({ bow: 'tülekhe', string: 'female', stringInferred: true })
  })
})

describe('verifySong', () => {
  it('flags the spec §5.2 example: C4 is not a natural harmonic of the B♭3 string', () => {
    const report = verify(
      song([
        note({ time: '0:0:0', pitch: 'F3', string: 'male', technique: 'open', bow: 'tatakh' }),
        note({ time: '0:1:0', pitch: 'G3', string: 'male', technique: 'cuticle_side_stop', finger: 'index', bow: 'tülekhe' }),
        note({ time: '0:2:0', pitch: 'C4', string: 'female', technique: 'tsatsal_harmonic', finger: 'ring', bow: 'tatakh' })
      ])
    )
    expect(report.checks.map((c) => c.passed)).toEqual([true, true, false])
    expect(report.checks[2]!.issues[0]!.code).toBe('not-a-harmonic')
    expect(report.score).toBeCloseTo(2 / 3)
  })

  it('computes just-intonation frequencies for harmonics', () => {
    const report = verify(song([note({ pitch: 'D6', string: 'female', technique: 'tsatsal_harmonic', finger: 'middle' })]))
    const check = report.checks[0]!
    expect(check.partial).toBe(5)
    expect(check.expectedFreq).toBeCloseTo(233.082 * 5, 1)
  })

  it('rejects pitches outside the string and "open" notes that are stopped', () => {
    const report = verify(
      song([
        note({ pitch: 'Eb3', string: 'male' }),
        note({ time: '0:1:0', pitch: 'G3', technique: 'open', bow: 'tülekhe' }),
        note({ time: '0:2:0', pitch: 'C6', string: 'male', technique: 'cuticle_side_stop', finger: 'index' })
      ])
    )
    expect(codes(report)).toEqual(expect.arrayContaining(['below-open', 'open-mismatch', 'above-range']))
    expect(report.passed).toBe(0)
  })

  it('allows only one pitch per string at a time, except across strings', () => {
    const overlapping = verify(
      song([note({ duration: '2n' }), note({ time: '0:1:0', pitch: 'G3', technique: 'cuticle_side_stop', finger: 'index', bow: 'tülekhe' })])
    )
    expect(codes(overlapping)).toContain('string-overlap')

    const acrossStrings = verify(song([note({ duration: '2n' }), note({ time: '0:1:0', pitch: 'Bb3', string: 'female', bow: 'tülekhe' })]))
    expect(codes(acrossStrings)).not.toContain('string-overlap')
  })

  it('checks bow alternation, slurs and retakes after rests', () => {
    const repeated = verify(song([note({}), note({ time: '0:1:0', bow: 'tatakh' })]))
    expect(codes(repeated)).toContain('bow-repeat')

    const slurred = verify(song([note({}), note({ time: '0:1:0', bow: 'tatakh', slur: true })]))
    expect(codes(slurred)).not.toContain('bow-repeat')

    const badSlur = verify(song([note({}), note({ time: '0:1:0', bow: 'tülekhe', slur: true })]))
    expect(codes(badSlur)).toContain('slur-bow-change')

    const afterRest = verify(song([note({}), note({ time: '0:3:0', bow: 'tatakh' })]))
    expect(codes(afterRest)).not.toContain('bow-repeat')
  })

  it('warns about crossed fingers in first position', () => {
    const report = verify(
      song([
        note({ pitch: 'C4', string: 'female', technique: 'cuticle_side_stop', finger: 'middle' }),
        note({ time: '0:1:0', pitch: 'D4', string: 'female', technique: 'cuticle_side_stop', finger: 'index', bow: 'tülekhe' })
      ])
    )
    expect(codes(report)).toContain('finger-crossing')
  })

  it('accepts vibrato on an open string (taught on "empty strings" by UUGUUL)', () => {
    const report = verify(song([note({ articulations: ['vibrato'] })]))
    expect(codes(report)).toEqual([])
  })

  it('accepts the legacy "glissando" id and reads the genre', () => {
    const { song: parsed, issues } = parseSong(song([note({ pitch: 'C4', string: 'female', technique: 'glissando', finger: 'index' })], { genre: 'Urtiin Duu' }))
    expect(issues).toEqual([])
    expect(parsed!.notes[0]!.technique).toBe('gulsuulakh_glissando')
    expect(parsed!.genre).toBe('Urtiin Duu')
  })

  it('allows erkhii darakh (thumb) on either string', () => {
    const ok = verify(song([note({ pitch: 'C4', string: 'male', technique: 'erkhii_darakh', finger: 'thumb' })]))
    expect(ok.checks[0]!.passed).toBe(true)
    expect(codes(ok)).toEqual([])

    // C on the B♭ string with the thumb, as most sources describe it.
    const female = verify(song([note({ pitch: 'C4', string: 'female', technique: 'erkhii_darakh', finger: 'thumb' })]))
    expect(female.checks[0]!.passed).toBe(true)
    expect(codes(female)).toEqual([])

    const lowMale = verify(song([note({ pitch: 'G3', string: 'male', technique: 'erkhii_darakh', finger: 'thumb' })]))
    expect(codes(lowMale)).toContain('thumb-low')

    const misnotated = verify(song([note({ pitch: 'C4', string: 'male', technique: 'cuticle_side_stop', finger: 'thumb' })]))
    expect(codes(misnotated)).toContain('thumb-technique')
  })

  it('does not require pitch or bow for body taps', () => {
    const report = verify(song([note({ pitch: null, string: null, technique: 'body_tap', bow: null })]))
    expect(report.checks[0]!.passed).toBe(true)
    expect(codes(report)).toEqual([])
  })
})

describe('jianpu', () => {
  it('numbers degrees relative to the key with octave dots', () => {
    const ref = referenceTonic([58, 60, 62, 65], 10) // B♭ major melody around B♭3
    expect(ref).toBe(58)
    expect(degreeOf(58, ref)).toEqual({ degree: '1', accidental: '', octave: 0 })
    expect(degreeOf(65, ref)).toEqual({ degree: '5', accidental: '', octave: 0 })
    expect(degreeOf(53, ref)).toEqual({ degree: '5', accidental: '', octave: -1 })
    expect(degreeOf(63, ref)).toEqual({ degree: '4', accidental: '', octave: 0 })
    expect(degreeOf(64, ref)).toEqual({ degree: '4', accidental: '#', octave: 0 })
  })

  it('marks durations with underlines, dashes and dots', () => {
    expect(durationMarks(1)).toEqual({ underlines: 0, dashes: 0, dotted: false })
    expect(durationMarks(0.5)).toEqual({ underlines: 1, dashes: 0, dotted: false })
    expect(durationMarks(0.25)).toEqual({ underlines: 2, dashes: 0, dotted: false })
    expect(durationMarks(2)).toEqual({ underlines: 0, dashes: 1, dotted: false })
    expect(durationMarks(4)).toEqual({ underlines: 0, dashes: 3, dotted: false })
    expect(durationMarks(1.5)).toEqual({ underlines: 0, dashes: 0, dotted: true })
  })

  it('lays out bars and fills gaps with rests', () => {
    const { song: parsed } = parseSong(song([note({}), note({ time: '1:0:0', bow: 'tülekhe' })], { key: 'Bb' }))
    const measures = jianpuMeasures(parsed!)
    expect(measures).toHaveLength(2)
    expect(measures[0]!.items.map((i) => i.symbol.degree)).toEqual(['5', '0'])
    expect(measures[1]!.items.map((i) => i.kind)).toEqual(['note'])
  })
})
