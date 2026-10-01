import { describe, expect, it } from 'vitest'
import {
  allowedFingers,
  chooseString,
  DEFAULT_TUNING,
  harmonicNearStop,
  harmonicNode,
  keyboardLayout,
  partialForInterval,
  scaleStops,
  stopFraction,
  suggestFinger
} from './instrument'
import { midiToName } from './pitch'

describe('string physics', () => {
  it('places the octave stop at half the vibrating length', () => {
    expect(stopFraction(0)).toBe(0)
    expect(stopFraction(12)).toBeCloseTo(0.5)
    expect(stopFraction(24)).toBeCloseTo(0.75)
  })

  it('describes harmonic nodes: 1/3 node sits near the fifth and sounds an octave + fifth', () => {
    const third = harmonicNode(3)
    expect(third.nodeFraction).toBeCloseTo(1 / 3)
    expect(third.positionSemitones).toBeCloseTo(7.02, 2)
    expect(third.soundingSemitones).toBeCloseTo(19.02, 2)
    // The 5th partial is ~14 cents flat of the tempered major third: authentic, not a bug.
    expect(harmonicNode(5).soundingSemitones).toBeCloseTo(27.86, 2)
  })

  it('recognises written intervals that are natural harmonics', () => {
    expect(partialForInterval(12)).toBe(2)
    expect(partialForInterval(19)).toBe(3)
    expect(partialForInterval(24)).toBe(4)
    expect(partialForInterval(28)).toBe(5)
    expect(partialForInterval(2)).toBeNull()
    expect(partialForInterval(7)).toBeNull()
  })

  it('finds the harmonic touched when lightly placing a finger near a node', () => {
    expect(harmonicNearStop(12)?.partial).toBe(2)
    expect(harmonicNearStop(7)?.partial).toBe(3)
    expect(harmonicNearStop(5)?.partial).toBe(4)
    expect(harmonicNearStop(4)?.partial).toBe(5)
    expect(harmonicNearStop(2)).toBeNull()
  })
})

describe('fingering', () => {
  it('suggests first-position fingers and accepts any finger in upper positions', () => {
    expect(suggestFinger(0)).toBeNull()
    expect(suggestFinger(2)).toBe('index')
    expect(suggestFinger(4)).toBe('middle')
    expect(suggestFinger(5)).toBe('ring')
    expect(suggestFinger(7)).toBe('pinky')
    expect(allowedFingers(10)).toHaveLength(4)
    expect(allowedFingers(0)).toHaveLength(0)
  })
})

describe('string choice and layouts', () => {
  it('plays notes below the female open string on the male string', () => {
    expect(chooseString(55, DEFAULT_TUNING)).toEqual({ string: 'male', stop: 2, midi: 55 })
    expect(chooseString(60, DEFAULT_TUNING)).toEqual({ string: 'female', stop: 2, midi: 60 })
    expect(chooseString(60, DEFAULT_TUNING, 'male')).toEqual({ string: 'male', stop: 7, midi: 60 })
    expect(chooseString(40, DEFAULT_TUNING)).toBeNull()
  })

  it('matches the playground mockup stops in standard tuning (B♭ diatonic)', () => {
    const names = keyboardLayout(DEFAULT_TUNING, 'diatonic', 8).map((n) => midiToName(n.midi))
    expect(names).toEqual(['F3', 'G3', 'A3', 'Bb3', 'C4', 'D4', 'Eb4', 'F4'])
  })

  it('lists pentatonic stops per string', () => {
    expect(scaleStops(DEFAULT_TUNING.female, 10, 'pentatonic', 12)).toEqual([0, 2, 4, 7, 9, 12])
  })
})
