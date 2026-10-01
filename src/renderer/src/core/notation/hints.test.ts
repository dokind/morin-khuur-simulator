import { describe, expect, it } from 'vitest'
import { parseSong } from './parse'
import type { RawSong, RawSongNote } from './types'
import { verifySong } from './verify'

// Performance hints and the tempo map: optional, validated, and invisible to verification.

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

const base = (extra: Record<string, unknown> = {}, notes: unknown[] = [note({}), note({ time: '0:1:0', pitch: 'D4', finger: 'middle', bow: 'tülekhe' })]) =>
  ({ title: 'Hints', tuning: { maleString: 'F3', femaleString: 'Bb3' }, tempoBpm: 90, timeSignature: '4/4', notes, ...extra }) as unknown as RawSong

const warnings = (raw: RawSong) => parseSong(raw).issues.filter((i) => i.severity === 'warning').map((i) => i.code)

describe('performance hints in song files', () => {
  it('parses song-level style, ornament amount, tempo map and frame', () => {
    const { song, issues } = parseSong(
      base({
        style: 'urtiin-duu',
        ornamentAmount: 1.5,
        frame: { open: false, close: true },
        tempoMap: [
          { time: '2:0:0', bpm: 60, ramp: true },
          { time: '1:0:0', bpm: 90 }
        ]
      })
    )
    expect(issues).toEqual([])
    expect(song!.style).toBe('urtiin-duu')
    expect(song!.ornamentAmount).toBe(1.5)
    expect(song!.frame).toEqual({ open: false, close: true })
    // Sorted by time, positions converted to quarter beats.
    expect(song!.tempoMap).toEqual([
      { beats: 4, bpm: 90, ramp: false },
      { beats: 8, bpm: 60, ramp: true }
    ])
  })

  it('parses note-level ornament and vibrato placement', () => {
    const { song, issues } = parseSong(base({}, [note({ ornament: 'trill', vibratoPlacement: 'end' }), note({ time: '0:1:0', ornament: 'none', bow: 'tülekhe' })]))
    expect(issues).toEqual([])
    expect(song!.notes[0]!.ornament).toBe('trill')
    expect(song!.notes[0]!.vibratoPlacement).toBe('end')
    expect(song!.notes[1]!.ornament).toBe('none')
    expect('vibratoPlacement' in song!.notes[1]!).toBe(false)
  })

  it('leaves songs without hints exactly as before', () => {
    const { song } = parseSong(base())
    for (const key of ['style', 'ornamentAmount', 'tempoMap', 'frame']) expect(key in song!).toBe(false)
    for (const n of song!.notes) {
      expect('ornament' in n).toBe(false)
      expect('vibratoPlacement' in n).toBe(false)
    }
  })

  it('warns about bad values and ignores them, without failing the song', () => {
    const raw = base(
      {
        style: 'baroque',
        ornamentAmount: 3,
        frame: { open: 'yes' },
        tempoMap: [{ time: 'bar 2', bpm: 60 }, { time: '1:0:0', bpm: 1000 }, { time: '1:0:0', bpm: 70, ramp: 'slowly' }, { time: '2:0:0', bpm: 70 }]
      },
      [{ ...note({}), ornament: 'wobble', vibratoPlacement: 'middle' }, note({ time: '0:1:0', pitch: 'D4', finger: 'middle', bow: 'tülekhe' })]
    )
    const { song, issues } = parseSong(raw)
    expect(issues.every((i) => i.severity === 'warning')).toBe(true)
    expect(warnings(raw).sort()).toEqual(
      ['bad-frame', 'bad-ornament', 'bad-ornament-amount', 'bad-style', 'bad-tempo-point', 'bad-tempo-point', 'bad-tempo-point', 'bad-vibratoPlacement'].sort()
    )
    expect(song!.notes).toHaveLength(2)
    expect(song!.style).toBeUndefined()
    expect(song!.ornamentAmount).toBeUndefined()
    expect(song!.frame).toBeUndefined()
    expect(song!.tempoMap).toEqual([{ beats: 8, bpm: 70, ramp: false }])
    expect(song!.notes[0]!.ornament).toBeUndefined()
    expect(warnings(base({ tempoMap: 'fast' }))).toEqual(['bad-tempo-map'])
    expect(warnings(base({ ornamentAmount: Number.NaN }))).toEqual(['bad-ornament-amount'])
  })

  it('is ignored by verification', () => {
    const plain = verifySong(parseSong(base()).song!)
    const hinted = verifySong(
      parseSong(
        base({ style: 'tatlaga', ornamentAmount: 0, frame: { open: true }, tempoMap: [{ time: '0:2:0', bpm: 40 }] }, [
          note({ ornament: 'scoop', vibratoPlacement: 'start' }),
          note({ time: '0:1:0', pitch: 'D4', finger: 'middle', bow: 'tülekhe', ornament: 'fall' })
        ])
      ).song!
    )
    const summary = (r: typeof plain) => ({ ...r, checks: r.checks.map(({ note: _note, ...rest }) => rest) })
    expect(summary(hinted)).toEqual(summary(plain))
  })
})
