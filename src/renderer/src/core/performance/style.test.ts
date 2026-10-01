import { describe, expect, it } from 'vitest'
import { parseSong, type Song } from '../notation'
import { isBorjgin, resolveLevel, resolveStyle, STYLES } from './style'

const song = (extra: Record<string, unknown>): Song =>
  parseSong({ title: 'S', tuning: { maleString: 'F3', femaleString: 'Bb3' }, tempoBpm: 80, timeSignature: '4/4', notes: [], ...extra }).song!

describe('style resolution', () => {
  it('reads the genre text', () => {
    const cases: [string, string][] = [
      ['Urtiin Duu (style study)', 'urtiin-duu'],
      ['Уртын дуу, айзам', 'urtiin-duu'],
      ['Mongolian long song', 'urtiin-duu'],
      ['Tatlaga', 'tatlaga'],
      ['Жонон хар морины явдал', 'tatlaga'],
      ['Bii biyelgee', 'bii-ikel'],
      ['Биелгээ', 'bii-ikel'],
      ['Ikel tatlaga', 'tatlaga'], // the plan's order: tatlaga keywords come first
      ['Inner Mongolian folk song', 'inner-mongolian'],
      ['马头琴独奏', 'inner-mongolian'],
      ['Children’s song', 'khalkh-stage'],
      ['', 'khalkh-stage'],
      ['Big band', 'khalkh-stage'] // "bii" only as a word
    ]
    for (const [genre, style] of cases) expect([genre, resolveStyle(song({ genre }))]).toEqual([genre, style])
  })

  it('lets the song choose its own style', () => {
    expect(resolveStyle(song({ genre: 'Urtiin duu', style: 'as-written' }))).toBe('as-written')
    expect(resolveStyle(song({ style: 'tatlaga' }))).toBe('tatlaga')
  })

  it('finds the long-song sub-genre, defaulting to aizam', () => {
    expect(resolveLevel(song({ genre: 'Urtiin duu' }))).toBe('aizam')
    expect(resolveLevel(song({ genre: 'Уртын дуу (суман)' }))).toBe('suman')
    expect(resolveLevel(song({ genre: 'besreg urtiin duu' }))).toBe('besreg')
    expect(isBorjgin(song({ genre: 'Borjgin long song' }))).toBe(true)
    expect(isBorjgin(song({ genre: 'Urtiin duu' }))).toBe(false)
  })

  it('lists every style once for the UI', () => {
    expect(STYLES.map((s) => s.id)).toEqual(['as-written', 'khalkh-stage', 'urtiin-duu', 'tatlaga', 'bii-ikel', 'inner-mongolian'])
    expect(STYLES.every((s) => s.name && s.description)).toBe(true)
  })
})
