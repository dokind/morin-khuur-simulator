import { describe, expect, it } from 'vitest'
import { centsBetween, freqToMidi, midiToFreq, midiToName, parseNote, parsePitchClass, prettyNoteName } from './pitch'

describe('parseNote', () => {
  it('parses naturals, flats and sharps in scientific pitch notation', () => {
    expect(parseNote('C4')).toBe(60)
    expect(parseNote('F3')).toBe(53)
    expect(parseNote('Bb3')).toBe(58)
    expect(parseNote('B♭3')).toBe(58)
    expect(parseNote('F#4')).toBe(66)
    expect(parseNote('Cb4')).toBe(59)
    expect(parseNote('B#3')).toBe(60)
  })

  it('rejects malformed names', () => {
    expect(parseNote('H3')).toBeNull()
    expect(parseNote('Bb')).toBeNull()
    expect(parseNote('')).toBeNull()
  })

  it('parses bare pitch classes', () => {
    expect(parsePitchClass('Bb')).toBe(10)
    expect(parsePitchClass('F')).toBe(5)
    expect(parsePitchClass('X')).toBeNull()
  })
})

describe('names and frequencies', () => {
  it('round-trips MIDI names preferring flats', () => {
    expect(midiToName(58)).toBe('Bb3')
    expect(midiToName(63)).toBe('Eb4')
    expect(midiToName(66, true)).toBe('F#4')
    expect(prettyNoteName('Bb3')).toBe('B♭3')
  })

  it('converts between MIDI and Hz at A4 = 440', () => {
    expect(midiToFreq(69)).toBeCloseTo(440)
    expect(midiToFreq(53)).toBeCloseTo(174.614, 2)
    expect(freqToMidi(233.082)).toBeCloseTo(58, 3)
  })

  it('measures cents', () => {
    expect(centsBetween(440, 880)).toBeCloseTo(1200)
    expect(centsBetween(440, 440 * 2 ** (5 / 1200))).toBeCloseTo(5)
  })
})
