import { describe, expect, it } from 'vitest'
import { beatsToSeconds, parseSong, type Song } from '../notation'
import { songClock } from './tempo'

const song = (tempoMap?: unknown): Song =>
  parseSong({ title: 'T', tuning: { maleString: 'F3', femaleString: 'Bb3' }, tempoBpm: 120, timeSignature: '4/4', notes: [], ...(tempoMap ? { tempoMap } : {}) }).song!

describe('song clock', () => {
  it('is plain beats-to-seconds without a tempo map', () => {
    const clock = songClock(song(), 90)
    for (const b of [0, 1, 3.5, 17]) expect(clock.seconds(b)).toBe(beatsToSeconds(b, 90))
    expect(clock.bpmAt(5)).toBe(90)
  })

  it('jumps to a new tempo', () => {
    const clock = songClock(song([{ time: '1:0:0', bpm: 60 }]))
    expect(clock.seconds(4)).toBeCloseTo(2) // one bar at 120
    expect(clock.seconds(6)).toBeCloseTo(4) // then two beats at 60
    expect(clock.bpmAt(3.9)).toBe(120)
    expect(clock.bpmAt(4)).toBe(60)
  })

  it('ramps linearly per beat, integrating 60 / tempo', () => {
    const clock = songClock(song([{ time: '1:0:0', bpm: 120 }, { time: '2:0:0', bpm: 60, ramp: true }]))
    // ∫ 60 / (120 − 15 b) db over 4 beats = 4 ln 2
    expect(clock.seconds(8) - clock.seconds(4)).toBeCloseTo(4 * Math.log(2), 9)
    expect(clock.bpmAt(6)).toBeCloseTo(90)
    expect(clock.seconds(9) - clock.seconds(8)).toBeCloseTo(1) // held at 60 afterwards
    // Monotonic throughout.
    let last = -Infinity
    for (let b = 0; b <= 12; b += 0.25) {
      expect(clock.seconds(b)).toBeGreaterThan(last)
      last = clock.seconds(b)
    }
  })

  it('scales the whole map with the practice tempo', () => {
    const map = [{ time: '1:0:0', bpm: 60 }]
    expect(songClock(song(map), 60).seconds(6)).toBeCloseTo(2 * songClock(song(map), 120).seconds(6))
  })
})
