import { describe, expect, it } from 'vitest'
import { encodeMidi } from '../midi'
import { detectScoreFormat, importScoreFile, readSongJson } from './import'
import { parseSong } from './parse'
import { verifySong } from './verify'

const midi = encodeMidi({
  ppq: 96,
  tempoBpm: 80,
  tracks: [{ name: 'Tune', channel: 0, notes: [60, 62, 64, 65].map((note, i) => ({ tick: i * 96, duration: 96, note, velocity: 100 })) }]
})
const xml = new TextEncoder().encode(`<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"/></part-list><part id="P1"><measure>
  <attributes><divisions>1</divisions></attributes>
  <note><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>2</duration></note>
  <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note>
</measure></part></score-partwise>`)

describe('detectScoreFormat', () => {
  it('uses magic bytes before the extension', () => {
    expect(detectScoreFormat('song.xml', midi)).toBe('midi')
    expect(detectScoreFormat('song.mid', xml)).toBe('musicxml')
    expect(detectScoreFormat('song.bin', new Uint8Array([0x50, 0x4b, 3, 4]))).toBe('mxl')
    expect(detectScoreFormat('song.mxl', new Uint8Array([0, 0, 0, 0]))).toBe('mxl')
    expect(detectScoreFormat('song.txt', new Uint8Array([0, 0, 0, 0]))).toBeNull()
  })
})

describe('importScoreFile', () => {
  it('imports MIDI with the file name as a fallback title', async () => {
    const result = await importScoreFile('C:\\music\\My Tune.mid', midi)
    expect(result.format).toBe('midi')
    expect(result.raw.title).toBe('My Tune')
    expect(result.raw.source).toContain('My Tune.mid (MIDI)')
    expect(result.raw.notes.map((n) => n.pitch)).toEqual(['C4', 'D4', 'E4', 'F4'])
    expect(verifySong(parseSong(result.raw).song!).errors).toBe(0)
  })

  it('imports MusicXML', async () => {
    const result = await importScoreFile('etude.musicxml', xml)
    expect(result.format).toBe('musicxml')
    expect(result.raw.title).toBe('etude')
    expect(result.raw.notes.map((n) => [n.pitch, n.duration, n.technique])).toEqual([
      ['Bb3', '2n', 'open'],
      ['C4', '2n', 'cuticle_side_stop']
    ])
  })

  it('rejects unknown files', async () => {
    await expect(importScoreFile('notes.txt', new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a MIDI or MusicXML/)
  })
})

describe('readSongJson', () => {
  const json = (text: string) => new TextEncoder().encode(text)

  it('returns the song object and its title', () => {
    expect(readSongJson('etude.mkhuur.json', json('{"title":"Etude","notes":[]}'))).toEqual({ title: 'Etude', raw: { title: 'Etude', notes: [] } })
    expect(readSongJson('untitled.json', json('{"notes":[]}')).title).toBe('untitled.json')
  })

  it('explains files that are JSON but not a song object', () => {
    expect(() => readSongJson('x.json', json('null'))).toThrow('x.json is not a .mkhuur.json song: it holds null instead of a song object.')
    expect(() => readSongJson('x.json', json('[1, 2]'))).toThrow(/holds a list/)
    expect(() => readSongJson('x.json', json('42'))).toThrow(/holds a number/)
    expect(() => readSongJson('x.json', json('{oops'))).toThrow(/neither a \.mkhuur\.json song nor a MIDI/)
  })
})

describe('detectScoreFormat RIFF handling', () => {
  const riff = (form: string) => new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0], [...form].map((c) => c.charCodeAt(0))))

  it('treats only the RMID form of RIFF as MIDI', () => {
    expect(detectScoreFormat('song.rmi', riff('RMID'))).toBe('midi')
    expect(detectScoreFormat('take.wav', riff('WAVE'))).toBeNull()
    expect(detectScoreFormat('take.mid', riff('WAVE'))).toBe('midi') // the extension still decides otherwise
  })
})

describe('importScoreFile with polyphonic and awkward input', () => {
  it('imports a staccato MIDI performance without losing its notes', async () => {
    const staccato = encodeMidi({
      ppq: 480,
      tempoBpm: 120,
      tracks: [{ name: 'Pizz', channel: 0, notes: [60, 62, 64, 65, 67].map((note, i) => ({ tick: i * 240, duration: 12, note, velocity: 100 })) }]
    })
    const result = await importScoreFile('pizz.mid', staccato)
    expect(result.raw.notes.map((n) => [n.time, n.pitch, n.duration])).toEqual([
      ['0:0:0', 'C4', '16n'],
      ['0:0:2', 'D4', '16n'],
      ['0:1:0', 'E4', '16n'],
      ['0:1:2', 'F4', '16n'],
      ['0:2:0', 'G4', '16n']
    ])
    expect(verifySong(parseSong(result.raw).song!).errors).toBe(0)
  })
})
