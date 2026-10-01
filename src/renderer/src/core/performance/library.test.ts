import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_STOP } from '../instrument'
import { parseSong, verifySong } from '../notation'
import { TECHNIQUES } from '../techniques'
import { performedTiming, planPerformance } from './plan'
import { analyzeSong, pitchContext, REACH_STOPS } from './phrases'
import { ORNAMENT_TIMING } from './presets'
import { STYLES } from './style'
import { STAGE_ETUDE } from './stage-etude.fixture'
import { songClock } from './tempo'
import type { PitchOrnamentKind } from './types'

// Every bundled song in every style: plans are sane, physical and deterministic.

const SONGS_DIR = join(__dirname, '../../../../../songs')
const files = readdirSync(SONGS_DIR).filter((f) => f.endsWith('.mkhuur.json'))
const load = (file: string) => {
  const song = parseSong(JSON.parse(readFileSync(join(SONGS_DIR, file), 'utf8'))).song!
  return { song, report: verifySong(song) }
}
const pc = (m: number) => ((m % 12) + 12) % 12
/** Ornaments whose pitch is a neighbour of the note (a shift slide starts on the previous note instead). */
const NEIGHBOURS: readonly PitchOrnamentKind[] = ['scoop', 'grace', 'hammer', 'mordent', 'trill', 'fall', 'trot-slide']
const SLIDES: readonly PitchOrnamentKind[] = ['scoop', 'fall', 'trot-slide']
const EPS = 1e-6

const cases = files.flatMap((file) => STYLES.map((s) => [file, s.id] as const))

describe('plans for the bundled songs', () => {
  it.each(cases)('%s in %s is sane and physically playable', (file, style) => {
    const { song, report } = load(file)
    const before = JSON.stringify(report)
    const plan = planPerformance(song, report, song.tempoBpm, { style })
    // Planning never touches the verification report.
    expect(JSON.stringify(report)).toBe(before)
    expect(plan.style).toBe(style)
    expect(plan.notes).toHaveLength(report.checks.length)
    expect(plan.leadIn).toBeGreaterThanOrEqual(0)

    const melody = report.checks.map((c) => (c.note.pitch !== null && TECHNIQUES[c.note.technique].kind !== 'percussive' ? c.note.pitch : null))
    const S = pitchContext(melody)
    const steps = new Set<number>()
    const pitched = melody.filter((p): p is number => p !== null)
    for (let i = 1; i < pitched.length; i++) if (Math.abs(pitched[i]! - pitched[i - 1]!) === 1) steps.add(pc(Math.min(pitched[i]!, pitched[i - 1]!)))

    const t = performedTiming(plan, song, report, song.tempoBpm)
    plan.notes.forEach((p, i) => {
      const check = report.checks[i]!
      const n = check.note
      expect(p.order).toBe(i)
      for (const x of [p.timeOffset, p.durationScale, t.notes[i]!.start, t.notes[i]!.duration]) expect(Number.isFinite(x)).toBe(true)
      expect(t.notes[i]!.duration).toBeGreaterThan(0)
      expect(t.notes[i]!.start).toBeGreaterThanOrEqual(0)
      // Offsets never reorder notes or move one before the previous note's start.
      if (i > 0) expect(t.notes[i]!.start).toBeGreaterThanOrEqual(t.notes[i - 1]!.start - EPS)

      // Ornaments fit inside the performed note.
      const d = t.notes[i]!.duration
      expect(p.ornaments.reduce((s, o) => s + o.seconds, 0)).toBeLessThanOrEqual(d + EPS)
      for (const o of p.ornaments) {
        expect(Number.isFinite(o.semitones) && o.seconds > 0).toBe(true)
        if (o.kind !== 'trill') expect(o.seconds).toBeLessThanOrEqual(ORNAMENT_TIMING.maxShare * d + EPS)
        else expect(o.seconds).toBeGreaterThanOrEqual(ORNAMENT_TIMING.trillMin - EPS)
        // Only stopped (or open) bowed pitches, never below the nut, within one hand frame.
        expect(n.pitch).not.toBeNull()
        expect(TECHNIQUES[n.technique].kind).toBe('stopped')
        expect(check.stop! + o.semitones).toBeGreaterThanOrEqual(0)
        expect(check.stop! + o.semitones).toBeLessThanOrEqual(MAX_STOP)
        if (NEIGHBOURS.includes(o.kind)) {
          expect(Math.abs(o.semitones)).toBeLessThanOrEqual(REACH_STOPS)
          const target = n.pitch! + o.semitones
          // In the song's pitch set (slides may fall back to a whole tone)…
          if (!(SLIDES.includes(o.kind) && Math.abs(o.semitones) === 2)) expect(S.classes.has(pc(target))).toBe(true)
          // …and never a semitone the song does not step by itself.
          if (Math.abs(o.semitones) === 1) expect(steps.has(pc(Math.min(n.pitch!, target)))).toBe(true)
        }
      }
      if (p.vibrato) {
        expect(TECHNIQUES[n.technique].kind).toBe('stopped')
        for (const x of [p.vibrato.cents, p.vibrato.rateHz, p.vibrato.amDb, p.vibrato.roughnessBoost, p.vibrato.seed]) expect(Number.isFinite(x)).toBe(true)
        expect(p.vibrato.cents).toBeGreaterThan(0)
      }
      if (p.positionRamp) for (const x of [p.positionRamp.from, p.positionRamp.to]) expect(x).toBeGreaterThanOrEqual(0)
      // Notated vibrato on a bowed note always gets a plan, except as written.
      const notated = n.articulations.includes('vibrato') || n.technique === 'vibrato'
      if (notated && TECHNIQUES[n.technique].kind === 'stopped') expect(p.vibrato !== null).toBe(style !== 'as-written')
    })
    for (const f of t.frames) expect(Number.isFinite(f.start) && f.start >= -EPS && f.duration > 0).toBe(true)
  })

  it.each(files)('%s gets the same plan every time', (file) => {
    for (const s of STYLES) {
      const a = load(file)
      const b = load(file)
      expect(planPerformance(a.song, a.report, 90, { style: s.id })).toEqual(planPerformance(b.song, b.report, 90, { style: s.id }))
    }
  })

  it('plays 02 and an F-major stage melody without semitone scoops (no B♮ into C)', () => {
    const fixture = parseSong(STAGE_ETUDE).song!
    for (const { song, report } of [load('02-first-position-scale.mkhuur.json'), { song: fixture, report: verifySong(fixture) }]) {
      const plan = planPerformance(song, report, song.tempoBpm, { style: 'khalkh-stage' })
      for (const n of plan.notes) {
        expect(n.timeOffset).toBe(0)
        expect(n.durationScale).toBe(1)
        for (const o of n.ornaments) expect(o.kind === 'scoop' && Math.abs(o.semitones) === 1).toBe(false)
      }
    }
    // A composed stage piece resolves to the stage style: no ornaments, and lyrical vibrato only on
    // stopped notes of 0.6 s or more (here the held C4s), never on open strings or short notes.
    const plan = planPerformance(fixture, verifySong(fixture), fixture.tempoBpm)
    expect(plan.style).toBe('khalkh-stage')
    expect(plan.notes.every((n) => n.ornaments.length === 0)).toBe(true)
    const report = verifySong(fixture)
    plan.notes.forEach((n, i) => {
      const c = report.checks[i]!
      const seconds = (c.note.durationBeats * 60) / fixture.tempoBpm
      expect(n.vibrato !== null, `note ${i}`).toBe(c.note.technique !== 'open' && seconds >= 0.6)
      if (n.vibrato) expect(n.vibrato.shape).toBe('lyrical')
    })
  })

  it('demonstrates the presets on the etudes: 03 is played as tatlaga, 05 trills in its climax phrase', () => {
    const amble = load('03-joroo-gallop.mkhuur.json')
    const tatlaga = planPerformance(amble.song, amble.report, amble.song.tempoBpm)
    expect(tatlaga.style).toBe('tatlaga')
    expect(tatlaga.frames.map((f) => f.kind)).toContain('om-zee')

    const { song, report } = load('05-long-song-phrase.mkhuur.json')
    const climax = analyzeSong(song, report, songClock(song)).climax
    for (const amount of [1, 0]) {
      // A note-level hint: it stays when the automatic ornaments are turned off.
      const plan = planPerformance(song, report, song.tempoBpm, { amount })
      expect(plan.style).toBe('urtiin-duu')
      const trilled = plan.notes.filter((n) => n.ornaments.some((o) => o.kind === 'trill'))
      expect(trilled.map((n) => report.checks[n.order]!.note.time)).toEqual(['0:3:0'])
      const i = trilled[0]!.order
      expect(analyzeSong(song, report, songClock(song)).notes[i]!.phrase).toBe(climax)
      // F4 up to G4, the phrase's peak: a whole tone in the song's own pitch set; no vibrato under it.
      expect(trilled[0]!.ornaments.find((o) => o.kind === 'trill')!.semitones).toBe(2)
      expect(trilled[0]!.vibrato).toBeNull()
    }
    // As written it is only a hint: nothing is played.
    expect(planPerformance(song, report, song.tempoBpm, { style: 'as-written' }).notes.every((n) => n.ornaments.length === 0)).toBe(true)
  })

  it('keeps rhythm fixed outside the long song: only small onset jitter', () => {
    for (const file of files) {
      const { song, report } = load(file)
      for (const style of ['tatlaga', 'bii-ikel', 'inner-mongolian'] as const) {
        for (const n of planPerformance(song, report, song.tempoBpm, { style }).notes) expect(Math.abs(n.timeOffset)).toBeLessThanOrEqual(0.025 + EPS)
      }
    }
  })
})
