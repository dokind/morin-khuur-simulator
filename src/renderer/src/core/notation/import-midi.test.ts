import { describe, expect, it } from 'vitest'
import { encodeMidi, type MidiNote } from '../midi'
import { midiMelodyCandidates, midiToMelody, parseMidi } from './import-midi'
import { arrangeMelody } from './melody'
import { parseSong } from './parse'
import { verifySong } from './verify'

const PPQ = 480
const seq = (pitches: number[], step = PPQ, velocity = 100): MidiNote[] =>
  pitches.map((note, i) => ({ tick: i * step, duration: step, note, velocity }))

const multiTrack = encodeMidi({
  ppq: PPQ,
  tempoBpm: 100,
  timeSignature: [3, 4],
  tracks: [
    { name: 'Drums', channel: 9, notes: seq(Array(12).fill(36), PPQ / 2) },
    { name: 'Bass', channel: 1, program: 32, notes: seq([41, 36, 41], PPQ * 2) },
    { name: 'Melody', channel: 0, program: 73, notes: seq([65, 67, 69, 70, 72, 74], PPQ, 90) }
  ]
})

/** Wraps raw track event bytes in an SMF container. */
function smf(format: number, ppq: number, tracks: number[][]): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0))
  return new Uint8Array([
    ...text('MThd'),
    ...u32(6),
    0,
    format,
    0,
    tracks.length,
    (ppq >> 8) & 0xff,
    ppq & 0xff,
    ...tracks.flatMap((t) => [...text('MTrk'), ...u32(t.length), ...t])
  ])
}

// Format 0, PPQ 96: running status, velocity-0 note-offs, a drum channel and a tempo change.
const formatZero = smf(0, 96, [
  [
    0x00, 0xff, 0x03, 0x04, ...[...'Tune'].map((c) => c.charCodeAt(0)),
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 120 BPM
    0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08, // 3/4
    0x00, 0xff, 0x59, 0x02, 0xff, 0x00, // one flat: F major
    0x00, 0xc0, 0x49,
    0x00, 0x90, 0x3c, 0x64, // C4 on
    0x60, 0x3c, 0x00, // (running status) C4 off after 96 ticks
    0x00, 0x3e, 0x50, // D4 on
    0x30, 0x3e, 0x00, // D4 off after 48
    0x00, 0x99, 0x24, 0x64, // kick on, channel 10
    0x00, 0x90, 0x40, 0x46, // E4 on
    0x18, 0x89, 0x24, 0x00, // kick off (note-off status)
    0x00, 0xff, 0x51, 0x03, 0x06, 0x1a, 0x80, // tempo change to 150 BPM
    0x48, 0x80, 0x40, 0x00, // E4 off at +96 in total
    0x00, 0x90, 0x41, 0x60, // F4 on, never released
    0x60, 0xff, 0x2f, 0x00
  ]
])

describe('parseMidi', () => {
  it('reads a format-0 file with running status and velocity-0 note-offs', () => {
    const file = parseMidi(formatZero)
    expect(file.format).toBe(0)
    expect(file.ppq).toBe(96)
    expect(file.tempoBpm).toBe(120)
    expect(file.tempoChanges).toBe(2)
    expect(file.timeSignature).toEqual({ beats: 3, unit: 4 })
    expect(file.keyFifths).toBe(-1)
    expect(file.tracks).toHaveLength(1)
    const [track] = file.tracks
    expect(track!.name).toBe('Tune')
    expect(track!.notes.map((n) => [n.channel, n.midi, n.tick, n.durationTicks, n.velocity])).toEqual([
      [0, 60, 0, 96, 100],
      [0, 62, 96, 48, 80],
      [9, 36, 144, 24, 100],
      [0, 64, 144, 96, 70],
      [0, 65, 240, 96, 96]
    ])
    expect(track!.notes[1]!.startBeats).toBe(1)
    expect(track!.notes[1]!.durationBeats).toBe(0.5)
  })

  it('reads format-1 files written by encodeMidi', () => {
    const file = parseMidi(multiTrack)
    expect(file.format).toBe(1)
    expect(file.ppq).toBe(PPQ)
    expect(file.tempoBpm).toBe(100)
    expect(file.timeSignature).toEqual({ beats: 3, unit: 4 })
    expect(file.tracks.map((t) => [t.name, t.notes.length])).toEqual([
      ['', 0],
      ['Drums', 12],
      ['Bass', 3],
      ['Melody', 6]
    ])
    expect(midiMelodyCandidates(file).map((c) => [c.track, c.channel, c.notes])).toEqual([
      [3, 0, 6],
      [2, 1, 3]
    ])
  })

  it('matches repeated notes first-in first-out', () => {
    const file = parseMidi(smf(0, 96, [[0x00, 0x90, 60, 100, 0x10, 0x90, 60, 90, 0x10, 0x80, 60, 0, 0x10, 0x80, 60, 0, 0x00, 0xff, 0x2f, 0x00]]))
    expect(file.tracks[0]!.notes.map((n) => [n.tick, n.durationTicks, n.velocity])).toEqual([
      [0, 32, 100],
      [16, 32, 90]
    ])
  })

  it('decodes Latin-1 track names', () => {
    const file = parseMidi(smf(1, 96, [[0x00, 0xff, 0x03, 0x04, 0x43, 0x61, 0x66, 0xe9, 0x00, 0xff, 0x2f, 0x00]]))
    expect(file.tracks[0]!.name).toBe('Café')
  })

  it('rejects data that is not MIDI', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/Not a Standard MIDI File/)
  })

  it('keeps the notes of a truncated track', () => {
    const cut = formatZero.slice(0, formatZero.length - 20)
    const notes = parseMidi(cut).tracks[0]!.notes
    expect(notes.slice(0, 2).map((n) => n.midi)).toEqual([60, 62])
  })
})

describe('midiToMelody', () => {
  it('picks the busiest non-percussion part', () => {
    const melody = midiToMelody(multiTrack)
    expect(melody.title).toBe('')
    expect(melody.tempoBpm).toBe(100)
    expect(melody.timeSignature).toEqual({ beats: 3, unit: 4 })
    expect(melody.keyPc).toBeNull()
    expect(melody.notes.map((n) => [n.startBeats, n.durationBeats, n.midi, n.slur])).toEqual([
      [0, 1, 65, false],
      [1, 1, 67, false],
      [2, 1, 69, false],
      [3, 1, 70, false],
      [4, 1, 72, false],
      [5, 1, 74, false]
    ])
    expect(melody.notes[0]!.velocity).toBeCloseTo(90 / 127)
    expect(melody.messages?.[0]).toMatch(/"Melody".*ignored 1 other part/)
  })

  it('honours the track and title options', () => {
    const bass = midiToMelody(multiTrack, { track: 2, title: 'Bass line' })
    expect(bass.title).toBe('Bass line')
    expect(bass.notes.map((n) => n.midi)).toEqual([41, 36, 41])
    expect(midiToMelody(multiTrack, { track: 1 }).notes).toEqual([])
    expect(() => midiToMelody(multiTrack, { track: 9 })).toThrow(/no track 9/)
  })

  it('reads title, key and tempo changes from a format-0 file', () => {
    const melody = midiToMelody(formatZero)
    expect(melody.title).toBe('Tune')
    expect(melody.keyPc).toBe(5)
    expect(melody.notes.map((n) => n.midi)).toEqual([60, 62, 64, 65])
    expect(melody.messages?.join(' ')).toMatch(/changes tempo 1 time/)
  })

  it('arranges into a song that verifies without errors', () => {
    const low = encodeMidi({ ppq: 96, tempoBpm: 72, tracks: [{ name: 'Low tune', channel: 0, notes: seq([36, 38, 40, 43, 45, 48, 91], 48) }] })
    for (const bytes of [multiTrack, formatZero, low]) {
      const { raw } = arrangeMelody(midiToMelody(bytes), { source: 'test.mid (MIDI)' })
      const { song, issues } = parseSong(raw)
      expect(issues.filter((i) => i.severity === 'error')).toEqual([])
      expect(verifySong(song!).errors).toBe(0)
      expect(raw.notes.length).toBeGreaterThan(0)
    }
  })
})

const EOT = [0x00, 0xff, 0x2f, 0x00]
const noteList = (bytes: Uint8Array) => parseMidi(bytes).tracks.map((t) => t.notes.map((n) => [n.tick, n.durationTicks, n.midi, n.channel]))
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

describe('parseMidi robustness', () => {
  it('keeps running status across meta and SysEx (F0 and F7) events', () => {
    const track = [
      0x00, 0x90, 60, 100,
      0x00, 0xff, 0x01, 0x02, 0x41, 0x42, // text meta between
      0x30, 60, 0, // running-status note-off
      0x00, 0xf0, 0x03, 0x7e, 0x09, 0xf7, // SysEx
      0x00, 62, 100, // running-status note-on
      0x00, 0xf7, 0x02, 0x43, 0x10, // SysEx escape
      0x30, 62, 0,
      ...EOT
    ]
    expect(noteList(smf(0, 96, [track]))).toEqual([
      [
        [0, 48, 60, 0],
        [48, 48, 62, 0]
      ]
    ])
  })

  it('skips stray system real-time / common bytes without losing the running status', () => {
    const track = [0x00, 0x90, 60, 100, 0x00, 0xf8, 0x0a, 62, 100, 0x00, 0xf2, 0x01, 0x02, 0x0a, 60, 0, 0x00, 62, 0, ...EOT]
    expect(noteList(smf(0, 96, [track]))).toEqual([
      [
        [0, 20, 60, 0],
        [10, 10, 62, 0]
      ]
    ])
  })

  it('masks corrupt data bytes instead of letting them change the channel', () => {
    const [notes] = noteList(smf(0, 96, [[0x00, 0x92, 0xbc, 0x40, 0x10, 0x82, 0x3c, 0x00, ...EOT]]))
    expect(notes).toEqual([[0, 16, 60, 2]])
  })

  it('reads zero-length tracks, skips unknown chunks and ignores a wrong track count', () => {
    const tracks = [[], [0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0, ...EOT]]
    const bytes = new Uint8Array([
      ...ascii('MThd'), ...u32be(6), 0, 1, 0, 1 /* claims one track */, 0, 96,
      ...ascii('MTrk'), ...u32be(0),
      ...ascii('XFIH'), ...u32be(3), 1, 2, 3,
      ...ascii('MTrk'), ...u32be(tracks[1]!.length), ...tracks[1]!
    ])
    expect(noteList(bytes)).toEqual([[], [[0, 96, 60, 0]]])
  })

  it('handles header lengths other than 6', () => {
    const track = [0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0, ...EOT]
    const body = [...ascii('MTrk'), ...u32be(track.length), ...track]
    const long = new Uint8Array([...ascii('MThd'), ...u32be(10), 0, 0, 0, 1, 0, 96, 9, 9, 9, 9, ...body])
    const short = new Uint8Array([...ascii('MThd'), ...u32be(0), 0, 0, 0, 1, 0, 96, ...body])
    expect(noteList(long)).toEqual([[[0, 96, 60, 0]]])
    expect(noteList(short)).toEqual([[[0, 96, 60, 0]]])
  })

  it('reads format-2 files as independent tracks', () => {
    const file = parseMidi(smf(2, 96, [[0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0, ...EOT], [0x00, 0x91, 64, 100, 0x30, 0x81, 64, 0, ...EOT]]))
    expect(file.format).toBe(2)
    expect(midiMelodyCandidates(file).map((c) => [c.track, c.channel, c.notes])).toEqual([
      [0, 0, 1],
      [1, 1, 1]
    ])
  })

  it('converts ticks with extreme and SMPTE divisions', () => {
    const track = [0x00, 0x90, 60, 100, 0x01, 0x80, 60, 0, ...EOT]
    expect(parseMidi(smf(0, 1, [track])).tracks[0]!.notes[0]!.durationBeats).toBe(1)
    expect(parseMidi(smf(0, 0x7fff, [track])).tracks[0]!.notes[0]!.durationBeats).toBeCloseTo(1 / 0x7fff)
    // PPQ 0 is corrupt: fall back instead of producing NaN beats.
    const zero = parseMidi(smf(0, 0, [track])).tracks[0]!.notes[0]!
    expect(zero.startBeats).toBe(0)
    expect(Number.isFinite(zero.durationBeats)).toBe(true)
    // SMPTE 25 fps × 40 ticks = 1000 ticks/s; at the default 120 BPM, 1000 ticks is 2 beats.
    const smpte = parseMidi(smf(0, 0xe728, [[0x00, 0x90, 60, 100, 0x87, 0x68, 0x80, 60, 0, ...EOT]]))
    expect(smpte.tracks[0]!.notes[0]!.durationBeats).toBe(2)
    const smpteZero = parseMidi(smf(0, 0xe700, [track])).tracks[0]!.notes[0]!
    expect(Number.isFinite(smpteZero.startBeats) && Number.isFinite(smpteZero.durationBeats)).toBe(true)
  })

  it('takes the earliest tempo and meter and counts only real changes', () => {
    const tempo = (micros: number) => [0xff, 0x51, 0x03, (micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff]
    const meter = (beats: number, pow: number) => [0xff, 0x58, 0x04, beats, pow, 24, 8]
    const conductor = [0x60, ...tempo(500_000), 0x00, ...tempo(500_000), 0x00, ...meter(4, 2), 0x60, ...meter(3, 4), 0x00, ...meter(3, 255), ...EOT]
    const melodyTrack = [0x00, ...tempo(600_000), 0x00, ...tempo(600_000), 0x00, ...meter(6, 3), 0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0, ...EOT]
    const file = parseMidi(smf(1, 96, [conductor, melodyTrack]))
    expect(file.tempoBpm).toBe(100) // 600000 µs at tick 0 comes before 500000 at tick 96
    expect(file.tempoChanges).toBe(2) // 100 → 120; the repeated events are not changes
    expect(file.timeSignature).toEqual({ beats: 6, unit: 8 })
    expect(file.timeSignatureChanges).toBe(3) // 6/8 → 4/4 → 3/16; the 2^255 event is ignored
    const messages = midiToMelody(smf(1, 96, [conductor, melodyTrack])).messages!.join(' ')
    expect(messages).toMatch(/changes tempo 1 time/)
    expect(messages).toMatch(/changes time signature 2 time/)
  })

  it('reads a very long Latin-1 track name without overflowing the stack', () => {
    const name = Array(200_000).fill(0xe9)
    const len = [0x80 | ((name.length >> 14) & 0x7f), 0x80 | ((name.length >> 7) & 0x7f), name.length & 0x7f]
    const file = parseMidi(smf(0, 96, [[0x00, 0xff, 0x03, ...len, ...name, ...EOT]]))
    expect(file.tracks[0]!.name).toHaveLength(200_000)
    expect(file.tracks[0]!.name[0]).toBe('é')
  })

  it('reads RIFF-wrapped (.rmi) files', () => {
    const inner = smf(0, 96, [[0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0, ...EOT]])
    const le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
    const riff = new Uint8Array([...ascii('RIFF'), ...le(inner.length + 12 + 12), ...ascii('RMID'), ...ascii('data'), ...le(inner.length), ...inner, ...ascii('LIST'), ...le(4), ...ascii('INFO')])
    expect(noteList(riff)).toEqual([[[0, 96, 60, 0]]])
  })
})

describe('midiToMelody time signatures', () => {
  const meter = (beats: number, pow: number) => [0x00, 0xff, 0x58, 0x04, beats, pow, 24, 8]
  // One quarter note at PPQ 96.
  const quarter = (pitch: number) => [0x00, 0x90, pitch, 100, 0x60, 0x80, pitch, 0]
  const tune = [62, 64, 65, 67, 69, 71, 72, 74, 76]

  it('reads a pickup bar exported in its own signature (1/4 before 3/4) as a pickup', () => {
    const melody = midiToMelody(smf(0, 96, [[...meter(1, 2), ...quarter(60), ...meter(3, 2), ...tune.flatMap(quarter), ...EOT]]))
    expect(melody.timeSignature).toEqual({ beats: 3, unit: 4 })
    expect(melody.notes.map((n) => n.startBeats)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(melody.messages).toContain('Read the opening 1/4 bar as a pickup (anacrusis) to 3/4 and aligned it so bar lines fall in place.')
    expect(melody.messages?.join(' ')).not.toMatch(/changes time signature/)
    expect(arrangeMelody(melody).raw.notes.slice(0, 5).map((n) => n.time)).toEqual(['0:2:0', '1:0:0', '1:1:0', '1:2:0', '2:0:0'])
    // A short closing bar (2/4) is a change after the pickup; 3/4 still governs.
    const closing = midiToMelody(smf(0, 96, [[...meter(1, 2), ...quarter(60), ...meter(3, 2), ...tune.flatMap(quarter), ...meter(2, 2), ...quarter(77), ...quarter(79), ...EOT]]))
    expect(closing.timeSignature).toEqual({ beats: 3, unit: 4 })
    expect(closing.notes[0]!.startBeats).toBe(2)
    expect(closing.messages?.join(' ')).toMatch(/changes time signature 1 time\(s\) after the pickup; kept 3\/4/)
  })

  it('prefers the signature covering most of the piece over the first one', () => {
    // Two bars of 6/8, then four of 3/4.
    const eighths = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79].flatMap((p) => [0x00, 0x90, p, 100, 0x30, 0x80, p, 0])
    const melody = midiToMelody(smf(0, 96, [[...meter(6, 3), ...eighths, ...meter(3, 2), ...[...tune, 77, 79, 81].flatMap(quarter), ...EOT]]))
    expect(melody.timeSignature).toEqual({ beats: 3, unit: 4 })
    expect(melody.notes[0]!.startBeats).toBe(0)
    expect(melody.messages?.join(' ')).toMatch(/changes time signature 1 time\(s\); kept 3\/4, which covers most of the piece/)
  })
})

describe('midiToMelody → arrangeMelody on polyphonic input', () => {
  it('reduces chords and overlapping voices on one channel to a verifiable line', () => {
    const notes: MidiNote[] = [
      // C major chord, then a melody over a held bass
      ...[48, 52, 55, 60].map((note) => ({ tick: 0, duration: PPQ * 2, note, velocity: 90 })),
      { tick: 0, duration: PPQ * 8, note: 36, velocity: 80 },
      ...[64, 65, 67, 69, 71, 72].map((note, i) => ({ tick: PPQ * 2 + i * PPQ, duration: PPQ * 1.1, note, velocity: 100 })),
      // same pitch retriggered before its note-off
      { tick: PPQ * 8, duration: PPQ * 2, note: 74, velocity: 100 },
      { tick: PPQ * 9, duration: PPQ, note: 74, velocity: 100 }
    ]
    const bytes = encodeMidi({ ppq: PPQ, tempoBpm: 90, tracks: [{ name: 'Piano', channel: 0, notes }] })
    const { raw, messages } = arrangeMelody(midiToMelody(bytes))
    const { song, issues } = parseSong(raw)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(verifySong(song!).errors).toBe(0)
    expect(raw.notes.map((n) => n.pitch)).toEqual(['C4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5', 'D5', 'D5'])
    expect(messages.join(' ')).toMatch(/top note of each chord/)
  })

  it('says so when a file has only percussion', () => {
    const bytes = encodeMidi({ ppq: PPQ, tempoBpm: 90, tracks: [{ name: 'Kit', channel: 9, notes: seq([36, 38, 42]) }] })
    const melody = midiToMelody(bytes)
    expect(melody.notes).toEqual([])
    expect(melody.messages).toContain('Found no pitched (non-percussion) notes.')
  })
})
