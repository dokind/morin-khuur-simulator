import { describe, expect, it } from 'vitest'
import { encodeMidi } from './midi'

describe('encodeMidi', () => {
  const bytes = encodeMidi({
    ppq: 96,
    tempoBpm: 120,
    timeSignature: [6, 8],
    tracks: [
      {
        name: 'Kit',
        channel: 9,
        notes: [
          { tick: 0, duration: 24, note: 36, velocity: 100 },
          { tick: 24, duration: 24, note: 36, velocity: 90 }
        ]
      }
    ]
  })
  const text = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n))

  it('writes a format-1 header with a conductor track', () => {
    expect(text(0, 4)).toBe('MThd')
    expect([...bytes.slice(8, 14)]).toEqual([0, 1, 0, 2, 0, 96])
    expect(text(14, 4)).toBe('MTrk')
  })

  it('encodes tempo (500000 µs per quarter) and 6/8', () => {
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(hex).toContain('ff510307a120')
    expect(hex).toContain('ff58040603')
  })

  it('puts the note-off before a repeated note-on at the same tick', () => {
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    // delta 24: note-off 36, then delta 0: note-on 36
    expect(hex).toContain('188924000099245a')
  })
})
