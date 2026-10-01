import { describe, expect, it } from 'vitest'
import { musicXmlToMelody } from './import-musicxml'
import { arrangeMelody } from './melody'
import { parseSong } from './parse'
import { verifySong } from './verify'

const score = (measures: string[], header = '', extraParts = '') => `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  ${header}
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    ${measures.map((m, i) => `<measure number="${i + 1}">${m}</measure>`).join('\n    ')}
  </part>
  ${extraParts}
</score-partwise>`

const attrs = (divisions = 1, beats = 4, beatType = 4, fifths = 0) =>
  `<attributes><divisions>${divisions}</divisions><key><fifths>${fifths}</fifths></key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time></attributes>`

const note = (pitch: string, duration: number, extra = '', voice = '1') => {
  const m = /^([A-G])(#|b)?(\d)$/.exec(pitch)!
  const alter = m[2] === '#' ? '<alter>1</alter>' : m[2] === 'b' ? '<alter>-1</alter>' : ''
  return `<note><pitch><step>${m[1]}</step>${alter}<octave>${m[3]}</octave></pitch><duration>${duration}</duration><voice>${voice}</voice>${extra}</note>`
}
const rest = (duration: number, voice = '1') => `<note><rest/><duration>${duration}</duration><voice>${voice}</voice></note>`
const simple = (melody: ReturnType<typeof musicXmlToMelody>) => melody.notes.map((n) => [n.startBeats, n.durationBeats, n.midi])

describe('musicXmlToMelody', () => {
  it('reads title, composer, key, time and tempo', () => {
    const xml = score(
      [
        `${attrs(2, 3, 4, -2)}
         <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>72</per-minute></metronome></direction-type><sound tempo="76"/></direction>
         ${note('C4', 2)}${note('D4', 2)}${note('E4', 2)}`
      ],
      `<work><work-title>Test &amp; Song</work-title></work><movement-title>Movement</movement-title>
       <identification><creator type="lyricist">Someone</creator><creator type="composer">Trad.</creator></identification>`
    )
    const melody = musicXmlToMelody(xml)
    expect(melody.title).toBe('Test & Song')
    expect(melody.composer).toBe('Trad.')
    expect(melody.keyPc).toBe(10) // two flats: B♭ major
    expect(melody.timeSignature).toEqual({ beats: 3, unit: 4 })
    expect(melody.tempoBpm).toBe(76)
    expect(simple(melody)).toEqual([
      [0, 1, 60],
      [1, 1, 62],
      [2, 1, 64]
    ])
    expect(musicXmlToMelody(xml, { title: 'Override' }).title).toBe('Override')
  })

  it('falls back to movement-title, metronome marks and the default tempo', () => {
    const dotted = score(
      [`${attrs()}<direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>80</per-minute></metronome></direction-type></direction>${note('C4', 4)}`],
      '<movement-title>Only Movement</movement-title>'
    )
    expect(musicXmlToMelody(dotted).title).toBe('Only Movement')
    expect(musicXmlToMelody(dotted).tempoBpm).toBe(120)
    const plain = musicXmlToMelody(score([`${attrs()}${note('C4', 4)}`]))
    expect(plain.title).toBe('')
    expect(plain.tempoBpm).toBe(90)
    const eighths = score([`${attrs()}<direction><direction-type><metronome><beat-unit>eighth</beat-unit><per-minute>132</per-minute></metronome></direction-type></direction>${note('C4', 4)}`])
    expect(musicXmlToMelody(eighths).tempoBpm).toBe(66)
  })

  it('merges tied notes across the bar line', () => {
    const melody = musicXmlToMelody(
      score([
        `${attrs(4)}${note('G4', 8)}${note('A4', 8, '<tie type="start"/><notations><tied type="start"/></notations>')}`,
        `${note('A4', 4, '<tie type="stop"/><notations><tied type="stop"/></notations>')}${note('A4', 4)}${rest(8)}`
      ])
    )
    expect(simple(melody)).toEqual([
      [0, 2, 67],
      [2, 3, 69],
      [5, 1, 69]
    ])
  })

  it('marks notes after the first under a slur', () => {
    const melody = musicXmlToMelody(
      score([
        `${attrs()}${note('C5', 1, '<notations><slur type="start" number="1"/></notations>')}${note('D5', 1)}${note('E5', 1, '<notations><slur type="stop" number="1"/></notations>')}${note('F5', 1)}`,
        // one slur ends where the next begins
        `${note('C5', 1, '<notations><slur type="start"/></notations>')}${note('D5', 1, '<notations><slur type="stop"/><slur type="start"/></notations>')}${note('E5', 1, '<notations><slur type="stop"/></notations>')}${note('F5', 1)}`
      ])
    )
    expect(melody.notes.map((n) => n.slur)).toEqual([false, true, true, false, false, true, true, false])
  })

  it('keeps only the top note of chords and skips grace notes', () => {
    const grace = '<note><grace slash="yes"/><pitch><step>B</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type></note>'
    const melody = musicXmlToMelody(
      score([`${attrs()}${note('C4', 2)}${note('G4', 2, '<chord/>')}${note('E4', 2, '<chord/>')}${grace}${note('F4', 1)}${rest(1)}`])
    )
    expect(simple(melody)).toEqual([
      [0, 2, 67],
      [2, 1, 65]
    ])
  })

  it('reads voice 1 only and follows backup/forward', () => {
    const melody = musicXmlToMelody(
      score([
        `${attrs(2)}${note('C5', 2)}<forward><duration>2</duration><voice>1</voice></forward>${note('D5', 4)}
         <backup><duration>8</duration></backup>${note('C3', 8, '', '2')}`,
        `${note('F3', 4, '', '2')}${note('G3', 4, '', '2')}<backup><duration>8</duration></backup>${note('E5', 8)}`
      ])
    )
    expect(simple(melody)).toEqual([
      [0, 1, 72],
      [2, 2, 74],
      [4, 4, 76]
    ])
    expect(melody.messages?.join(' ')).toMatch(/voice 1 only/)
  })

  it('advances correctly through time-signature and divisions changes', () => {
    const melody = musicXmlToMelody(
      score([
        `${attrs(1, 2, 4)}${note('C4', 1)}${note('D4', 1)}`,
        `<attributes><divisions>4</divisions><time><beats>6</beats><beat-type>8</beat-type></time></attributes>${note('E4', 6)}${note('F4', 6)}`,
        `${note('G4', 12)}`
      ])
    )
    expect(melody.timeSignature).toEqual({ beats: 2, unit: 4 })
    expect(simple(melody)).toEqual([
      [0, 1, 60],
      [1, 1, 62],
      [2, 1.5, 64],
      [3.5, 1.5, 65],
      [5, 3, 67]
    ])
    expect(melody.messages?.join(' ')).toMatch(/changes time signature 1 time/)
  })

  it('aligns a pickup measure to the bar line', () => {
    const melody = musicXmlToMelody(score([`${attrs()}${note('F4', 1)}`, note('Bb4', 4)]))
    expect(simple(melody)).toEqual([
      [3, 1, 65],
      [4, 4, 70]
    ])
  })

  it('picks the first part with pitched notes and finds tempo in another part', () => {
    const drums = `<part id="P0"><measure number="1">${attrs()}<direction><sound tempo="112"/></direction><note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>4</duration></note></measure></part>`
    const xml = score([`${attrs()}${note('A4', 4)}`]).replace('<part id="P1">', `${drums}<part id="P1">`)
    const melody = musicXmlToMelody(xml)
    expect(simple(melody)).toEqual([[0, 4, 69]])
    expect(melody.tempoBpm).toBe(112)
    expect(melody.messages?.join(' ')).toMatch(/part "Flute"/)
    expect(musicXmlToMelody(xml, { part: 0 }).notes).toEqual([])
    expect(() => musicXmlToMelody(xml, { part: 5 })).toThrow(/no part 5/)
  })

  it('reads score-timewise documents', () => {
    const xml = `<score-timewise><work><work-title>Timewise</work-title></work>
      <measure number="1"><part id="P1">${attrs()}${note('C4', 2)}${note('D4', 2)}</part></measure>
      <measure number="2"><part id="P1">${note('E4', 4)}</part></measure>
    </score-timewise>`
    const melody = musicXmlToMelody(xml)
    expect(melody.title).toBe('Timewise')
    expect(simple(melody)).toEqual([
      [0, 2, 60],
      [2, 2, 62],
      [4, 4, 64]
    ])
  })

  it('rejects documents that are not MusicXML', () => {
    expect(() => musicXmlToMelody('<html><body/></html>')).toThrow(/Not a MusicXML score/)
  })

  it('arranges into a song that verifies without errors', () => {
    const xml = score(
      [
        `${attrs(6, 6, 8, 1)}${note('D6', 3, '<notations><slur type="start"/></notations>')}${note('B5', 3)}${note('G5', 3, '<notations><slur type="stop"/></notations>')}${note('A5', 6, '<tie type="start"/>')}${note('A5', 3, '<tie type="stop"/>')}`,
        // eighth-note triplet in 6/8 (divisions 6 → a triplet eighth is 2)
        `${note('F#5', 2)}${note('G5', 2)}${note('A5', 2)}${note('D5', 3)}${rest(3)}${note('C3', 3)}${note('D3', 3)}`
      ],
      '<work><work-title>Arranged</work-title></work>'
    )
    const { raw, messages } = arrangeMelody(musicXmlToMelody(xml), { source: 'tune.musicxml (MusicXML)' })
    const { song, issues } = parseSong(raw)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    const report = verifySong(song!)
    expect(report.errors).toBe(0)
    expect(raw.timeSignature).toBe('6/8')
    expect(raw.key).toBe('G')
    expect(raw.notes[1]).toMatchObject({ slur: true, bow: raw.notes[0]!.bow })
    expect(messages.join(' ')).toMatch(/Transposed down 1 octave/)
    expect(raw.notes.map((n) => n.pitch)).toContain('F#4')
  })
})

describe('musicXmlToMelody edge cases', () => {
  const slur = (type: string, number = '1') => `<notations><slur type="${type}" number="${number}"/></notations>`
  const triplet = '<type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>'

  it('sounds transposing parts at concert pitch, key included', () => {
    const clarinet = `<attributes><divisions>1</divisions><key><fifths>2</fifths></key><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>`
    const melody = musicXmlToMelody(score([`${clarinet}${note('D5', 2)}${note('E5', 2)}`]))
    expect(simple(melody)).toEqual([
      [0, 2, 72],
      [2, 2, 74]
    ])
    expect(melody.keyPc).toBe(0) // written D major on a B♭ clarinet sounds in C
    expect(melody.messages?.join(' ')).toMatch(/down 2 semitone/)
    const guitar = `<attributes><divisions>1</divisions><transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose></attributes>`
    expect(simple(musicXmlToMelody(score([`${guitar}${note('E5', 4)}`])))).toEqual([[0, 4, 64]])
  })

  it('does not let a slur drawn over a tie leak onto later notes', () => {
    const melody = musicXmlToMelody(
      score([
        `${attrs()}${note('C5', 2, `<tie type="start"/><notations><tied type="start"/><slur type="start" number="1"/></notations>`)}${note('C5', 2, `<tie type="stop"/><notations><tied type="stop"/><slur type="stop" number="1"/></notations>`)}`,
        `${note('D5', 1)}${note('E5', 1)}${note('F5', 2)}`
      ])
    )
    expect(melody.notes.map((n) => [n.startBeats, n.durationBeats, n.slur])).toEqual([
      [0, 4, false],
      [4, 1, false],
      [5, 1, false],
      [6, 2, false]
    ])
  })

  it('handles overlapping numbered slurs and closes a slur left open across a rest', () => {
    const nested = musicXmlToMelody(
      score([`${attrs()}${note('C5', 1, slur('start', '1'))}${note('D5', 1, slur('start', '2'))}${note('E5', 1, slur('stop', '1'))}${note('F5', 1, slur('stop', '2'))}`, `${note('G5', 4)}`])
    )
    expect(nested.notes.map((n) => n.slur)).toEqual([false, true, true, true, false])
    // The stop is missing (e.g. it sits in another voice): a rest of a beat or more ends the slur.
    const open = musicXmlToMelody(score([`${attrs()}${note('C5', 1, slur('start'))}${note('D5', 1)}${rest(2)}`, `${note('E5', 2)}${note('F5', 2)}`]))
    expect(open.notes.map((n) => n.slur)).toEqual([false, true, false, false])
  })

  it('reads tuplets exactly and arranges them as triplet tokens', () => {
    const xml = score([`${attrs(3)}${note('C5', 1, triplet)}${note('D5', 1, triplet)}${note('E5', 1, triplet)}${note('F5', 3)}${note('G5', 6)}`])
    const melody = musicXmlToMelody(xml)
    expect(melody.notes.map((n) => n.startBeats)).toEqual([0, 1 / 3, 2 / 3, 1, 2])
    const { raw } = arrangeMelody(melody)
    expect(raw.notes.map((n) => [n.time, n.duration])).toEqual([
      ['0:0:0', '8t'],
      ['0:0:1.333333', '8t'],
      ['0:0:2.666667', '8t'],
      ['0:1:0', '4n'],
      ['0:2:0', '2n']
    ])
    expect(verifySong(parseSong(raw).song!).errors).toBe(0)
  })

  it('infers missing divisions from note types and ignores unusable ones', () => {
    const noDivisions = `<attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>`
    const melody = musicXmlToMelody(
      score([`${noDivisions}${note('C5', 480, '<type>quarter</type>')}${note('D5', 240, '<type>eighth</type>')}${note('E5', 720, '<type>quarter</type><dot/>')}`])
    )
    expect(simple(melody)).toEqual([
      [0, 1, 72],
      [1, 0.5, 74],
      [1.5, 1.5, 76]
    ])
    expect(melody.messages?.join(' ')).toMatch(/inferred 480 per quarter/)
    const negative = musicXmlToMelody(score([`<attributes><divisions>-2</divisions></attributes>${note('C5', 2)}${note('D5', 2)}`]))
    expect(simple(negative)).toEqual([
      [0, 2, 72],
      [2, 2, 74]
    ])
  })

  it('skips malformed pitches instead of producing absurd MIDI numbers', () => {
    const bad = (step: string, octave: string, alter = '') => `<note><pitch><step>${step}</step>${alter}<octave>${octave}</octave></pitch><duration>1</duration></note>`
    const melody = musicXmlToMelody(score([`${attrs()}${bad('C', '1e9')}${bad('C', '4.5')}${bad('H', '4')}${bad('C', '4', '<alter>40</alter>')}${note('D4', 1)}`]))
    expect(simple(melody)).toEqual([[4, 1, 62]]) // the skipped notes still advance time
    expect(melody.messages?.join(' ')).toMatch(/Skipped 4 note\(s\) with an unreadable pitch/)
  })

  it('ignores direction clutter and reads tempo text like "c. 60"', () => {
    const clutter = `<direction><direction-type><dynamics><ff/></dynamics></direction-type><sound dynamics="120"/></direction>
      <direction><direction-type><words>rit.</words></direction-type></direction><direction><direction-type><wedge type="crescendo"/></direction-type></direction>
      <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>
      <figured-bass><figure><figure-number>6</figure-number></figure><duration>1</duration></figured-bass>
      <print new-system="yes"/>`
    const metronome = `<direction><direction-type><metronome parentheses="yes"><beat-unit>half</beat-unit><per-minute>c. 60</per-minute></metronome></direction-type></direction>`
    const melody = musicXmlToMelody(score([`${attrs()}${clutter}${note('C5', 2)}${metronome}${note('D5', 2)}`]))
    expect(simple(melody)).toEqual([
      [0, 2, 72],
      [2, 2, 74]
    ])
    expect(melody.tempoBpm).toBe(120)
    const doubleDotted = `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><beat-unit-dot/><per-minute>40</per-minute></metronome></direction-type></direction>`
    expect(musicXmlToMelody(score([`${attrs()}${doubleDotted}${note('C5', 4)}`])).tempoBpm).toBe(70)
  })

  it('decodes entities and CDATA in titles and falls back to page credits', () => {
    expect(musicXmlToMelody(score([`${attrs()}${note('C5', 4)}`], '<work><work-title>Ts&#252;g &amp; Ch&#x4E2D; &lt;1&gt;</work-title></work>')).title).toBe('Tsüg & Ch中 <1>')
    expect(musicXmlToMelody(score([`${attrs()}${note('C5', 4)}`], '<work><work-title><![CDATA[A <b> & C]]></work-title></work>')).title).toBe('A <b> & C')
    const credits = '<credit page="1"><credit-type>title</credit-type><credit-words>Credit &amp; Title</credit-words></credit><credit page="1"><credit-type>composer</credit-type><credit-words>Anon</credit-words></credit>'
    const melody = musicXmlToMelody(score([`${attrs()}${note('C5', 4)}`], credits))
    expect(melody.title).toBe('Credit & Title')
    expect(melody.composer).toBe('Anon')
  })

  it('keeps chord tops and ties together when a tied chord crosses the bar line', () => {
    const melody = musicXmlToMelody(
      score([`${attrs()}${note('C5', 2)}${note('E5', 2, '<tie type="start"/>')}${note('G5', 2, '<chord/><tie type="start"/>')}`, `${note('E5', 1, '<tie type="stop"/>')}${note('G5', 1, '<chord/><tie type="stop"/>')}${note('A5', 3)}`])
    )
    expect(simple(melody)).toEqual([
      [0, 2, 72],
      [2, 3, 79],
      [5, 3, 81]
    ])
  })

  it('aligns a pickup in compound meter', () => {
    const six8 = '<attributes><divisions>2</divisions><time><beats>6</beats><beat-type>8</beat-type></time></attributes>'
    const melody = musicXmlToMelody(score([`${six8}${note('A4', 1)}`, `${note('D5', 3)}${note('C5', 1)}${note('B4', 1)}${note('A4', 1)}`]))
    expect(simple(melody)).toEqual([
      [2.5, 0.5, 69],
      [3, 1.5, 74],
      [4.5, 0.5, 72],
      [5, 0.5, 71],
      [5.5, 0.5, 69]
    ])
    expect(arrangeMelody(melody).raw.notes.map((n) => n.time)).toEqual(['0:2:2', '1:0:0', '1:1:2', '1:2:0', '1:2:2'])
  })

  it('reports chord reduction, grace notes and tempo changes', () => {
    const grace = '<note><grace/><pitch><step>A</step><octave>4</octave></pitch><voice>1</voice><type>eighth</type></note>'
    const tempo = (bpm: number) => `<direction><direction-type><words>tempo</words></direction-type><sound tempo="${bpm}"/></direction>`
    const melody = musicXmlToMelody(
      score([
        `${attrs()}${tempo(100)}${note('C4', 2)}${note('E4', 2, '<chord/>')}${note('G4', 2, '<chord/>')}${grace}${note('D4', 2)}${note('F4', 2, '<chord/>')}`,
        `${tempo(100)}${note('E4', 2)}${tempo(60)}${note('F4', 2)}`
      ])
    )
    expect(melody.notes.map((n) => n.midi)).toEqual([67, 65, 64, 65])
    expect(melody.tempoBpm).toBe(100)
    const messages = melody.messages!.join(' ')
    expect(messages).toMatch(/top note of each chord \(3 notes removed\)/)
    expect(messages).toMatch(/Left out 1 grace note/)
    expect(messages).toMatch(/changes tempo 1 time\(s\); only the first tempo is kept/)
  })
})

describe('musicXmlToMelody repeats and jumps', () => {
  const forward = '<barline location="left"><repeat direction="forward"/></barline>'
  const backward = (times = '') => `<barline location="right"><repeat direction="backward"${times ? ` times="${times}"` : ''}/></barline>`
  const endingStart = (n: string) => `<barline location="left"><ending number="${n}" type="start"/></barline>`
  const endingStop = (n: string, type = 'stop', repeat = '') => `<barline location="right"><ending number="${n}" type="${type}"/>${repeat}</barline>`
  const sound = (attributes: string, words = '') => `<direction><direction-type><words>${words}</words></direction-type><sound ${attributes}/></direction>`
  const words = (text: string) => `<direction><direction-type><words>${text}</words></direction-type></direction>`
  const pitches = (melody: ReturnType<typeof musicXmlToMelody>) => melody.notes.map((n) => n.midi)
  const C = 72
  const D = 74
  const E = 76
  const F = 77
  const G = 79

  it('plays a repeat with first and second endings (volta)', () => {
    const melody = musicXmlToMelody(
      score([
        `${attrs()}${forward}${note('C5', 4)}`,
        `${endingStart('1')}${note('D5', 4)}${endingStop('1', 'stop', '<repeat direction="backward"/>')}`,
        `${endingStart('2')}${note('E5', 4)}${endingStop('2', 'discontinue')}`
      ])
    )
    expect(simple(melody)).toEqual([
      [0, 4, C],
      [4, 4, D],
      [8, 4, C],
      [12, 4, E]
    ])
    expect(melody.messages).toContain('Played 1 repeat and first/second endings as written (3 bars in the score, 4 played).')
  })

  it('honours times="3", endings for several passes and a repeat back to the first bar', () => {
    const thrice = musicXmlToMelody(score([`${attrs()}${forward}${note('C5', 4)}`, `${note('D5', 4)}${backward('3')}`, note('E5', 4)]))
    expect(pitches(thrice)).toEqual([C, D, C, D, C, D, E])
    // No start-repeat: back to the beginning. Endings "1, 2" and "3" imply three passes.
    const passes = musicXmlToMelody(
      score([
        `${attrs()}${note('C5', 4)}`,
        `${endingStart('1, 2')}${note('D5', 4)}${endingStop('1, 2', 'stop', '<repeat direction="backward"/>')}`,
        `${endingStart('3')}${note('E5', 4)}${endingStop('3', 'discontinue')}`,
        note('F5', 4)
      ])
    )
    expect(pitches(passes)).toEqual([C, D, C, D, C, E, F])
  })

  it('keeps a pickup aligned when the repeat returns to it', () => {
    const melody = musicXmlToMelody(score([`${attrs()}${forward}${note('F4', 1)}`, note('Bb4', 4), `${note('C5', 3)}${backward()}`]))
    expect(simple(melody)).toEqual([
      [3, 1, 65],
      [4, 4, 70],
      [8, 3, 72],
      [11, 1, 65],
      [12, 4, 70],
      [16, 3, 72]
    ])
  })

  it('plays D.C. al Fine from <sound> and from words alone', () => {
    const viaSound = score([`${attrs()}${note('C5', 4)}`, `${note('D5', 4)}${sound('fine="yes"', 'Fine')}`, note('E5', 4), `${note('F5', 4)}${sound('dacapo="yes"', 'D.C. al Fine')}`])
    const viaWords = score([`${attrs()}${note('C5', 4)}`, `${note('D5', 4)}${words('Fine')}`, note('E5', 4), `${note('F5', 4)}${words('D.C. al Fine')}`])
    for (const xml of [viaSound, viaWords]) {
      const melody = musicXmlToMelody(xml)
      expect(simple(melody)).toEqual([
        [0, 4, C],
        [4, 4, D],
        [8, 4, E],
        [12, 4, F],
        [16, 4, C],
        [20, 4, D]
      ])
      expect(melody.messages).toContain('Played D.C. al Fine as written (4 bars in the score, 6 played).')
    }
  })

  it('does not repeat again after a D.C. and takes the last ending', () => {
    const melody = musicXmlToMelody(
      score([
        `${attrs()}${forward}${note('C5', 4)}`,
        `${endingStart('1')}${note('D5', 4)}${endingStop('1', 'stop', '<repeat direction="backward"/>')}`,
        `${endingStart('2')}${note('E5', 4)}${sound('fine="yes"')}${endingStop('2', 'discontinue')}`,
        `${note('F5', 4)}${sound('dacapo="yes"')}`
      ])
    )
    expect(pitches(melody)).toEqual([C, D, C, E, F, C, E])
    // A Fine inside the first ending: after the D.C. that ending is taken to reach it.
    const fineFirst = musicXmlToMelody(
      score([
        `${attrs()}${forward}${note('C5', 4)}`,
        `${endingStart('1')}${note('D5', 4)}${sound('fine="yes"')}${endingStop('1', 'stop', '<repeat direction="backward"/>')}`,
        `${endingStart('2')}${note('E5', 4)}${endingStop('2', 'discontinue')}`,
        `${note('F5', 4)}${sound('dacapo="yes"')}`
      ])
    )
    expect(pitches(fineFirst)).toEqual([C, D, C, E, F, C, D])
    expect(fineFirst.messages?.join(' ')).toMatch(/D\.C\. al Fine/)
  })

  it('plays D.S. al Coda with segno, To Coda and coda signs', () => {
    const segno = '<direction><direction-type><segno/></direction-type><sound segno="segno"/></direction>'
    const coda = '<direction><direction-type><coda/></direction-type><sound coda="coda"/></direction>'
    const melody = musicXmlToMelody(
      score([
        `${attrs()}${note('C5', 4)}`,
        `${segno}${note('D5', 4)}`,
        `${note('E5', 4)}${sound('tocoda="coda"', 'To Coda')}`,
        `${note('F5', 4)}${sound('dalsegno="segno"', 'D.S. al Coda')}`,
        `${coda}${note('G5', 4)}`
      ])
    )
    expect(pitches(melody)).toEqual([C, D, E, F, D, E, G])
    expect(melody.messages?.join(' ')).toMatch(/Played D\.S\. al Coda as written \(5 bars in the score, 7 played\)/)
    // The same written as text and signs only.
    const signs = musicXmlToMelody(
      score([
        `${attrs()}${note('C5', 4)}`,
        `<direction><direction-type><segno/></direction-type></direction>${note('D5', 4)}`,
        `${note('E5', 4)}${words('To Coda')}`,
        `${note('F5', 4)}${words('D.S. al Coda')}`,
        `<direction><direction-type><coda/></direction-type></direction>${note('G5', 4)}`
      ])
    )
    expect(pitches(signs)).toEqual([C, D, E, F, D, E, G])
  })

  it('starts a new ending group when a repeated section opens with its own 1st ending', () => {
    const melody = musicXmlToMelody(
      score([
        `${attrs()}${forward}${note('C5', 4)}`,
        `${endingStart('1')}${note('D5', 4)}${endingStop('1', 'stop', '<repeat direction="backward"/>')}`,
        `${endingStart('2')}${note('E5', 4)}${endingStop('2', 'discontinue')}`,
        `${forward}${endingStart('1')}${note('F5', 4)}${endingStop('1', 'stop', '<repeat direction="backward"/>')}`,
        `${endingStart('2')}${note('G5', 4)}${endingStop('2', 'discontinue')}`
      ])
    )
    expect(pitches(melody)).toEqual([C, D, C, E, F, G])
    // A start-repeat on a 2nd ending (":|: 2.") does not split it from its 1st ending.
    const doubleBar = musicXmlToMelody(
      score([
        `${attrs()}${forward}${note('C5', 4)}`,
        `${endingStart('1')}${note('D5', 4)}${endingStop('1', 'stop', '<repeat direction="backward"/>')}`,
        `${forward}${endingStart('2')}${note('E5', 4)}${endingStop('2', 'discontinue')}`,
        note('F5', 4)
      ])
    )
    expect(pitches(doubleBar)).toEqual([C, D, C, E, F])
  })

  it('does not carry a slur across a repeat, ending or coda jump', () => {
    const start = '<notations><slur type="start" number="1"/></notations>'
    const stop = '<notations><slur type="stop" number="1"/></notations>'
    const slurs = (melody: ReturnType<typeof musicXmlToMelody>) => melody.notes.flatMap((n, i) => (n.slur ? [i] : []))
    // The slur from the body into the 1st ending opens again on the second pass, which takes the 2nd.
    const volta = musicXmlToMelody(
      score([
        `${attrs()}${forward}${note('C5', 2)}${note('D5', 2, start)}`,
        `${endingStart('1')}${note('E5', 2, stop)}${note('F5', 2)}${endingStop('1', 'stop', '<repeat direction="backward"/>')}`,
        `${endingStart('2')}${note('G5', 2)}${note('A5', 2)}${endingStop('2', 'discontinue')}`,
        `${note('B5', 1)}${note('A5', 1)}${note('G5', 1)}${note('F5', 1)}`,
        `${note('E5', 1)}${note('D5', 1)}${note('C5', 2)}`
      ])
    )
    expect(pitches(volta)).toEqual([C, D, E, F, C, D, G, 81, 83, 81, G, F, E, D, C])
    expect(slurs(volta)).toEqual([2])
    const { raw } = arrangeMelody(volta)
    expect(raw.notes.flatMap((n, i) => (n.slur ? [i] : []))).toEqual([2])
    expect(verifySong(parseSong(raw).song!).errors).toBe(0)
    // After the D.S. the slur opens again in the To Coda bar and the jump skips its stop.
    const coda = musicXmlToMelody(
      score([
        `${attrs()}<direction><direction-type><segno/></direction-type><sound segno="s"/></direction>${note('C5', 4)}`,
        `${note('D5', 2)}${note('E5', 2, start)}${sound('tocoda="c"', 'To Coda')}`,
        `${note('F5', 2, stop)}${note('G5', 2)}${sound('dalsegno="s"', 'D.S. al Coda')}`,
        `<direction><direction-type><coda/></direction-type><sound coda="c"/></direction>${note('A5', 2)}${note('B5', 2)}`
      ])
    )
    expect(pitches(coda)).toEqual([C, D, E, F, G, C, D, E, 81, 83])
    expect(slurs(coda)).toEqual([3])
  })

  it('reads repeats and jumps from another part when the melody part lacks them', () => {
    const drums = `<part id="P0">
      <measure number="1">${attrs()}${forward}<note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>4</duration></note></measure>
      <measure number="2"><note><rest/><duration>4</duration></note>${backward()}</measure>
      <measure number="3"><note><rest/><duration>4</duration></note>${sound('dacapo="yes"')}</measure></part>`
    const xml = score([`${attrs()}${note('C5', 4)}`, note('D5', 4), note('E5', 4)]).replace('<part id="P1">', `${drums}<part id="P1">`)
    expect(pitches(musicXmlToMelody(xml))).toEqual([C, D, C, D, E, C, D, E])
  })

  it('warns about jumps it cannot follow and never loops forever', () => {
    const melody = musicXmlToMelody(
      score([
        `${attrs()}${note('C5', 4)}`,
        `${note('D5', 4)}${words('D.S. al Fine')}`,
        `${forward}${note('E5', 4)}`,
        `${endingStart('A')}${note('F5', 4)}${endingStop('A')}`,
        `${note('G5', 4)}${backward('1000')}${sound('dacapo="yes"')}`
      ])
    )
    const messages = melody.messages!.join('\n')
    expect(messages).toMatch(/D\.S\. \(dal segno\) in bar 2 but no segno sign/)
    expect(messages).toMatch(/ending number "A" in bar 4; played that ending on every pass/)
    expect(messages).toMatch(/bar 5 asks for 1000 plays; played it 16 times/)
    // 5 bars, the E–F–G section 16 times, then D.C. without repeats: C D + 16×(E F G) + C D E F G.
    expect(melody.notes).toHaveLength(2 + 16 * 3 + 5)
    const noEnd = musicXmlToMelody(score([`${attrs()}${forward}${note('C5', 4)}`, `${note('D5', 4)}${sound('tocoda="x"')}${sound('dacapo="yes"')}`]))
    expect(pitches(noEnd)).toEqual([C, D, C, D])
    expect(noEnd.messages?.join(' ')).toMatch(/start-repeat in bar 1 has no end-repeat[\s\S]*"To Coda" in bar 2 but no coda sign/)
  })
})
