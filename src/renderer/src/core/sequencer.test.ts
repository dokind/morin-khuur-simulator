import { describe, expect, it } from 'vitest'
import {
  BANK_IDS,
  chainHits,
  chainMidi,
  chainOrder,
  defaultBanks,
  emptyBank,
  emptyPattern,
  exportParts,
  exportRepeats,
  getGroove,
  nextCursor,
  nextInChain,
  normalizePattern,
  patternBars,
  patternFromRows,
  patternHits,
  PRESET_PATTERNS,
  reshapePattern,
  resizePattern,
  restoreBanks,
  setCell,
  setPitch,
  startCursor,
  stepOffset,
  stepSeconds,
  toggleCell,
  type Bank,
  type BankId,
  type Cursor,
  type Pattern
} from './sequencer'

describe('grooves', () => {
  it('leaves straight grooves on the grid', () => {
    const g = getGroove('straight')
    expect([0, 1, 2, 3].map((s) => stepOffset(g, s))).toEqual([0, 0, 0, 0])
  })

  it('delays off-steps by a third of a step for triplet swing and half a step for the dotted trot', () => {
    expect(stepOffset(getGroove('gallop'), 1)).toBeCloseTo(0.334, 2)
    expect(stepOffset(getGroove('towoo'), 1)).toBeCloseTo(0.5)
    expect(stepOffset(getGroove('towoo'), 2)).toBe(0)
  })

  it('applies the joroo lilt in 6/8', () => {
    const joroo = getGroove('joroo')
    expect(joroo.meter).toBe('6/8')
    expect(stepOffset(joroo, 2)).toBeLessThan(0)
    expect(stepOffset(joroo, 4)).toBeGreaterThan(0)
  })

  it('describes the swung gallop as a triplet gallop', () => {
    expect(getGroove('gallop').description).toMatch(/triplet/i)
  })

  it('plays the 1:1:2 gallop (16th–16th–8th) with the third hoof accented', () => {
    const g = getGroove('gallop-112')
    expect(g.id).toBe('gallop-112')
    expect(g.meter).toBe('4/4')
    // On the grid: the ratio comes from filling three steps a beat.
    expect(Array.from({ length: 16 }, (_, s) => stepOffset(g, s))).toEqual(Array(16).fill(0))
    const p = patternFromRows('4/4', { hihat: 'xxx.xxx.xxx.xxx.' })
    const hits = patternHits(p, g, 100)
    const dt = stepSeconds(100)
    const ioi = hits.slice(1).map((h, i) => (h.time - hits[i]!.time) / dt)
    expect(ioi.map((x) => Math.round(x * 1000) / 1000)).toEqual([1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1])
    for (let beat = 0; beat < 4; beat++) {
      const [a, b, c] = hits.slice(beat * 3, beat * 3 + 3).map((h) => h.velocity)
      expect(c).toBeGreaterThan(a!)
      expect(c).toBeGreaterThan(b!)
      // The suspension step is the weakest of the beat.
      expect(g.accents[beat * 4 + 3]).toBeLessThan(Math.min(...g.accents.slice(beat * 4, beat * 4 + 3)))
    }
  })

  it('restores a bank saved with the 1:1:2 gallop', () => {
    const saved = JSON.parse(JSON.stringify({ banks: { A: { pattern: patternFromRows('4/4', { kick: 'x' }), grooveId: 'gallop-112', presetId: null } } }))
    const { banks } = restoreBanks(saved, { banks: defaultBanks(), bank: 'A' })
    expect(banks.A.grooveId).toBe('gallop-112')
  })
})

describe('patterns', () => {
  it('creates 16/32 steps in 4/4 and 12/24 in 6/8', () => {
    expect(emptyPattern('4/4').steps).toBe(16)
    expect(emptyPattern('6/8').steps).toBe(12)
    expect(emptyPattern('4/4', 2).steps).toBe(32)
    expect(emptyPattern('6/8', 2).steps).toBe(24)
    expect(emptyPattern('4/4', 5).steps).toBe(32)
    expect(patternBars(emptyPattern('6/8', 2))).toBe(2)
  })

  it('toggles cells immutably', () => {
    const a = emptyPattern('4/4')
    const b = toggleCell(a, 'kick', 0)
    expect(a.cells.kick[0]).toBe(0)
    expect(b.cells.kick[0]).toBeGreaterThan(0)
    expect(toggleCell(b, 'kick', 0).cells.kick[0]).toBe(0)
  })

  it('keeps pitch offsets on steps that are on, clamped to ±12 semitones', () => {
    const off = emptyPattern('4/4')
    expect(setPitch(off, 'sub808', 3, 5)).toBe(off)
    const on = setCell(off, 'sub808', 3, 0.8)
    expect(setPitch(on, 'sub808', 3, 4.6).pitch.sub808[3]).toBe(5)
    expect(setPitch(on, 'sub808', 3, 40).pitch.sub808[3]).toBe(12)
    expect(setPitch(on, 'sub808', 3, -40).pitch.sub808[3]).toBe(-12)
    // Turning the step off clears its pitch.
    const pitched = setPitch(on, 'sub808', 3, 7)
    expect(toggleCell(pitched, 'sub808', 3).pitch.sub808[3]).toBe(0)
    expect(on.pitch.sub808[3]).toBe(0)
  })

  it('ignores steps outside the pattern and bad numbers', () => {
    // A live-recorded step from bar 2 arriving just after the pattern was shortened to one bar.
    const p = emptyPattern('4/4')
    expect(setCell(p, 'kick', 20, 0.9)).toBe(p)
    expect(setCell(p, 'kick', -1, 0.9)).toBe(p)
    expect(setCell(p, 'kick', 1.5, 0.9)).toBe(p)
    expect(toggleCell(p, 'kick', 16)).toBe(p)
    expect(setCell(p, 'kick', 3, Number.NaN).cells.kick[3]).toBe(0)
    const on = setCell(p, 'kick', 3, 0.8)
    expect(setPitch(on, 'kick', 3, Number.NaN).pitch.kick[3]).toBe(0)
    expect(setPitch(on, 'kick', 16, 3)).toBe(on)
  })

  it('schedules hits with swing applied', () => {
    const p = patternFromRows('4/4', { hihat: 'xx' })
    const hits = patternHits(p, getGroove('towoo'), 120)
    const dt = stepSeconds(120)
    expect(hits.map((h) => h.time)).toEqual([0, 1.5 * dt])
  })

  it('carries pitch offsets into scheduled hits', () => {
    const p = patternFromRows('4/4', { sub808: 'x.x.', kick: 'x' }, { sub808: { 2: -3 } })
    const hits = patternHits(p, getGroove('straight'), 120)
    expect(hits.map((h) => [h.pad, h.step, h.pitch])).toEqual([
      ['sub808', 0, 0],
      ['kick', 0, 0],
      ['sub808', 2, -3]
    ])
  })

  it('ships preset patterns that match their groove meter', () => {
    for (const preset of PRESET_PATTERNS) expect(preset.pattern.meter).toBe(getGroove(preset.groove).meter)
  })

  it('builds two-bar presets from long rows', () => {
    const trap = PRESET_PATTERNS.find((p) => p.id === 'steppe-trap')!.pattern
    expect(trap.steps).toBe(32)
    expect(trap.pitch.sub808[29]).toBe(5)
  })

  it('repeats groove timing and accents in bar 2', () => {
    for (const [meter, grooveId] of [
      ['6/8', 'joroo'],
      ['4/4', 'gallop']
    ] as const) {
      const per = meter === '6/8' ? 12 : 16
      const p = resizePattern(patternFromRows(meter, { hihat: 'x'.repeat(per) }), 2)
      const hits = patternHits(p, getGroove(grooveId), 100)
      const dt = stepSeconds(100)
      expect(hits).toHaveLength(2 * per)
      for (let i = 0; i < per; i++) {
        expect(hits[per + i]!.time - hits[i]!.time).toBeCloseTo(per * dt)
        expect(hits[per + i]!.velocity).toBe(hits[i]!.velocity)
      }
    }
  })
})

describe('pattern length and meter', () => {
  const base = setPitch(patternFromRows('4/4', { kick: 'x...x...x...x..x', hihat: '..x' }), 'kick', 15, 2)

  it('lengthens to two bars by repeating the first, keeping every step', () => {
    const long = resizePattern(base, 2)
    expect(long.steps).toBe(32)
    expect(long.cells.kick.slice(0, 16)).toEqual(base.cells.kick)
    expect(long.cells.kick.slice(16)).toEqual(base.cells.kick)
    expect(long.pitch.kick[15]).toBe(2)
    expect(long.pitch.kick[31]).toBe(2)
    expect(long.pitch.kick).toHaveLength(32)
  })

  it('shortens back to the first bar', () => {
    const edited = setCell(resizePattern(base, 2), 'snare', 20, 0.9)
    const short = resizePattern(edited, 1)
    expect(short.steps).toBe(16)
    expect(short.cells.kick).toEqual(base.cells.kick)
    expect(short.cells.snare.every((v) => v === 0)).toBe(true)
  })

  it('changes meter bar by bar', () => {
    const two = setCell(resizePattern(base, 2), 'clap', 16 + 3, 0.7)
    const sixEight = reshapePattern(two, '6/8', 2)
    expect(sixEight.steps).toBe(24)
    // Bar 2 of 4/4 (step 16 + 3) lands on bar 2 of 6/8 (step 12 + 3); step 15 no longer fits.
    expect(sixEight.cells.clap[15]).toBe(0.7)
    expect(sixEight.cells.kick.slice(0, 12)).toEqual(base.cells.kick.slice(0, 12))
    expect(sixEight.cells.kick).toHaveLength(24)
  })
})

describe('banks and chaining', () => {
  const kick = patternFromRows('4/4', { kick: 'x' })
  const banksWith = (filled: Partial<Record<BankId, Pattern>>): Record<BankId, Bank> => {
    const banks = {} as Record<BankId, Bank>
    for (const id of BANK_IDS) banks[id] = filled[id] ? { pattern: filled[id], grooveId: filled[id].meter === '6/8' ? 'joroo' : 'straight', presetId: null } : emptyBank('straight')
    return banks
  }

  it('chains only the banks that hold a pattern, in order', () => {
    const banks = banksWith({ A: kick, C: kick, D: kick })
    expect(chainOrder(banks)).toEqual(['A', 'C', 'D'])
    expect(nextInChain(banks, 'A')).toBe('C')
    expect(nextInChain(banks, 'D')).toBe('A')
    expect(nextInChain(banks, 'B')).toBe('C')
    expect(nextInChain(banksWith({ B: kick }), 'B')).toBe('B')
    expect(nextInChain(banksWith({}), 'C')).toBe('C')
  })

  it('plays the chain A→C→D in a loop', () => {
    const banks = banksWith({ A: kick, C: resizePattern(kick, 2), D: kick })
    const visited: string[] = []
    let c: Cursor | null = startCursor(banks, 'A', true)
    for (let i = 0; i < 16 * 5 && c; i++) {
      if (c.step === 0) visited.push(c.bank)
      c = nextCursor(c, banks, { chain: true, loop: true, cue: null })
    }
    // C is two bars long: A (16) + C (32) + D (16) + A (16) = 80 steps.
    expect(visited).toEqual(['A', 'C', 'D', 'A'])
  })

  it('starts the chain on the next filled bank and stops after D without loop', () => {
    const banks = banksWith({ B: kick, D: kick })
    expect(startCursor(banks, 'A', true)).toEqual({ bank: 'B', step: 0 })
    expect(startCursor(banks, 'A', false)).toEqual({ bank: 'A', step: 0 })
    expect(nextCursor({ bank: 'B', step: 15 }, banks, { chain: true, loop: false, cue: null })).toEqual({ bank: 'D', step: 0 })
    expect(nextCursor({ bank: 'D', step: 15 }, banks, { chain: true, loop: false, cue: null })).toBeNull()
    expect(nextCursor({ bank: 'D', step: 15 }, banks, { chain: false, loop: true, cue: null })).toEqual({ bank: 'D', step: 0 })
  })

  it('switches a cued bank in at the next bar line', () => {
    const banks = banksWith({ A: resizePattern(kick, 2), B: kick })
    const opts = { chain: false, loop: true, cue: 'B' as BankId }
    expect(nextCursor({ bank: 'A', step: 5 }, banks, opts)).toEqual({ bank: 'A', step: 6 })
    expect(nextCursor({ bank: 'A', step: 15 }, banks, opts)).toEqual({ bank: 'B', step: 0 })
    expect(nextCursor({ bank: 'A', step: 31 }, banks, opts)).toEqual({ bank: 'B', step: 0 })
    // Cueing the playing bank changes nothing.
    expect(nextCursor({ bank: 'A', step: 15 }, banks, { ...opts, cue: 'A' })).toEqual({ bank: 'A', step: 16 })
  })

  it('switches a cued bank in at the 6/8 bar line of a 24-step pattern', () => {
    const six = patternFromRows('6/8', { bodyTap: 'x' })
    const banks: Record<BankId, Bank> = { ...banksWith({ B: kick }), A: { pattern: resizePattern(six, 2), grooveId: 'joroo', presetId: null } }
    const opts = { chain: false, loop: true, cue: 'B' as BankId }
    expect(nextCursor({ bank: 'A', step: 10 }, banks, opts)).toEqual({ bank: 'A', step: 11 })
    expect(nextCursor({ bank: 'A', step: 11 }, banks, opts)).toEqual({ bank: 'B', step: 0 })
    expect(nextCursor({ bank: 'A', step: 15 }, banks, opts)).toEqual({ bank: 'A', step: 16 })
    expect(nextCursor({ bank: 'A', step: 23 }, banks, opts)).toEqual({ bank: 'B', step: 0 })
  })

  it('plays every step of 24- and 32-step patterns once per pass', () => {
    for (const pattern of [resizePattern(patternFromRows('6/8', { kick: 'x' }), 2), resizePattern(kick, 2)]) {
      const banks = { ...banksWith({}), A: { pattern, grooveId: pattern.meter === '6/8' ? 'joroo' : 'straight', presetId: null } }
      const steps: number[] = []
      let c: Cursor | null = startCursor(banks, 'A', false)
      for (let i = 0; i < 100 && c; i++) {
        steps.push(c.step)
        c = nextCursor(c, banks, { chain: false, loop: false, cue: null })
      }
      expect(steps).toEqual(Array.from({ length: pattern.steps }, (_, i) => i))
    }
  })

  it('moves on when a pattern shrinks under the playhead', () => {
    const banks = banksWith({ A: kick })
    expect(nextCursor({ bank: 'A', step: 20 }, banks, { chain: false, loop: true, cue: null })).toEqual({ bank: 'A', step: 0 })
  })
})

describe('export', () => {
  const a = patternFromRows('4/4', { kick: 'x', sub808: 'x...x' }, { sub808: { 4: 3 } })
  const b = patternFromRows('6/8', { femaleOpen: 'x' }, { femaleOpen: { 0: 2 } })
  const banks: Record<BankId, Bank> = {
    A: { pattern: a, grooveId: 'straight', presetId: null },
    B: { pattern: b, grooveId: 'six-eight', presetId: null },
    C: emptyBank('straight'),
    D: emptyBank('straight')
  }

  it('exports the selected bank, or the whole chain from A', () => {
    expect(exportParts(banks, 'B', false).map((p) => p.pattern)).toEqual([b])
    expect(exportParts(banks, 'B', true).map((p) => p.pattern)).toEqual([a, b])
    expect(exportParts(banks, 'C', true).map((p) => p.pattern)).toEqual([a, b])
    expect(exportRepeats(exportParts(banks, 'A', false))).toBe(4)
    expect(exportRepeats(exportParts(banks, 'A', true))).toBe(2)
    expect(exportRepeats([{ pattern: resizePattern(a, 2), groove: getGroove('straight') }], 4)).toBe(2)
  })

  it('lays chained patterns end to end with their pitch offsets', () => {
    const parts = exportParts(banks, 'A', true)
    const dt = stepSeconds(120)
    const { hits, seconds } = chainHits(parts, 120, 2)
    expect(seconds).toBeCloseTo((16 + 12) * 2 * dt)
    const fiddle = hits.filter((h) => h.pad === 'femaleOpen')
    expect(fiddle.map((h) => h.time)).toEqual([16 * dt, (16 + 12 + 16) * dt])
    expect(fiddle.every((h) => h.pitch === 2)).toBe(true)
    expect(hits.filter((h) => h.pad === 'sub808').map((h) => h.pitch)).toEqual([0, 3, 0, 3])
  })

  it('writes pitch offsets into MIDI notes', () => {
    const song = chainMidi(exportParts(banks, 'A', true), 120)
    const [morin, drums, tuned] = song.tracks
    expect(song.timeSignature).toEqual([4, 4])
    // Female string B♭3 (58) + 2 semitones, in the second pattern (16 steps × 24 ticks).
    expect(morin!.notes).toEqual([{ tick: 16 * 24, duration: 24, note: 60, velocity: expect.any(Number) }])
    // The kick stays on GM percussion; the pitched 808 moves to its own tuned track (F1 = 29).
    expect(drums!.notes.map((n) => n.note)).toEqual([36])
    expect(tuned!.channel).not.toBe(9)
    expect(tuned!.notes.map((n) => [n.tick, n.note])).toEqual([
      [0, 29],
      [4 * 24, 32]
    ])
  })

  it('keeps percussion on channel 10 when nothing is pitched', () => {
    const song = chainMidi([{ pattern: patternFromRows('4/4', { kick: 'x', sub808: 'x' }), groove: getGroove('straight') }], 120)
    expect(song.tracks).toHaveLength(2)
    expect(song.tracks[1]!.notes.map((n) => n.note).sort()).toEqual([35, 36])
  })
})

describe('persistence', () => {
  const fallback = { banks: defaultBanks(), bank: 'A' as BankId }

  it('migrates a v1 single pattern (velocity rows only) into bank A', () => {
    const v1Pattern = patternFromRows('4/4', { kick: 'x...x...', snare: '....o...' })
    const { pitch: _pitch, ...legacy } = v1Pattern
    const persisted = JSON.parse(JSON.stringify({ pattern: legacy, grooveId: 'gallop', bpm: 92, loop: true, presetId: null }))
    const { banks, bank } = restoreBanks(persisted, fallback)
    expect(bank).toBe('A')
    expect(banks.A.grooveId).toBe('gallop')
    expect(banks.A.pattern.cells).toEqual(v1Pattern.cells)
    expect(banks.A.pattern.pitch.kick).toEqual(new Array(16).fill(0))
    for (const id of ['B', 'C', 'D'] as const) {
      expect(chainOrder(banks)).not.toContain(id)
      expect(banks[id].pattern.meter).toBe('4/4')
    }
  })

  it('repairs malformed rows without crashing', () => {
    const persisted = {
      pattern: { meter: '6/8', steps: 12, cells: { kick: [1, 'x', null, 3, -1, Number.NaN], hihat: 'oops' } },
      grooveId: 'nope'
    }
    const { banks } = restoreBanks(persisted, fallback)
    const p = banks.A.pattern
    expect(p.meter).toBe('6/8')
    expect(banks.A.grooveId).toBe('joroo')
    expect(p.cells.kick).toEqual([1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(p.cells.hihat).toEqual(new Array(12).fill(0))
    expect(p.cells.bells).toHaveLength(12)
    expect(normalizePattern('garbage')).toBeNull()
  })

  it('keeps both bars of a stored pattern whose step count is missing', () => {
    const two = resizePattern(patternFromRows('4/4', { kick: 'x' }), 2)
    const { steps: _steps, ...raw } = setCell(two, 'snare', 20, 0.7)
    const p = normalizePattern(JSON.parse(JSON.stringify(raw)))!
    expect(p.steps).toBe(32)
    expect(p.cells.snare[20]).toBe(0.7)
    expect(p.pitch.snare).toHaveLength(32)
    // v1 rows with neither steps nor meter: one 4/4 bar.
    expect(normalizePattern({ cells: { kick: [1, 0, 0, 0] } })!.steps).toBe(16)
  })

  it('fits a pattern to its groove meter', () => {
    const { banks } = restoreBanks({ pattern: patternFromRows('4/4', { kick: 'x'.repeat(16) }), grooveId: 'joroo' }, fallback)
    expect(banks.A.pattern.meter).toBe('6/8')
    expect(banks.A.pattern.steps).toBe(12)
  })

  it('falls back when nothing is stored and round-trips v2 banks', () => {
    expect(restoreBanks(undefined, fallback)).toBe(fallback)
    expect(restoreBanks({ bpm: 90 }, fallback)).toBe(fallback)
    const banks = { ...defaultBanks(), C: { pattern: setPitch(resizePattern(patternFromRows('4/4', { kick: 'x' }), 2), 'kick', 16, -5), grooveId: 'towoo', presetId: null } }
    const restored = restoreBanks(JSON.parse(JSON.stringify({ banks, bank: 'C' })), fallback)
    expect(restored.bank).toBe('C')
    expect(restored.banks).toEqual(banks)
  })
})
