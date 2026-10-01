import { describe, expect, it } from 'vitest'
import { MAX_STOP, TUNINGS } from '../instrument'
import { arrangeMelody, type MelodyInput, type MelodyNote } from './melody'
import { parseSong } from './parse'
import { parseDuration, parseTimeSignature, quartersPerBar } from './timing'
import type { RawSong } from './types'
import { verifySong } from './verify'

const melody = (notes: Partial<MelodyNote>[], extra: Partial<MelodyInput> = {}): MelodyInput => {
  let t = 0
  return {
    title: 'Test tune',
    tempoBpm: 100,
    timeSignature: { beats: 4, unit: 4 },
    keyPc: null,
    notes: notes.map((n) => {
      const note = { startBeats: t, durationBeats: 1, midi: 60, velocity: 0.8, slur: false, ...n }
      t = note.startBeats + note.durationBeats
      return note
    }),
    ...extra
  }
}

/** Parses and verifies; returns the verifier's errors (expected to be empty). */
const errorsOf = (raw: RawSong) => {
  const { song, issues } = parseSong(JSON.parse(JSON.stringify(raw)))
  const parseErrors = issues.filter((i) => i.severity === 'error')
  if (!song) return parseErrors
  const report = verifySong(song)
  return [...parseErrors, ...report.songIssues, ...report.checks.flatMap((c) => c.issues)].filter((i) => i.severity === 'error')
}

const warningsOf = (raw: RawSong) => {
  const report = verifySong(parseSong(raw).song!)
  return report.checks.flatMap((c) => c.issues).filter((i) => i.severity === 'warning')
}

/** Deterministic PRNG so the fuzz cases are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('arrangeMelody', () => {
  it('assigns strings, techniques, fingers and alternating bows', () => {
    // F3 G3 A3 Bb3 C4 D4 — the first-position scale from the bundled etude.
    const { raw, messages } = arrangeMelody(melody([53, 55, 57, 58, 60, 62].map((midi) => ({ midi }))))
    expect(messages).toEqual([])
    expect(raw.notes.map((n) => [n.time, n.pitch, n.duration, n.string, n.technique, n.finger, n.bow])).toEqual([
      ['0:0:0', 'F3', '4n', 'male', 'open', null, 'tatakh'],
      ['0:1:0', 'G3', '4n', 'male', 'cuticle_side_stop', 'index', 'tülekhe'],
      ['0:2:0', 'A3', '4n', 'male', 'cuticle_side_stop', 'middle', 'tatakh'],
      ['0:3:0', 'Bb3', '4n', 'female', 'open', null, 'tülekhe'],
      ['1:0:0', 'C4', '4n', 'female', 'cuticle_side_stop', 'index', 'tatakh'],
      ['1:1:0', 'D4', '4n', 'female', 'cuticle_side_stop', 'middle', 'tülekhe']
    ])
    expect(errorsOf(raw)).toEqual([])
    expect(warningsOf(raw)).toEqual([])
  })

  it('fills song-level fields and marks the arrangement as automatic', () => {
    const { raw } = arrangeMelody(melody([{ midi: 60 }], { keyPc: 7, composer: 'Trad.' }), { source: 'tune.mid (MIDI)' })
    expect(raw.title).toBe('Test tune')
    expect(raw.composer).toBe('Trad.')
    expect(raw.key).toBe('G')
    expect(raw.tuning).toEqual({ maleString: 'F3', femaleString: 'Bb3' })
    expect(raw.tempoBpm).toBe(100)
    expect(raw.timeSignature).toBe('4/4')
    expect(raw.source).toMatch(/auto-arranged/i)
    expect(raw.source).toContain('tune.mid (MIDI)')
    expect(arrangeMelody(melody([{ midi: 60 }], { title: '  ' })).raw.title).toBe('Imported melody')
  })

  it('transposes by octaves to fit and folds the stragglers', () => {
    // C3..C4 is mostly below F3: one octave up fits everything.
    const up = arrangeMelody(melody([48, 50, 52, 53, 55, 60].map((midi) => ({ midi }))))
    expect(up.raw.notes.map((n) => n.pitch)).toEqual(['C4', 'D4', 'E4', 'F4', 'G4', 'C5'])
    expect(up.messages.join(' ')).toMatch(/Transposed up 1 octave/)

    // Wider than two octaves: shift for the majority, fold the outliers one by one (B6 folds to B4
    // whether the female string reaches F5 or B♭5).
    const wide = arrangeMelody(melody([40, 53, 60, 65, 72, 77, 95].map((midi) => ({ midi }))))
    expect(wide.raw.notes.map((n) => n.pitch)).toEqual(['E4', 'F3', 'C4', 'F4', 'C5', 'F5', 'B4'])
    expect(wide.messages.join(' ')).toMatch(/Moved 2 notes by octaves/)
    expect(errorsOf(up.raw)).toEqual([])
    expect(errorsOf(wide.raw)).toEqual([])
  })

  it('keeps the top note of chords and truncates overlaps', () => {
    const input: MelodyInput = {
      ...melody([]),
      notes: [
        // chord C4-E4-G4 → G4
        { startBeats: 0, durationBeats: 1, midi: 60, velocity: 0.8, slur: false },
        { startBeats: 0, durationBeats: 1, midi: 64, velocity: 0.8, slur: false },
        { startBeats: 0.01, durationBeats: 1, midi: 67, velocity: 0.8, slur: false },
        // held A4 with a lower note under it → the lower note goes
        { startBeats: 1, durationBeats: 2, midi: 69, velocity: 0.8, slur: false },
        { startBeats: 1.5, durationBeats: 0.5, midi: 62, velocity: 0.8, slur: false },
        // higher note entering while the A4 is held → A4 is cut at its start
        { startBeats: 2, durationBeats: 1, midi: 72, velocity: 0.8, slur: false },
        // legato overlap on a descending line → the earlier note is cut
        { startBeats: 3, durationBeats: 1.1, midi: 70, velocity: 0.8, slur: false },
        { startBeats: 4, durationBeats: 1, midi: 67, velocity: 0.8, slur: false }
      ]
    }
    const { raw, messages } = arrangeMelody(input)
    expect(raw.notes.map((n) => [n.time, n.pitch, n.duration])).toEqual([
      ['0:0:0', 'G4', '4n'],
      ['0:1:0', 'A4', '4n'],
      ['0:2:0', 'C5', '4n'],
      ['0:3:0', 'Bb4', '4n'],
      ['1:0:0', 'G4', '4n']
    ])
    expect(messages.join(' ')).toMatch(/top note of each chord/)
    expect(messages.join(' ')).toMatch(/lower note sounding under/)
    expect(errorsOf(raw)).toEqual([])
  })

  it('slurs keep the bow, rests of half a beat restart with tatakh', () => {
    const { raw } = arrangeMelody(
      melody([
        { midi: 60 },
        { midi: 62, slur: true },
        { midi: 64 },
        { midi: 65, startBeats: 3.5 }, // half-beat rest after E4 (ends at 3)
        { midi: 67 },
        { midi: 69, startBeats: 5.75 } // quarter-beat rest after G4 (ends at 5.5): keep alternating
      ])
    )
    expect(raw.notes.map((n) => [n.bow, n.slur ?? false])).toEqual([
      ['tatakh', false],
      ['tatakh', true],
      ['tülekhe', false],
      ['tatakh', false],
      ['tülekhe', false],
      ['tatakh', false]
    ])
    expect(warningsOf(raw)).toEqual([])
  })

  it('ignores a slur on the first note', () => {
    const { raw } = arrangeMelody(melody([{ midi: 60, slur: true }, { midi: 62 }]))
    expect(raw.notes[0]!.slur).toBeUndefined()
    expect(raw.notes.map((n) => n.bow)).toEqual(['tatakh', 'tülekhe'])
  })

  it('quantises to sixteenths and triplets with single duration tokens', () => {
    const { raw } = arrangeMelody(
      melody([
        { midi: 60, durationBeats: 1.5 },
        { midi: 62, durationBeats: 0.5 },
        { midi: 64, durationBeats: 1 / 3 },
        { midi: 65, durationBeats: 1 / 3 },
        { midi: 67, durationBeats: 1 / 3 },
        { midi: 69, durationBeats: 0.75 },
        { midi: 70, durationBeats: 0.25 },
        { midi: 72, durationBeats: 3.02 }, // slightly humanised
        { midi: 70, durationBeats: 8 }
      ])
    )
    expect(raw.notes.map((n) => [n.time, n.duration])).toEqual([
      ['0:0:0', '4n.'],
      ['0:1:2', '8n'],
      ['0:2:0', '8t'],
      ['0:2:1.333333', '8t'],
      ['0:2:2.666667', '8t'],
      ['0:3:0', '8n.'],
      ['0:3:3', '16n'],
      ['1:0:0', '2n.'],
      ['1:3:0', '2m']
    ])
    expect(errorsOf(raw)).toEqual([])
    expect(warningsOf(raw)).toEqual([])
  })

  it('never lengthens a note into the next one', () => {
    // 1.25 beats has no single token: it becomes a quarter, not a dotted quarter.
    const { raw } = arrangeMelody(melody([{ midi: 60, durationBeats: 1.25 }, { midi: 62 }]))
    expect(raw.notes[0]!.duration).toBe('4n')
    expect(errorsOf(raw)).toEqual([])
  })

  it('lengthens very short notes, drops notes with no room and trims empty leading bars', () => {
    const input = melody([
      { midi: 60, startBeats: 8, durationBeats: 0.05 }, // staccato with half a beat of room → a 16th
      { midi: 62, startBeats: 8.5 },
      { midi: 64, startBeats: 9.5, durationBeats: 0.03 }, // snaps onto the next onset → dropped
      { midi: 65, startBeats: 9.53 }
    ])
    const { raw, messages } = arrangeMelody(input)
    expect(raw.notes.map((n) => [n.time, n.pitch, n.duration])).toEqual([
      ['0:0:0', 'C4', '16n'],
      ['0:0:2', 'D4', '4n'],
      ['0:1:2', 'F4', '4n']
    ])
    expect(messages.join(' ')).toMatch(/Lengthened 1 very short note/)
    expect(messages.join(' ')).toMatch(/Dropped 1 note starting less than a 32nd before the next one/)
    expect(messages.join(' ')).toMatch(/Removed 2 empty bars/)
    expect(errorsOf(raw)).toEqual([])
  })

  it('sanitises unsupported tempo and time signature', () => {
    const { raw, messages } = arrangeMelody(melody([{ midi: 60 }], { tempoBpm: 1000, timeSignature: { beats: 4, unit: 32 } }))
    expect(raw.tempoBpm).toBe(400)
    expect(raw.timeSignature).toBe('4/4')
    expect(messages).toHaveLength(2)
    expect(errorsOf(raw)).toEqual([])
  })

  it('handles an empty melody', () => {
    const { raw, messages } = arrangeMelody(melody([]))
    expect(raw.notes).toEqual([])
    expect(messages).toContain('The melody has no notes.')
    expect(errorsOf(raw)).toEqual([])
  })

  it('respects another tuning', () => {
    const folk = TUNINGS.find((t) => t.id === 'folk')!
    const { raw } = arrangeMelody(melody([48, 55, 60, 74].map((midi) => ({ midi }))), { tuning: folk })
    expect(raw.tuning).toEqual({ maleString: 'C3', femaleString: 'G3' })
    expect(raw.notes.map((n) => [n.pitch, n.string, n.technique])).toEqual([
      ['C3', 'male', 'open'],
      ['G3', 'female', 'open'],
      ['C4', 'female', 'cuticle_side_stop'],
      ['D5', 'female', 'cuticle_side_stop']
    ])
    expect(errorsOf(raw)).toEqual([])
  })

  describe('always produces songs that verify without errors', () => {
    const cases: [string, MelodyInput][] = [
      ['below F3 and above F5', melody([30, 41, 50, 53, 77, 80, 96, 100, 58, 64].map((midi) => ({ midi, durationBeats: 0.5 })))],
      ['6/8 with triplets', melody([60, 62, 64, 65, 67, 69].map((midi, i) => ({ midi, durationBeats: i % 2 ? 1 / 3 : 2 / 3 })), { timeSignature: { beats: 6, unit: 8 } })],
      ['5/4 long notes', melody([60, 72, 84].map((midi) => ({ midi, durationBeats: 5 })), { timeSignature: { beats: 5, unit: 4 } })]
    ]
    const random = rng(42)
    for (let k = 0; k < 40; k++) {
      const notes: MelodyNote[] = []
      const count = 1 + Math.floor(random() * 60)
      for (let i = 0; i < count; i++) {
        notes.push({
          startBeats: random() * 32,
          durationBeats: 0.02 + random() * random() * 4,
          midi: 24 + Math.floor(random() * 84),
          velocity: random(),
          slur: random() < 0.3
        })
      }
      const ts = [
        { beats: 4, unit: 4 },
        { beats: 3, unit: 4 },
        { beats: 6, unit: 8 },
        { beats: 7, unit: 8 }
      ][k % 4]!
      cases.push([`random #${k + 1} (${ts.beats}/${ts.unit})`, { ...melody([]), timeSignature: ts, notes }])
    }

    it.each(cases)('%s', (_, input) => {
      const { raw } = arrangeMelody(input)
      expect(errorsOf(raw)).toEqual([])
      const { song } = parseSong(raw)
      for (const n of song!.notes) {
        expect(n.pitch).toBeGreaterThanOrEqual(53)
        expect(n.pitch).toBeLessThanOrEqual(58 + MAX_STOP)
      }
      for (let i = 1; i < song!.notes.length; i++) {
        const [a, b] = [song!.notes[i - 1]!, song!.notes[i]!]
        expect(a.startBeats + a.durationBeats).toBeLessThanOrEqual(b.startBeats + 1e-6)
      }
    })
  })
})

const note = (startBeats: number, durationBeats: number, midi = 60, slur = false): MelodyNote => ({ startBeats, durationBeats, midi, velocity: 0.8, slur })
const timeline = (raw: RawSong) => raw.notes.map((n) => [n.time, n.duration])

describe('arrangeMelody quantisation', () => {
  it('keeps every note of a 32nd run and of dotted-16th/32nd figures in notated input', () => {
    const run = arrangeMelody(melody([], { notes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => note(i / 8, 1 / 8, 60 + i)) }))
    expect(timeline(run.raw)).toEqual(['0', '0.5', '1', '1.5', '2', '2.5', '3', '3.5'].map((s) => [`0:0:${s}`, '32n']))
    expect(run.messages).toEqual([])

    const dotted = arrangeMelody(melody([], { notes: [note(0, 0.375, 60), note(0.375, 0.125, 62), note(0.5, 0.375, 64), note(0.875, 0.125, 65), note(1, 1, 67)] }))
    expect(timeline(dotted.raw)).toEqual([
      ['0:0:0', '16n.'],
      ['0:0:1.5', '32n'],
      ['0:0:2', '16n.'],
      ['0:0:3.5', '32n'],
      ['0:1:0', '4n']
    ])
    expect(errorsOf(run.raw)).toEqual([])
    expect(errorsOf(dotted.raw)).toEqual([])
  })

  it('snaps played (unquantised) timing to the coarser 1/12-beat grid', () => {
    const { raw } = arrangeMelody(melody([], { notes: [note(0.02, 0.45, 60), note(0.49, 0.5, 62), note(1.03, 0.3, 64), note(1.35, 0.6, 65)] }))
    expect(timeline(raw)).toEqual([
      ['0:0:0', '8n'],
      ['0:0:2', '8n'],
      ['0:1:0', '8t'],
      ['0:1:1.333333', '4t']
    ])
    expect(errorsOf(raw)).toEqual([])
  })

  it('keeps staccato and 1-tick notes as detached 16ths instead of dropping them', () => {
    // A MIDI performance of staccato eighths: each note sounds for 2% of a beat.
    const { raw, messages } = arrangeMelody(melody([], { notes: [0, 1, 2, 3, 4, 5].map((i) => note(i / 2, 0.02, 60 + i)) }))
    expect(raw.notes).toHaveLength(6)
    expect(raw.notes.every((n) => n.duration === '16n')).toBe(true)
    expect(messages.join(' ')).toMatch(/Lengthened 6 very short notes/)
    expect(errorsOf(raw)).toEqual([])
    // With less room than a 16th the note takes the room it has.
    expect(timeline(arrangeMelody(melody([], { notes: [note(0, 0.01), note(0.125, 1, 62)] })).raw)[0]).toEqual(['0:0:0', '32n'])
  })

  it('writes six beats as a dotted whole and long notes as whole bars', () => {
    expect(timeline(arrangeMelody(melody([{ durationBeats: 6 }, { midi: 62 }])).raw)).toEqual([
      ['0:0:0', '1n.'],
      ['1:2:0', '4n']
    ])
    const started = performance.now()
    const long = arrangeMelody(melody([{ durationBeats: 40_000 }]))
    expect(performance.now() - started).toBeLessThan(200)
    expect(long.raw.notes[0]!.duration).toBe('10000m')
    // A bar count that overshoots the next note is never chosen.
    expect(timeline(arrangeMelody(melody([{ durationBeats: 10 }, { midi: 62, startBeats: 9 }])).raw)[0]).toEqual(['0:0:0', '2m'])
  })

  it('caps absurdly long songs so positions keep their precision', () => {
    const { raw, messages } = arrangeMelody(melody([], { notes: [note(0, 1), note(4, 1e9, 62), note(2e6, 1, 64)] }))
    expect(raw.notes.map((n) => n.pitch)).toEqual(['C4', 'D4'])
    expect(messages.join(' ')).toMatch(/Dropped 1 note starting more than 1,000,000 beats in/)
    expect(errorsOf(raw)).toEqual([])
  })
})

describe('arrangeMelody input validation', () => {
  it('ignores notes with unusable timing or pitch and clips notes starting before zero', () => {
    const { raw, messages } = arrangeMelody(
      melody([], {
        notes: [
          note(NaN, 1),
          note(0, 0),
          note(0, -1),
          note(0, Infinity),
          note(1e308, 1e308),
          note(-3, 1), // ends at -2: nothing left to play
          note(-0.5, 1.5, 62), // sounds from 0 to 1
          note(1, 1, NaN),
          note(1, 1, 200),
          note(1, 1, 1e12),
          note(1, 1, 64)
        ]
      })
    )
    expect(raw.notes.map((n) => [n.time, n.pitch, n.duration])).toEqual([
      ['0:0:0', 'D4', '4n'],
      ['0:1:0', 'E4', '4n']
    ])
    expect(messages).toContain('Ignored 6 notes without a usable start time or duration.')
    expect(messages).toContain('Ignored 3 notes outside the MIDI pitch range.')
  })

  it('never echoes NaN into messages', () => {
    const { raw, messages } = arrangeMelody(melody([{ midi: 60 }], { tempoBpm: NaN, timeSignature: { beats: NaN, unit: 4 } }), { tuning: { male: NaN, female: 60 } })
    expect(raw.tempoBpm).toBe(90)
    expect(raw.timeSignature).toBe('4/4')
    expect(messages.join(' ')).not.toMatch(/NaN/)
    expect(messages.join(' ')).toMatch(/time signature is unreadable/)
    expect(messages.join(' ')).toMatch(/Tuning \?\/60 is not usable/)
  })

  it('falls back to the standard tuning when the requested one is unusable', () => {
    for (const tuning of [
      { male: 60, female: 55 },
      { male: 60, female: 60 },
      { male: 52.5, female: 58 },
      { male: -1, female: 58 }
    ]) {
      const { raw, messages } = arrangeMelody(melody([{ midi: 60 }]), { tuning })
      expect(raw.tuning).toEqual({ maleString: 'F3', femaleString: 'Bb3' })
      expect(messages.join(' ')).toMatch(/not usable/)
      expect(errorsOf(raw)).toEqual([])
    }
  })

  it('folds notes out of the gap between widely spaced strings', () => {
    // Male E2 reaches B3 (19 semitones); female Bb4 starts well above, so C4..A4 are unreachable as written.
    const { raw } = arrangeMelody(melody([48, 60, 62, 64, 66, 68, 70, 72].map((midi) => ({ midi }))), { tuning: { male: 40, female: 70 } })
    const { song } = parseSong(raw)
    for (const n of song!.notes) {
      const open = n.string === 'female' ? 70 : 40
      expect(n.pitch! - open).toBeGreaterThanOrEqual(0)
      expect(n.pitch! - open).toBeLessThanOrEqual(MAX_STOP)
    }
    expect(errorsOf(raw)).toEqual([])
  })
})

describe('arrangeMelody property: any input verifies and keeps its onsets', () => {
  const TOKENS = [6, 4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.125, 4 / 3, 2 / 3, 1 / 3, 1 / 6]
  const UNITS = [1, 2, 4, 8, 16]

  function generate(seed: number) {
    const random = rng(seed)
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!
    const style = seed % 5
    const notes: MelodyNote[] = []
    let t = random() < 0.3 ? random() * 40 : 0
    const count = 1 + Math.floor(random() * (style === 4 ? 300 : 60))
    for (let i = 0; i < count; i++) {
      let start: number
      let duration: number
      if (style === 0) {
        // dense random polyphony
        start = random() * 12
        duration = random() * random() * 3 + 1e-4
      } else if (style === 1) {
        // notated line: tokens, occasional 32nd / 1/24 offsets and chords
        const d = pick(TOKENS)
        start = t
        duration = d * (random() < 0.2 ? 0.5 : 1)
        t += pick([d, d, d, 1 / 8, 1 / 24, 0])
      } else if (style === 2) {
        // played line with timing jitter and staccato
        const d = pick([0.25, 0.5, 1, 1 / 3])
        start = Math.max(0, t + (random() - 0.5) * 0.08)
        duration = d * (0.05 + random())
        t += d
      } else if (style === 3) {
        // block chords and overlapping voices
        start = Math.floor(random() * 32) * pick([0.25, 1 / 3, 0.5, 1]) + (random() < 0.3 ? random() * 0.05 : 0)
        duration = pick(TOKENS) * 2 * random() + 1e-3
      } else {
        // long dense tune on the fine grid
        start = Math.floor(random() * 3000) / 24
        duration = Math.floor(1 + random() * 48) / 24
      }
      notes.push({ startBeats: start, durationBeats: duration, midi: Math.floor(random() * 128), velocity: random(), slur: random() < 0.3 })
    }
    const custom = () => {
      const male = Math.floor(random() * 100)
      return { male, female: male + 1 + Math.floor(random() * 27) }
    }
    const tuning = random() < 0.5 ? undefined : random() < 0.6 ? pick(TUNINGS) : custom()
    const timeSignature = random() < 0.95 ? { beats: 1 + Math.floor(random() * 99), unit: pick(UNITS) } : { beats: 4, unit: 3 }
    return { input: { ...melody([]), timeSignature, keyPc: pick([null, 0, 2, 7, 10]), tempoBpm: pick([20, 90, 400, 13, 999]), notes }, tuning }
  }

  it.each(Array.from({ length: 250 }, (_, i) => i + 1))('seed %i', (seed) => {
    const { input, tuning } = generate(seed)
    const { raw, messages } = arrangeMelody(input, { tuning })
    expect(errorsOf(raw)).toEqual([])
    expect(messages.join(' ')).not.toMatch(/NaN|undefined|Infinity/)

    const ts = parseTimeSignature(raw.timeSignature)!
    const perBar = quartersPerBar(ts)
    const song = parseSong(raw).song!
    const out = song.notes.map((n) => ({ start: n.startBeats, length: n.durationBeats, pitch: n.pitch! }))
    for (const [i, n] of out.entries()) {
      // On the 1/24-beat grid, one token long, never running into the next note.
      expect(Math.abs(n.start * 24 - Math.round(n.start * 24))).toBeLessThan(1e-4)
      expect(n.length).toBeGreaterThan(0)
      if (i + 1 < out.length) expect(n.start + n.length).toBeLessThanOrEqual(out[i + 1]!.start + 1e-6)
    }
    for (const n of raw.notes) expect(parseDuration(n.duration, ts)).not.toBeNull()
    // Every output note comes from an input note within half a grid step (after trimming whole
    // leading bars), with the same pitch class.
    const minStart = Math.min(...input.notes.map((n) => n.startBeats))
    const shifts = [...new Set([Math.floor(minStart / perBar + 1e-9), Math.floor((minStart + 1 / 24) / perBar + 1e-9)])].map((k) => k * perBar)
    const fromInput = (shift: number) =>
      out.every((o) => input.notes.some((n) => Math.abs(n.startBeats - shift - o.start) <= 1 / 24 + 1e-6 && (((n.midi - o.pitch) % 12) + 12) % 12 === 0))
    expect(shifts.some(fromInput)).toBe(true)
    expect(out.length).toBeGreaterThan(0)
  })
})
