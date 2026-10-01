import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { beatsToSeconds, parseSong, verifySong } from '@renderer/core/notation'
import { resolveStyle, songClock, STYLES, type StyleId } from '@renderer/core/performance'
import { eventsDuration, songEvents, songPerformance, type TimedEvent } from './song-events'

const SONGS_DIR = join(__dirname, '../../../../songs')
const files = readdirSync(SONGS_DIR).filter((f) => f.endsWith('.mkhuur.json'))
const load = (file: string) => {
  const song = parseSong(JSON.parse(readFileSync(join(SONGS_DIR, file), 'utf8'))).song!
  return { song, report: verifySong(song) }
}
const EPS = 1e-9
const cases = files.flatMap((file) => STYLES.map((s) => [file, s.id] as const))
const byOrder = (events: readonly TimedEvent[]) => new Map(events.filter((e) => e.order >= 0).map((e) => [e.order, e]))

describe('song events', () => {
  it.each(cases)('%s in %s: every note once, framing strokes included, all in time order', (file, style) => {
    const { song, report } = load(file)
    const events = songEvents(song, report, song.tempoBpm, { style })
    // A stroke cancels its string's later automation, so array order must be time order.
    for (let i = 1; i < events.length; i++) expect(events[i]!.start).toBeGreaterThanOrEqual(events[i - 1]!.start)
    expect([...byOrder(events).keys()].sort((a, b) => a - b)).toEqual(report.checks.map((_, i) => i))
    const frames = events.filter((e) => e.order < 0)
    for (const f of frames) expect(f.event.frame).toBeTruthy()
    expect(eventsDuration(events)).toBeGreaterThanOrEqual(Math.max(...events.map((e) => e.start + e.event.duration)) - EPS)
  })

  it('puts opening frames before the melody (sorted, not appended)', () => {
    let opened = 0
    for (const [file, style] of cases) {
      const { song, report } = load(file)
      const events = songEvents(song, report, song.tempoBpm, { style })
      const first = events.findIndex((e) => e.order >= 0)
      if (first > 0) {
        opened++
        expect(events.slice(0, first).every((e) => e.order < 0)).toBe(true)
      }
    }
    // Om zee openings and long-song preludes exist in the bundled library.
    expect(opened).toBeGreaterThan(0)
  })

  it('defaults to the song’s own style; expressive: false plays as written', () => {
    for (const file of files) {
      const { song, report } = load(file)
      expect(songPerformance(song, report).style).toBe(resolveStyle(song))
      expect(songEvents(song, report)).toEqual(songEvents(song, report, song.tempoBpm, { style: resolveStyle(song) }))
      const plain = songPerformance(song, report, song.tempoBpm, { style: 'tatlaga', expressive: false })
      expect(plain.style).toBe('as-written')
      expect(plain.events).toEqual(songEvents(song, report, song.tempoBpm, { style: 'as-written' }))
      for (const e of plain.events) {
        expect(e.order).toBeGreaterThanOrEqual(0)
        expect(e.event.ornaments).toBeUndefined()
        expect(e.event.bowProfile).toBeUndefined()
      }
    }
  })

  it('as written, asks for no vibrato beyond the notated (null plan: not even on long stopped notes)', () => {
    let notated = 0
    for (const file of files) {
      const { song, report } = load(file)
      for (const e of songEvents(song, report, song.tempoBpm, { style: 'as-written' })) {
        expect(e.event.vibratoPlan).toBeNull()
        if (e.event.vibrato || e.event.technique === 'vibrato') notated++
      }
    }
    // Notated vibrato is still in the events (the instrument plays it from `vibrato` / the technique).
    expect(notated).toBeGreaterThan(0)
  })

  it.each(cases)('%s in %s on the grid: notes start and last as written, no frames', (file, style) => {
    const { song, report } = load(file)
    const bpm = 96
    const grid = songEvents(song, report, bpm, { style, grid: true })
    expect(grid.every((e) => e.order >= 0)).toBe(true)
    const notes = byOrder(grid)
    expect(notes.size).toBe(report.checks.length)
    report.checks.forEach((c, i) => {
      const e = notes.get(i)!
      expect(e.start).toBeCloseTo(beatsToSeconds(c.note.startBeats, bpm), 9)
      expect(e.event.duration).toBeCloseTo(beatsToSeconds(c.note.durationBeats, bpm), 9)
    })
  })

  it('keeps one tempo on the grid: the song’s tempo map applies only off it', () => {
    const notes = ['F4', 'D4', 'C4', 'D4', 'F4', 'D4', 'C4', 'D4'].map((pitch, i) => ({
      time: `${Math.floor(i / 2)}:${(i % 2) * 2}:0`,
      pitch,
      duration: '2n',
      string: 'female',
      technique: 'cuticle_side_stop',
      finger: pitch === 'F4' ? 'pinky' : pitch === 'D4' ? 'middle' : 'index',
      bow: i % 2 ? 'tülekhe' : 'tatakh'
    }))
    const raw = { title: 'Ritardando', tuning: { maleString: 'F3', femaleString: 'Bb3' }, tempoBpm: 60, timeSignature: '4/4', notes }
    const plain = parseSong(raw).song!
    const mapped = parseSong({ ...raw, tempoMap: [{ time: '2:0:0', bpm: 60 }, { time: '4:0:0', bpm: 30, ramp: true }] }).song!
    expect(mapped.tempoMap).toBeDefined()
    const report = verifySong(mapped)
    const bpm = 90
    for (const style of STYLES.map((s) => s.id)) {
      const grid = songEvents(mapped, report, bpm, { style, grid: true })
      // Every bar lasts as long at the Studio's tempo, whatever the map says…
      expect(grid).toEqual(songEvents(plain, verifySong(plain), bpm, { style, grid: true }))
      report.checks.forEach((c, i) => expect(byOrder(grid).get(i)!.start).toBeCloseTo(beatsToSeconds(c.note.startBeats, bpm), 9))
    }
    // …while playing on its own (here as written) the ritardando stretches the last bars.
    const free = byOrder(songEvents(mapped, report, bpm, { style: 'as-written' }))
    const clock = songClock(mapped, bpm)
    report.checks.forEach((c, i) => expect(free.get(i)!.start).toBeCloseTo(clock.seconds(c.note.startBeats), 9))
    expect(free.get(report.checks.length - 1)!.start).toBeGreaterThan(beatsToSeconds(report.checks.at(-1)!.note.startBeats, bpm) + 0.5)
  })

  it('keeps the style’s ornaments, vibrato and bowing on the grid', () => {
    const style: StyleId = 'inner-mongolian'
    let ornamented = 0
    for (const file of files) {
      const { song, report } = load(file)
      const free = byOrder(songEvents(song, report, 96, { style }))
      for (const e of songEvents(song, report, 96, { style, grid: true })) {
        const f = free.get(e.order)!
        expect(e.event.ornaments).toEqual(f.event.ornaments)
        expect(e.event.vibratoPlan).toEqual(f.event.vibratoPlan)
        expect(e.event.bowProfile).toEqual(f.event.bowProfile)
        if (e.event.ornaments?.length) ornamented++
      }
    }
    expect(ornamented).toBeGreaterThan(0)
  })
})
