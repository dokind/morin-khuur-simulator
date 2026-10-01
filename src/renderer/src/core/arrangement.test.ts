import { describe, expect, it } from 'vitest'
import { barSeconds, khoomiiPart, rhythmPart, tovshuurPart, type ArrangementSpec } from './arrangement'

const six: ArrangementSpec = { meter: '6/8', bpm: 120, bars: 2, tonic: 58 }
const four: ArrangementSpec = { meter: '4/4', bpm: 120, bars: 2, tonic: 58 }

describe('arrangement generators', () => {
  it('measures bars in quarter notes (6/8 = 3 quarters)', () => {
    expect(barSeconds(six)).toBeCloseTo(1.5)
    expect(barSeconds(four)).toBeCloseTo(2)
  })

  it('gallops pull–push–push(slurred) in 6/8 on the open strings', () => {
    const notes = rhythmPart(six, { male: 53, female: 58 })
    expect(notes).toHaveLength(12)
    expect(notes.slice(0, 3).map((n) => [n.bow, n.slur])).toEqual([
      ['tatakh', false],
      ['tülekhe', false],
      ['tülekhe', true]
    ])
    expect(new Set(notes.map((n) => n.midi))).toEqual(new Set([53, 58]))
  })

  it('keeps every part inside the arrangement', () => {
    for (const spec of [six, four]) {
      const end = spec.bars * barSeconds(spec) + 1e-9
      for (const n of [...rhythmPart(spec, { male: 53, female: 58 }), ...tovshuurPart(spec)]) expect(n.start + n.duration).toBeLessThanOrEqual(end)
    }
  })

  it('pitches the khöömii drone in a low male register and sings natural overtones', () => {
    const { drone, overtones } = khoomiiPart({ ...four, bars: 8 })
    expect(drone.midi).toBeGreaterThanOrEqual(40)
    expect(drone.midi).toBeLessThanOrEqual(49)
    expect(drone.midi % 12).toBe(58 % 12)
    expect(overtones.every((o) => o.partial >= 6 && o.partial <= 12)).toBe(true)
  })
})
