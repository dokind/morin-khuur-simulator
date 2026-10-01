import { describe, expect, it } from 'vitest'
import { decodeEntities, decodeXmlBytes, parseXml, xmlChild, xmlChildren, xmlPath, xmlText } from './xml'

describe('parseXml', () => {
  const BOM = String.fromCharCode(0xfeff)
  const doc = parseXml(`${BOM}<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd" [
  <!ENTITY custom "x">
]>
<!-- a comment with <tags> inside -->
<score version='4.0' data-x="a &gt; b">
  <title>Tom &amp; Jerry &lt;3 &quot;hi&quot; &apos;yo&apos; &#65;&#x42;</title>
  <empty/>
  <tie type="start" />
  <note><pitch><step>C</step><octave>4</octave></pitch><chord/></note>
  <code><![CDATA[a < b && <c>]]></code>
  <mixed>one <b>two</b> three</mixed>
</score>`)

  it('builds an element tree with attributes', () => {
    expect(doc.name).toBe('score')
    expect(doc.attrs).toEqual({ version: '4.0', 'data-x': 'a > b' })
    expect(xmlChildren(doc).map((e) => e.name)).toEqual(['title', 'empty', 'tie', 'note', 'code', 'mixed'])
  })

  it('decodes named and numeric entities', () => {
    expect(xmlText(xmlChild(doc, 'title'))).toBe(`Tom & Jerry <3 "hi" 'yo' AB`)
  })

  it('handles self-closing tags with and without a space', () => {
    expect(xmlChild(doc, 'empty')).toEqual({ name: 'empty', attrs: {}, children: [] })
    expect(xmlChild(doc, 'tie')!.attrs).toEqual({ type: 'start' })
    expect(xmlChild(xmlChild(doc, 'note'), 'chord')).toBeDefined()
    expect(xmlText(xmlPath(doc, 'note', 'pitch', 'step'))).toBe('C')
  })

  it('keeps CDATA text verbatim and skips comments/doctype', () => {
    expect(xmlText(xmlChild(doc, 'code'))).toBe('a < b && <c>')
    expect(xmlText(xmlChild(doc, 'mixed'))).toBe('one two three')
  })

  it('tolerates quoted ">" in attributes and stray closing tags', () => {
    const el = parseXml(`<a title="x > y"><b>1</b></c></a>`)
    expect(el.attrs.title).toBe('x > y')
    expect(xmlText(el)).toBe('1')
  })

  it('throws when there is no element', () => {
    expect(() => parseXml('just text')).toThrow(/Not an XML document/)
  })
})

describe('helpers', () => {
  it('decodeEntities leaves unknown entities alone', () => {
    expect(decodeEntities('&unknown; &amp;amp; &#9835;')).toBe('&unknown; &amp; ♫')
  })

  it('decodeXmlBytes honours UTF-16 byte-order marks', () => {
    const utf16le = new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x61, 0x00, 0x2f, 0x00, 0x3e, 0x00])
    expect(decodeXmlBytes(utf16le)).toBe('<a/>')
    expect(decodeXmlBytes(new TextEncoder().encode('<ä/>'))).toBe('<ä/>')
  })
})

describe('parseXml robustness', () => {
  it('closes elements left open inside a closing tag and ignores unmatched ones', () => {
    const el = parseXml('<a><b><c>1</b><d>2</d></x></a>')
    expect(xmlChildren(el).map((e) => e.name)).toEqual(['b', 'd'])
    expect(xmlText(xmlPath(el, 'b', 'c'))).toBe('1')
  })

  it('stays linear on many stray closing tags and deep nesting', () => {
    const started = performance.now()
    const stray = parseXml(`<r>${'<a>'.repeat(20_000)}${'</b>'.repeat(20_000)}</r>`)
    const deep = parseXml(`${'<n>'.repeat(100_000)}deep${'</n>'.repeat(100_000)}`)
    expect(stray.name).toBe('r')
    expect(xmlText(deep)).toBe('deep')
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('decodeXmlBytes encodings', () => {
  const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p)))

  it('honours an ISO-8859-1 / windows-1252 declaration', () => {
    expect(decodeXmlBytes(bytes('<?xml version="1.0" encoding="ISO-8859-1"?><t>Caf', [0xe9], '</t>'))).toBe('<?xml version="1.0" encoding="ISO-8859-1"?><t>Café</t>')
    expect(decodeXmlBytes(bytes("<?xml version='1.0' encoding='windows-1252'?><t>", [0x93, 0x94], '</t>'))).toContain('<t>“”</t>')
  })

  it('detects UTF-16 without a byte-order mark', () => {
    const text = '<?xml version="1.0" encoding="UTF-16"?><t>ok</t>'
    const le = new Uint8Array(text.length * 2)
    const be = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) {
      le[i * 2] = text.charCodeAt(i)
      be[i * 2 + 1] = text.charCodeAt(i)
    }
    expect(decodeXmlBytes(le)).toBe(text)
    expect(decodeXmlBytes(be)).toBe(text)
  })

  it('ignores a stale UTF-16 label and unknown labels on 8-bit data', () => {
    expect(decodeXmlBytes(bytes('<?xml version="1.0" encoding="UTF-16"?><t>Sëchs</t>'))).toContain('<t>Sëchs</t>')
    expect(decodeXmlBytes(bytes('<?xml version="1.0" encoding="x-made-up"?><t>ä</t>'))).toContain('<t>ä</t>')
  })
})
