import type { RawSong } from '../notation'

/**
 * Test fixture: an original F-major study for the stage style (written for the tests, not a real
 * song). Four 4-bar phrases ending on half notes; bars 4–7 repeat bars 0–3; bars 8–11 hold the
 * highest long note (the climax); C4 follows A3 by a minor third, which is where an old rule
 * scooped in from the out-of-key B♮; E4 occurs once, as a passing note.
 */
const q = '4n'
const e = '8n'
const h = '2n'

type Row = [time: string, pitch: string, duration: string]

const PHRASE_A: Row[] = [
  ['0:0:0', 'F3', q], ['0:1:0', 'A3', q],
  ['1:0:0', 'C4', q], ['1:1:0', 'Bb3', q],
  ['2:0:0', 'A3', e], ['2:0:2', 'G3', e], ['2:1:0', 'A3', q],
  ['3:0:0', 'F3', h]
]
const shift = (rows: Row[], bars: number): Row[] =>
  rows.map(([time, pitch, duration]) => {
    const [bar, beat, six] = time.split(':')
    return [`${Number(bar) + bars}:${beat}:${six}`, pitch, duration]
  })
const CLIMAX: Row[] = [
  ['8:0:0', 'D4', q], ['8:1:0', 'F4', q],
  ['9:0:0', 'E4', e], ['9:0:2', 'D4', e], ['9:1:0', 'C4', q],
  ['10:0:0', 'D4', q], ['10:1:0', 'Bb3', q],
  ['11:0:0', 'C4', h]
]
const CLOSE: Row[] = [
  ['12:0:0', 'A3', q], ['12:1:0', 'C4', q],
  ['13:0:0', 'Bb3', e], ['13:0:2', 'A3', e], ['13:1:0', 'G3', q],
  ['14:0:0', 'A3', q], ['14:1:0', 'G3', q],
  ['15:0:0', 'F3', h]
]

/** Where each pitch is played in standard F3–B♭3 tuning, first position. */
const PLACE: Record<string, { string: 'male' | 'female'; technique: string; finger: string | null }> = {
  F3: { string: 'male', technique: 'open', finger: null },
  G3: { string: 'male', technique: 'cuticle_side_stop', finger: 'index' },
  A3: { string: 'male', technique: 'cuticle_side_stop', finger: 'middle' },
  Bb3: { string: 'female', technique: 'open', finger: null },
  C4: { string: 'female', technique: 'cuticle_side_stop', finger: 'index' },
  D4: { string: 'female', technique: 'cuticle_side_stop', finger: 'middle' },
  E4: { string: 'female', technique: 'cuticle_side_stop', finger: 'ring' },
  F4: { string: 'female', technique: 'cuticle_side_stop', finger: 'pinky' }
}

const ROWS = [...PHRASE_A, ...shift(PHRASE_A, 4), ...CLIMAX, ...CLOSE]

export const STAGE_ETUDE: RawSong = {
  title: 'Stage Etude in F (test fixture)',
  composer: 'Morin Khuur Simulator contributors',
  source: 'Original test fixture — not a real song.',
  tuning: { maleString: 'F3', femaleString: 'Bb3' },
  key: 'F',
  tempoBpm: 104,
  timeSignature: '2/4',
  notes: ROWS.map(([time, pitch, duration], i) => ({
    time,
    pitch,
    duration,
    ...PLACE[pitch]!,
    bow: i % 2 === 0 ? 'tatakh' : 'tülekhe'
  }))
} as RawSong

/** The fixture's pitches as MIDI numbers, in order. */
export const STAGE_ETUDE_MIDI: number[] = ROWS.map(([, pitch]) => ({ F3: 53, G3: 55, A3: 57, Bb3: 58, C4: 60, D4: 62, E4: 64, F4: 65 })[pitch]!)
