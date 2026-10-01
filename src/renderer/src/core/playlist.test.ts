import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ComparisonRow } from './analysis'
import { parseSong } from './notation/parse'
import {
  BLIND_EXCERPT_SECONDS,
  binomialTail,
  blindLines,
  blindSummary,
  cacheEvictions,
  createBlindTrial,
  EMPTY_FEEDBACK,
  excerptWindow,
  feedbackData,
  feedbackMarkdown,
  formatMeasure,
  isHttpsUrl,
  listeningGain,
  LISTENING_RMS_DB,
  mapAbPosition,
  MAX_BLIND_ANSWERS,
  MAX_EXCERPT_SECONDS,
  nextInQueue,
  normalizeFeedback,
  normalizeTitle,
  parseSeconds,
  PLAYLIST,
  playableQueue,
  resolveSong,
  titleMatches,
  validatePlaylist,
  type BlindAnswer,
  type EntryFeedback,
  type LibrarySong,
  type PlaylistEntry
} from './playlist'
import { isTechniqueId } from './techniques'

const SONGS_DIR = join(__dirname, '../../../../songs')
const SONG_IDS = readdirSync(SONGS_DIR)
  .filter((f) => f.endsWith('.mkhuur.json'))
  .map((f) => f.replace('.mkhuur.json', ''))
const readSong = (id: string) => JSON.parse(readFileSync(join(SONGS_DIR, `${id}.mkhuur.json`), 'utf8')) as unknown

const entry = (patch: Partial<PlaylistEntry>): PlaylistEntry => ({
  id: 'test',
  titleMn: 'Маамуу нааш ир',
  titleLatin: 'Maamuu Naash Ir',
  kind: 'short-song',
  composer: 'Traditional',
  rights: 'unknown',
  songId: null,
  originals: [],
  techniques: [],
  style: 'khalkh-stage',
  referenceKind: 'fiddle',
  ...patch
})

const row = (patch: Partial<ComparisonRow>): ComparisonRow => ({
  feature: 'vibratoRate',
  label: 'Vibrato rate',
  sim: 4.2,
  ref: 5.6,
  delta: -1.4,
  tolerance: 0.8,
  unit: 'Hz',
  ok: false,
  hint: 'Our vibrato is slower than the original’s.',
  ...patch
})

describe('playlist data', () => {
  it('is valid: unique ids, titles, bundled songs that exist, https links, known technique ids, styles and reference kinds', () => {
    expect(PLAYLIST.length).toBeGreaterThan(0)
    expect(validatePlaylist(PLAYLIST, SONG_IDS)).toEqual([])
    expect(new Set(PLAYLIST.map((e) => e.id)).size).toBe(PLAYLIST.length)
    for (const e of PLAYLIST) {
      expect(e.titleMn.trim(), e.id).not.toBe('')
      expect(e.titleLatin.trim(), e.id).not.toBe('')
      for (const o of e.originals) expect(o.url).toMatch(/^https:\/\//)
    }
  })

  it.each(PLAYLIST.filter((e) => e.songId !== null).map((e) => [e.id, e] as const))('%s points at the right bundled song', (_, e) => {
    const { song } = parseSong(readSong(e.songId!))
    expect(song).not.toBeNull()
    // The Latin title is (part of) the song's title.
    expect(normalizeTitle(song!.title)).toContain(normalizeTitle(e.titleLatin))
    // Rights follow the song's source: the project's etudes say they are original, and credit the same authors.
    expect(e.rights === 'original').toBe(/original exercise/i.test(song!.source))
    if (e.rights === 'original') expect(e.composer).toBe(song!.composer)
    // Every technique id listed is used in the song (as a technique or an articulation).
    const used = new Set(song!.notes.flatMap((n) => [n.technique, ...n.articulations]))
    for (const t of e.techniques.filter(isTechniqueId)) expect(used, `${e.id} lists ${t}`).toContain(t)
  })

  it('bundles every song at most once', () => {
    const ids = PLAYLIST.flatMap((e) => (e.songId ? [e.songId] : []))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('bundles only project originals', () => {
    const bundled = PLAYLIST.filter((e) => e.songId !== null && e.rights !== 'original').map((e) => e.id)
    expect(bundled).toEqual([])
  })

  it.each(PLAYLIST.filter((e) => e.songId === null).map((e) => [e.id, e] as const))('%s auto-links an imported score by either title', (_, e) => {
    expect(e.match?.length, e.id).toBeGreaterThan(0)
    expect(titleMatches(e, e.titleLatin)).toBe(true)
    expect(titleMatches(e, e.titleMn)).toBe(true)
    // Keywords in the scripts of both titles: Latin, and Cyrillic (or Chinese) when the Mongolian title has it.
    const keys = e.match!
    expect(keys.some((k) => /\p{Script=Latin}/u.test(k)), `${e.id}: a Latin keyword`).toBe(true)
    for (const re of [/\p{Script=Cyrillic}/u, /\p{Script=Han}/u]) {
      if (re.test(e.titleMn)) expect(keys.some((k) => re.test(k)), `${e.id}: a keyword in the script of ${e.titleMn}`).toBe(true)
    }
  })

  it('credits Maamuu Naash Ir to its authors as a protected work, with its sung and piano originals', () => {
    const maamuu = PLAYLIST.find((e) => e.id === 'maamuu-naash-ir')!
    expect(maamuu.rights).toBe('copyrighted')
    expect(maamuu.composer).toBe('Music: Dagvyn Luvsansharav (1927–2014); words: Choijiljavyn Lkhamsüren (1917–1979); 1956')
    // Not bundled (protected until at least 2064): the user imports their own copy, which auto-links.
    expect(maamuu.songId).toBeNull()
    expect(maamuu.referenceKind).toBe('voice')
    expect(maamuu.match).toEqual(expect.arrayContaining(['маамуу', 'maamuu']))
    expect(maamuu.originals.length).toBeGreaterThanOrEqual(6)
    // A video only a chord site names (its oEmbed failed) is not listed.
    expect(PLAYLIST.flatMap((e) => e.originals).some((o) => o.url.includes('2h9PkrYR1YI'))).toBe(false)
  })

  it('suggests the playing style of each kind of piece', () => {
    for (const e of PLAYLIST) {
      if (e.kind === 'long-song') expect(e.style, e.id).toBe('urtiin-duu')
      if (e.kind === 'instrumental') expect(e.style, e.id).toBe('tatlaga')
      // Inner Mongolian pieces (their titles are still Chinese).
      if (/\p{Script=Han}/u.test(e.titleMn)) expect(e.style, e.id).toBe('inner-mongolian')
      if (e.rights === 'copyrighted' && !/\p{Script=Han}/u.test(e.titleMn)) expect(e.style, e.id).toBe('khalkh-stage')
    }
    // Long songs are sung, so their originals are compared as voice (or ensemble) recordings.
    for (const e of PLAYLIST.filter((p) => p.kind === 'long-song')) expect(['voice', 'ensemble']).toContain(e.referenceKind)
  })
})

describe('validatePlaylist', () => {
  it('reports duplicates, missing songs, bad links and unknown technique ids', () => {
    const problems = validatePlaylist(
      [
        entry({ id: 'a', songId: 'no-such-song' }),
        entry({ id: 'a', originals: [{ label: 'Video', url: 'http://example.com/v' }] }),
        entry({ id: 'b', titleMn: ' ', techniques: ['tsatsal_harmonc', 'Free-text label'] }),
        entry({ id: 'c', originals: [{ label: '', url: 'not a url' }], match: ['!!'] }),
        entry({
          id: 'd',
          originals: [
            { label: 'One', url: 'https://www.youtube.com/watch?v=abc' },
            { label: 'Two', url: 'https://www.youtube.com/watch?v=abc' }
          ],
          style: 'jazz' as PlaylistEntry['style'],
          referenceKind: 'kazoo' as PlaylistEntry['referenceKind']
        })
      ],
      SONG_IDS
    )
    expect(problems).toEqual([
      'a: bundled song “no-such-song” does not exist.',
      'Duplicate id “a”.',
      'a: “http://example.com/v” is not an https URL.',
      'b: both titles are required.',
      'b: unknown technique id “tsatsal_harmonc”.',
      'c: a link has no label.',
      'c: “not a url” is not an https URL.',
      'c: empty match keyword.',
      'd: “https://www.youtube.com/watch?v=abc” is listed twice.',
      'd: unknown style “jazz”.',
      'd: unknown reference kind “kazoo”.'
    ])
  })

  it('accepts https links only', () => {
    expect(isHttpsUrl('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(isHttpsUrl('http://www.youtube.com/watch?v=abc')).toBe(false)
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpsUrl('youtube.com')).toBe(false)
  })
})

describe('title matching', () => {
  it('ignores case, spaces, punctuation and accents in either script', () => {
    expect(normalizeTitle('Maamuu naash-ir!')).toBe('maamuunaashir')
    expect(normalizeTitle('МААМУУ Нааш ир')).toBe('маамуунаашир')
    expect(normalizeTitle('Tülekhe')).toBe('tulekhe')
    const e = entry({ match: ['maamuu', 'маамуу'] })
    expect(titleMatches(e, 'MAAMUU NAASHIR (MuseScore)')).toBe(true)
    expect(titleMatches(e, 'Маамуу нааш ир — ноот')).toBe(true)
    expect(titleMatches(e, 'Jonon khar')).toBe(false)
  })

  it('matches the titles themselves but not very short keywords', () => {
    expect(titleMatches(entry({ titleLatin: 'Jonon Khar', titleMn: 'Жонон хар' }), 'jonon-khar.musicxml')).toBe(true)
    expect(titleMatches(entry({ titleLatin: 'Jonon Khar', titleMn: 'Жонон хар', match: ['jo'] }), 'Jolly tune')).toBe(false)
  })

  it('accepts two Chinese characters as a keyword', () => {
    const hongyan = entry({ titleMn: '鸿雁', titleLatin: 'Hongyan (Wild Geese)', match: ['鸿雁'] })
    expect(titleMatches(hongyan, '鸿雁 马头琴')).toBe(true)
    expect(titleMatches(entry({ match: ['马'] }), '万马奔腾')).toBe(false)
  })

  it('tells the Jonon pieces apart', () => {
    const khar = PLAYLIST.find((e) => e.id === 'jonon-khar')!
    const khongor = PLAYLIST.find((e) => e.id === 'jonon-khongor')!
    expect(titleMatches(khar, 'Жонон хар морины явдал (arr.)')).toBe(true)
    expect(titleMatches(khar, 'Jonon Khongor Mori')).toBe(false)
    expect(titleMatches(khongor, 'Jonon Khongor Mori')).toBe(true)
    expect(titleMatches(khongor, 'Jonon khar')).toBe(false)
  })
})

describe('resolveSong', () => {
  const library: LibrarySong[] = [
    { id: '07-maamuu-naash-ir', title: 'Maamuu Naash Ir (Маамуу нааш ир)', builtIn: true },
    { id: 'import:maamuu.mxl', title: 'Maamuu naashir', builtIn: false },
    { id: 'import:other.mid', title: 'Something else', builtIn: false }
  ]
  const bundled = entry({ songId: '07-maamuu-naash-ir', match: ['maamuu'] })
  const unbundled = entry({ songId: null, match: ['maamuu'] })

  it('prefers an explicit link, then the bundled song, then an import matched by title', () => {
    expect(resolveSong(bundled, 'import:other.mid', library)).toEqual({ kind: 'linked', songId: 'import:other.mid' })
    expect(resolveSong(bundled, null, library)).toEqual({ kind: 'bundled', songId: '07-maamuu-naash-ir' })
    expect(resolveSong(unbundled, null, library)).toEqual({ kind: 'matched', songId: 'import:maamuu.mxl' })
    // Built-in songs are never "matched": only the bundled songId links them.
    expect(resolveSong(entry({ match: ['maamuu'] }), null, library.slice(0, 1))).toEqual({ kind: 'missing' })
  })

  it('falls back when a linked import was removed, and never auto-matches after an explicit unlink', () => {
    expect(resolveSong(bundled, 'import:gone.mid', library)).toEqual({ kind: 'bundled', songId: '07-maamuu-naash-ir' })
    expect(resolveSong(unbundled, 'import:gone.mid', library)).toEqual({ kind: 'matched', songId: 'import:maamuu.mxl' })
    expect(resolveSong(unbundled, false, library)).toEqual({ kind: 'missing' })
    expect(resolveSong(bundled, false, library)).toEqual({ kind: 'bundled', songId: '07-maamuu-naash-ir' })
  })

  it('resolves every bundled playlist entry against the real library', () => {
    const real: LibrarySong[] = SONG_IDS.map((id) => ({ id, title: id, builtIn: true }))
    for (const e of PLAYLIST.filter((p) => p.songId)) expect(resolveSong(e, null, real).kind).toBe('bundled')
  })
})

describe('play-all queue', () => {
  const entries = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })]
  const queue = playableQueue(entries, (e) => (e.id === 'b' ? { kind: 'missing' } : { kind: 'bundled', songId: e.id }))

  it('keeps playlist order and skips entries without a score', () => {
    expect(queue).toEqual(['a', 'c'])
  })

  it('advances to the next playable entry and ends after the last', () => {
    expect(nextInQueue(queue, null)).toBe('a')
    expect(nextInQueue(queue, 'a')).toBe('c')
    expect(nextInQueue(queue, 'c')).toBeNull()
    expect(nextInQueue(queue, 'b')).toBe('a')
    expect(nextInQueue([], null)).toBeNull()
  })
})

describe('comparison excerpt and A/B alignment', () => {
  it('analyses a little more than our length from the melody start, within 20–90 s', () => {
    expect(excerptWindow(180, 12, 40)).toEqual({ start: 12, duration: 50 })
    expect(excerptWindow(180, 0, 8)).toEqual({ start: 0, duration: 20 })
    expect(excerptWindow(600, 30, 300)).toEqual({ start: 30, duration: MAX_EXCERPT_SECONDS })
    // Clamped to the recording.
    expect(excerptWindow(30, 25, 40)).toEqual({ start: 25, duration: 5 })
    expect(excerptWindow(30, 99, 40)).toEqual({ start: 29, duration: 1 })
    expect(excerptWindow(30, -3, 10)).toEqual({ start: 0, duration: 20 })
    expect(excerptWindow(30, Number.NaN, 10)).toEqual({ start: 0, duration: 20 })
  })

  it('analyses a chosen length instead (a section of a long recording), within 2–90 s', () => {
    expect(excerptWindow(600, 120, 40, 30)).toEqual({ start: 120, duration: 30 })
    expect(excerptWindow(600, 120, 40, 500)).toEqual({ start: 120, duration: MAX_EXCERPT_SECONDS })
    expect(excerptWindow(600, 0, 40, 0.5)).toEqual({ start: 0, duration: 2 })
    expect(excerptWindow(130, 120, 40, 30)).toEqual({ start: 120, duration: 10 })
    // No (or no valid) length: automatic.
    expect(excerptWindow(600, 0, 40, null)).toEqual({ start: 0, duration: 50 })
    expect(excerptWindow(600, 0, 40, 0)).toEqual({ start: 0, duration: 50 })
    expect(excerptWindow(600, 0, 40, Number.NaN)).toEqual({ start: 0, duration: 50 })
  })

  it('maps a position to the same point of the melody in the other version', () => {
    // 3 s into the melody of the original (which starts at 12 s) is 3 s after ours starts at 0.05 s.
    expect(mapAbPosition(15, 12, 0.05, 60)).toBeCloseTo(3.05)
    expect(mapAbPosition(3.05, 0.05, 12, 180)).toBeCloseTo(15)
    expect(mapAbPosition(1, 12, 0.05, 60)).toBe(0)
    expect(mapAbPosition(200, 12, 0.05, 60)).toBe(60)
  })

  it('reads the melody start as typed, without turning an empty field into 0', () => {
    expect(parseSeconds('12.5')).toBe(12.5)
    expect(parseSeconds(' 3 ')).toBe(3)
    expect(parseSeconds('0')).toBe(0)
    expect(parseSeconds('')).toBeNull()
    expect(parseSeconds('  ')).toBeNull()
    expect(parseSeconds('-1')).toBeNull()
    expect(parseSeconds('1e400')).toBeNull()
    expect(parseSeconds('abc')).toBeNull()
  })
})

describe('cacheEvictions', () => {
  const MB = 1024 * 1024
  const limits = { maxEntries: 3, maxBytes: 100 * MB }

  it('drops the least recently used entries beyond the entry limit', () => {
    const entries = ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, bytes: MB }))
    expect(cacheEvictions(entries, limits)).toEqual(['a', 'b'])
    expect(cacheEvictions(entries.slice(0, 3), limits)).toEqual([])
    expect(cacheEvictions([], limits)).toEqual([])
  })

  it('drops old entries until the rest fit the byte budget, but keeps the newest even when it alone is larger', () => {
    // Three minutes of stereo float at 44.1 kHz are ~64 MB.
    const entries = [
      { key: 'a', bytes: 40 * MB },
      { key: 'b', bytes: 40 * MB },
      { key: 'c', bytes: 64 * MB }
    ]
    expect(cacheEvictions(entries, limits)).toEqual(['a', 'b'])
    expect(cacheEvictions([{ key: 'long', bytes: 300 * MB }], limits)).toEqual([])
    expect(cacheEvictions([{ key: 'old', bytes: 10 * MB }, { key: 'long', bytes: 300 * MB }], limits)).toEqual(['old'])
  })

  it('keeps entries that are still being made', () => {
    const entries = [
      { key: 'pending', bytes: null },
      { key: 'a', bytes: MB },
      { key: 'b', bytes: MB },
      { key: 'c', bytes: MB }
    ]
    expect(cacheEvictions(entries, limits)).toEqual(['a'])
    expect(cacheEvictions([{ key: 'p1', bytes: null }, { key: 'p2', bytes: null }, { key: 'p3', bytes: null }, { key: 'p4', bytes: null }], limits)).toEqual([])
  })
})

describe('listeningGain', () => {
  const sr = 8000
  const sine = (seconds: number, amp: number) => Float32Array.from({ length: seconds * sr }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / sr))
  const rmsDb = (x: Float32Array, gain: number) => 10 * Math.log10(x.reduce((a, v) => a + (v * gain) ** 2, 0) / x.length)

  it('brings the audible part to the listening level, ignoring silence', () => {
    const tone = sine(2, 0.05)
    expect(rmsDb(tone, listeningGain([tone], sr))).toBeCloseTo(LISTENING_RMS_DB, 1)
    // Two seconds of silence before the tone do not make it louder.
    const padded = new Float32Array(4 * sr)
    padded.set(tone, 2 * sr)
    expect(listeningGain([padded], sr)).toBeCloseTo(listeningGain([tone], sr), 3)
    // Stereo: both channels count.
    expect(listeningGain([tone, tone], sr)).toBeCloseTo(listeningGain([tone], sr), 6)
  })

  it('never pushes peaks to full scale, and leaves silence alone', () => {
    const loud = sine(1, 0.9)
    const clicky = sine(1, 0.01)
    clicky[100] = 0.8
    expect(listeningGain([loud], sr)).toBeLessThan(1.1)
    expect(listeningGain([clicky], sr) * 0.8).toBeLessThanOrEqual(0.98)
    expect(listeningGain([new Float32Array(sr)], sr)).toBe(1)
    expect(listeningGain([], sr)).toBe(1)
  })
})

describe('formatMeasure', () => {
  it('scales decimals to the magnitude and places the unit', () => {
    expect(formatMeasure(5.634, 'Hz')).toBe('5.63 Hz')
    expect(formatMeasure(233.4, 'Hz')).toBe('233 Hz')
    expect(formatMeasure(-12.04, 'dB')).toBe('−12.0 dB')
    expect(formatMeasure(34.2, '¢')).toBe('34.2¢')
    expect(formatMeasure(12, '%')).toBe('12.0%')
    expect(formatMeasure(1.5, 'cents', { signed: true })).toBe('+1.50 cents')
    expect(formatMeasure(-0.001, 'dB', { signed: true })).toBe('0.00 dB')
    expect(formatMeasure(null, 'Hz')).toBe('—')
    expect(formatMeasure(Number.NaN, 'Hz')).toBe('—')
  })
})

describe('blind trials', () => {
  /** A fixed sequence of "random" numbers. */
  const sequence = (...values: number[]) => {
    let i = 0
    return () => values[i++ % values.length]!
  }

  it('plays the two sources in random order', () => {
    expect(createBlindTrial('ours-vs-original', ['original', 'ours'], 60, sequence(0.2, 0.5, 0.5)).order).toEqual(['original', 'ours'])
    expect(createBlindTrial('ours-vs-original', ['original', 'ours'], 60, sequence(0.7, 0.5, 0.5)).order).toEqual(['ours', 'original'])
    expect(createBlindTrial('style-vs-style', ['as-written', 'urtiin-duu'], 60, sequence(0.9, 0, 0)).order).toEqual(['urtiin-duu', 'as-written'])
  })

  it('takes an 8–10 s excerpt at a random point that both versions have', () => {
    const { min, max } = BLIND_EXCERPT_SECONDS
    expect(createBlindTrial('ours-vs-original', ['original', 'ours'], 60, sequence(0, 0, 0))).toMatchObject({ at: 0, seconds: min })
    expect(createBlindTrial('ours-vs-original', ['original', 'ours'], 60, sequence(0, 0.5, 0.5))).toMatchObject({ at: 25.5, seconds: 9 })
    for (let k = 0; k < 200; k++) {
      const t = createBlindTrial('ours-vs-original', ['original', 'ours'], 30)
      expect(t.seconds).toBeGreaterThanOrEqual(min)
      expect(t.seconds).toBeLessThanOrEqual(max)
      expect(t.at).toBeGreaterThanOrEqual(0)
      expect(t.at + t.seconds).toBeLessThanOrEqual(30)
      expect(Math.round(t.at * 10)).toBeCloseTo(t.at * 10, 6)
    }
  })

  it('plays the whole melody when it is shorter than an excerpt', () => {
    expect(createBlindTrial('style-vs-style', ['as-written', 'tatlaga'], 5.26, sequence(0.3, 0.9, 0.9))).toMatchObject({ at: 0, seconds: 5.2 })
    expect(createBlindTrial('style-vs-style', ['as-written', 'tatlaga'], -1, sequence(0.3))).toMatchObject({ at: 0, seconds: 0 })
  })

  it('computes the chance of identifying ours by guessing', () => {
    expect(binomialTail(0, 10)).toBe(1)
    expect(binomialTail(3, 4)).toBeCloseTo(5 / 16, 12)
    expect(binomialTail(6, 10)).toBeCloseTo(0.376953125, 12)
    expect(binomialTail(10, 10)).toBeCloseTo(1 / 1024, 12)
    expect(binomialTail(11, 10)).toBe(0)
    expect(binomialTail(1, 0)).toBe(1)
  })
})

const answer = (patch: Partial<BlindAnswer>): BlindAnswer => ({
  at: '2026-09-27T10:00:00.000Z',
  mode: 'ours-vs-original',
  order: ['original', 'ours'],
  excerpt: { at: 3, seconds: 9 },
  moreReal: 'original',
  guessedOurs: 'ours',
  oursStyle: null,
  referenceName: 'maamuu.mp3',
  room: 'dry',
  ...patch
})

describe('blindSummary', () => {
  it('counts identifications and preferences against the original', () => {
    const s = blindSummary([
      answer({}),
      answer({ order: ['ours', 'original'], guessedOurs: 'original', moreReal: 'ours' }),
      answer({ guessedOurs: null, moreReal: null }),
      answer({ guessedOurs: 'ours', moreReal: 'ours' })
    ])
    expect(s.original).toEqual({ trials: 4, guesses: 3, identified: 2, p: 0.5, oursMoreReal: 2, originalMoreReal: 1, undecided: 1 })
    expect(s.styles).toEqual([])
  })

  it('tallies style pairs whichever order they played in', () => {
    const style = (order: BlindAnswer['order'], moreReal: BlindAnswer['moreReal']) => answer({ mode: 'style-vs-style', order, moreReal, guessedOurs: null, referenceName: null })
    const s = blindSummary([
      style(['urtiin-duu', 'as-written'], 'urtiin-duu'),
      style(['as-written', 'urtiin-duu'], 'urtiin-duu'),
      style(['as-written', 'urtiin-duu'], null),
      style(['tatlaga', 'khalkh-stage'], 'khalkh-stage')
    ])
    expect(s.original.trials).toBe(0)
    expect(s.original.p).toBeNull()
    expect(s.styles).toEqual([
      { a: 'as-written', b: 'urtiin-duu', trials: 3, aWins: 0, bWins: 2, undecided: 1 },
      { a: 'khalkh-stage', b: 'tatlaga', trials: 1, aWins: 1, bWins: 0, undecided: 0 }
    ])
    expect(blindLines(s)[0]).toMatch(/^As written vs .+, 3 blind trials: more like a real morin khuur: As written 0, .+ 2, can’t tell 1\.$/)
  })
})

describe('normalizeFeedback', () => {
  it('fills in fields that older versions did not store', () => {
    const old = { link: 'import:a.mid', rating: 4, notes: 'ok', comparison: null, originalStart: 12 }
    expect(normalizeFeedback(old)).toEqual({ ...EMPTY_FEEDBACK, link: 'import:a.mid', rating: 4, notes: 'ok', originalStart: 12 })
    expect(normalizeFeedback(undefined)).toEqual(EMPTY_FEEDBACK)
    expect(normalizeFeedback({ link: false })).toEqual({ ...EMPTY_FEEDBACK, link: false })
  })

  it('drops invalid values instead of failing on them', () => {
    const f = normalizeFeedback({
      rating: 9,
      notes: 42,
      originalStart: -3,
      excerptLength: -1,
      referenceKind: 'kazoo',
      style: 'jazz',
      comparison: { rows: 'none' },
      blind: [answer({}), { mode: 'ours-vs-original' }, answer({ order: ['original', 'jazz' as BlindAnswer['order'][1]] }), 'x']
    })
    expect(f).toEqual({ ...EMPTY_FEEDBACK, rating: 5, blind: [answer({})] })
    expect(normalizeFeedback({ excerptLength: 30, referenceKind: 'voice', style: 'urtiin-duu' })).toMatchObject({ excerptLength: 30, referenceKind: 'voice', style: 'urtiin-duu' })
  })

  it('keeps the newest blind answers only', () => {
    const many = Array.from({ length: MAX_BLIND_ANSWERS + 5 }, (_, i) => answer({ excerpt: { at: i, seconds: 9 } }))
    const kept = normalizeFeedback({ blind: many }).blind
    expect(kept).toHaveLength(MAX_BLIND_ANSWERS)
    expect(kept[0]!.excerpt.at).toBe(5)
  })
})

describe('feedback export', () => {
  const entries = [entry({ id: 'maamuu', songId: '07-maamuu-naash-ir', referenceKind: 'voice' }), entry({ id: 'quiet', titleMn: 'Дасгал', titleLatin: 'Etude' })]
  const feedback: Record<string, EntryFeedback> = {
    maamuu: {
      ...EMPTY_FEEDBACK,
      rating: 3,
      notes: 'Vibrato is too slow.\nThe | bow attack is soft.',
      comparison: {
        at: '2026-09-27T10:00:00.000Z',
        referenceName: 'maamuu.mp3',
        room: 'dry',
        referenceKind: 'voice',
        style: null,
        excerpt: { start: 2, duration: 40 },
        score: 0.5,
        rows: [
          row({}),
          row({ feature: 'f0', label: 'Median pitch', sim: 262, ref: 263, delta: -1, tolerance: 15, unit: '¢', ok: true, hint: 'Same key.' }),
          row({ feature: 'attack', label: 'Note attack', sim: null, ref: 80, delta: null, tolerance: 32, unit: 'ms', ok: null, hint: 'Could not measure note attacks in our version.' })
        ]
      },
      blind: [answer({}), answer({ order: ['ours', 'original'], guessedOurs: 'ours', moreReal: 'ours' })]
    },
    quiet: { ...EMPTY_FEEDBACK, referenceKind: 'piano', style: 'as-written' }
  }
  const ctx = { generatedAt: '2026-09-27T12:00:00.000Z', settings: { soundboard: 'wood' }, songTitle: (id: string) => (id === '07-maamuu-naash-ir' ? 'Maamuu Naash Ir' : null) }
  const sourceOf = (e: PlaylistEntry) => (e.songId ? { kind: 'bundled' as const, songId: e.songId } : { kind: 'missing' as const })

  it('lists every entry in the JSON data, rated or not, with its reference kind, style and blind answers', () => {
    const data = feedbackData(entries, feedback, sourceOf, ctx)
    expect(data.format).toBe('mkhuur-playlist-feedback')
    expect(data.version).toBe(2)
    expect(data.entries.map((e) => [e.id, e.rating, e.song.title, e.referenceKind, e.style])).toEqual([
      ['maamuu', 3, 'Maamuu Naash Ir', 'voice', 'khalkh-stage'],
      ['quiet', null, null, 'piano', 'as-written']
    ])
    expect(data.entries[0]!.comparison?.rows).toHaveLength(3)
    expect(data.entries[0]!.blind.answers).toHaveLength(2)
    expect(data.entries[0]!.blind.summary.original).toMatchObject({ trials: 2, guesses: 2, identified: 2 })
    expect(data.entries[1]!.blind).toEqual({ summary: blindSummary([]), answers: [] })
  })

  it('writes a readable Markdown report with the JSON appended', () => {
    const md = feedbackMarkdown(entries, feedback, sourceOf, ctx)
    expect(md).toContain('| Маамуу нааш ир (Maamuu Naash Ir) | Maamuu Naash Ir | ★★★☆☆ | 50% | 2 |')
    expect(md).toContain('| Дасгал (Etude) | missing | — | — | — |')
    expect(md).toContain('> Vibrato is too slow.\n> The | bow attack is soft.')
    expect(md).toContain('(2.0–42.0 s, taken as voice (sung))')
    expect(md).toContain('| Vibrato rate | 4.20 Hz | 5.60 Hz | −1.40 Hz | no |')
    expect(md).toContain('| Note attack | — | 80.0 ms | — | — |')
    // Hints for what differs, then for what could not be measured; none for what matches.
    expect(md).toContain('- Our vibrato is slower than the original’s.\n- (not measured) Could not measure note attacks in our version.')
    expect(md).not.toContain('- Same key.')
    expect(md).toContain('- Ours vs the original, 2 blind trials: picked ours correctly in 2 of 2 (by chance: p = 0.25); more like a real morin khuur: ours 1, the original 1, can’t tell 0.')
    // Only pieces with feedback get a section.
    expect(md).not.toContain('## Дасгал')
    const json = /```json\n([\s\S]*)\n```/.exec(md)?.[1]
    expect(JSON.parse(json!)).toEqual(feedbackData(entries, feedback, sourceOf, ctx))
  })

  it('reports informational rows (measured, not scored) apart from unmeasured ones', () => {
    const key = row({ feature: 'transposition', label: 'Key (from the notes used)', sim: 5, ref: 0, delta: 5, tolerance: 0.5, unit: 'st', ok: null, informational: true, hint: 'Ours is in another key; this does not count against the score.' })
    const comparison = { ...feedback.maamuu!.comparison!, rows: [...feedback.maamuu!.comparison!.rows, key] }
    const md = feedbackMarkdown(entries, { ...feedback, maamuu: { ...feedback.maamuu!, comparison } }, sourceOf, ctx)
    expect(md).toContain('| not scored |')
    expect(md).toContain('\n- Ours is in another key; this does not count against the score.')
    expect(md).not.toContain('(not measured) Ours is in another key')
    expect(md).toContain('- (not measured) Could not measure note attacks in our version.')
  })
})
