import { describe, expect, it } from 'vitest'
import { musicXmlToMelody } from './import-musicxml'
import { readZipEntry, unzipMxl, zipEntries } from './unzip'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (data: Uint8Array) => {
  let c = 0xffffffff
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

interface ZipFile {
  name: string
  text: string
  store?: boolean
  /** Write zero sizes/CRC in the local header and a trailing data descriptor (general-purpose bit 3). */
  descriptor?: boolean
  /** Extra general-purpose flag bits, e.g. 1 = encrypted. */
  flags?: number
  /** Replace the stored data with these bytes (to simulate corruption). */
  data?: Uint8Array
}

/** Minimal ZIP writer: local headers, central directory, end record (optionally with a comment and prepended bytes). */
async function zip(files: ZipFile[], options: { comment?: number[]; prefix?: number[] } = {}): Promise<Uint8Array> {
  const prefix = options.prefix ?? []
  const out: number[] = [...prefix]
  const central: number[] = []
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff]
  const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
  for (const f of files) {
    const name = new TextEncoder().encode(f.name)
    const raw = new TextEncoder().encode(f.text)
    const data = f.data ?? (f.store ? raw : await deflateRaw(raw))
    const method = f.store ? 0 : 8
    const flags = (f.flags ?? 0) | (f.descriptor ? 8 : 0)
    const sizes = [...u32(crc32(raw)), ...u32(data.length), ...u32(raw.length)]
    const head = (withSizes: boolean) => [...u16(20), ...u16(flags), ...u16(method), ...u16(0), ...u16(0x21), ...(withSizes ? sizes : u32(0).concat(u32(0), u32(0))), ...u16(name.length), ...u16(0)]
    // Offsets are relative to the archive start, as a self-extractor stub would leave them.
    const offset = out.length - prefix.length
    out.push(...u32(0x04034b50), ...head(!f.descriptor), ...name, ...data)
    if (f.descriptor) out.push(...u32(0x08074b50), ...sizes)
    central.push(...u32(0x02014b50), ...u16(20), ...head(true), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name)
  }
  const cdOffset = out.length - prefix.length
  out.push(...central)
  const comment = options.comment ?? []
  out.push(...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(central.length), ...u32(cdOffset), ...u16(comment.length), ...comment)
  return new Uint8Array(out)
}

const SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><work><work-title>Zipped Tune</work-title></work>
<part-list><score-part id="P1"><part-name>Fiddle</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
<note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration></note></measure></part></score-partwise>`

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container><rootfiles>
  <rootfile full-path="scores/tune.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>
  <rootfile full-path="scores/tune.pdf" media-type="application/pdf"/>
</rootfiles></container>`

describe('unzipMxl', () => {
  it('follows META-INF/container.xml to the deflated score', async () => {
    const bytes = await zip([
      { name: 'mimetype', text: 'application/vnd.recordare.musicxml', store: true },
      { name: 'META-INF/container.xml', text: CONTAINER },
      { name: 'decoy.xml', text: '<not-the-score/>' },
      { name: 'scores/tune.musicxml', text: SCORE }
    ])
    const xml = await unzipMxl(bytes)
    expect(xml).toBe(SCORE)
    expect(musicXmlToMelody(xml).title).toBe('Zipped Tune')
  })

  it('falls back to the first XML file outside META-INF, stored uncompressed', async () => {
    const bytes = await zip([
      { name: 'META-INF/other.xml', text: '<x/>', store: true },
      { name: 'score.xml', text: SCORE, store: true }
    ])
    expect(await unzipMxl(bytes)).toBe(SCORE)
  })

  it('lists entries and reads them individually', async () => {
    const bytes = await zip([
      { name: 'a.txt', text: 'hello hello hello hello' },
      { name: 'b.txt', text: 'plain', store: true }
    ])
    const entries = zipEntries(bytes)
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([
      ['a.txt', 8, 23],
      ['b.txt', 0, 5]
    ])
    expect(new TextDecoder().decode(await readZipEntry(bytes, entries[0]!))).toBe('hello hello hello hello')
  })

  it('rejects non-ZIP data and archives without a score', async () => {
    await expect(unzipMxl(new TextEncoder().encode('not a zip at all, sorry'))).rejects.toThrow(/Not a ZIP archive/)
    await expect(unzipMxl(await zip([{ name: 'readme.txt', text: 'hi' }]))).rejects.toThrow(/No MusicXML score/)
  })
})

describe('unzipMxl robustness', () => {
  const containerFor = (path: string) => CONTAINER.replace('scores/tune.musicxml', path)

  it('reads entries written with data descriptors (sizes after the data)', async () => {
    const bytes = await zip([
      { name: 'META-INF/container.xml', text: CONTAINER, descriptor: true },
      { name: 'scores/tune.musicxml', text: SCORE, descriptor: true }
    ])
    expect(await unzipMxl(bytes)).toBe(SCORE)
  })

  it('finds the real end record when the archive comment contains its signature', async () => {
    const fake = [0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]
    const bytes = await zip([{ name: 'score.musicxml', text: SCORE }], { comment: [...fake, 0x21] })
    expect(await unzipMxl(bytes)).toBe(SCORE)
  })

  it('tolerates data prepended to the archive', async () => {
    const bytes = await zip([{ name: 'META-INF/container.xml', text: CONTAINER }, { name: 'scores/tune.musicxml', text: SCORE }], { prefix: Array(100).fill(0x4d) })
    expect(await unzipMxl(bytes)).toBe(SCORE)
  })

  it('matches container paths written with backslashes or "./"', async () => {
    for (const [stored, referenced] of [
      ['scores\\tune.musicxml', 'scores/tune.musicxml'],
      ['scores/tune.musicxml', './scores/tune.musicxml']
    ]) {
      const bytes = await zip([{ name: 'META-INF/container.xml', text: containerFor(referenced!) }, { name: 'decoy.xml', text: '<not-the-score/>' }, { name: stored!, text: SCORE }])
      expect(await unzipMxl(bytes)).toBe(SCORE)
    }
  })

  it('falls back to searching when container.xml is broken or points nowhere', async () => {
    for (const container of [containerFor('missing.musicxml'), '<container><rootfiles><rootfile', '\u0000\u0001 not xml']) {
      const bytes = await zip([{ name: 'META-INF/container.xml', text: container }, { name: 'tune.xml', text: SCORE }])
      expect(await unzipMxl(bytes)).toBe(SCORE)
    }
  })

  it('skips macOS resource forks and non-score XML when searching', async () => {
    const bytes = await zip([
      { name: '__MACOSX/._tune.musicxml', text: '\u0000\u0005\u0016\u0007 AppleDouble' },
      { name: '._tune.xml', text: 'resource fork' },
      { name: 'metadata.xml', text: '<metadata><title>not it</title></metadata>' },
      { name: 'tune.xml', text: SCORE }
    ])
    expect(await unzipMxl(bytes)).toBe(SCORE)
  })

  it('reports encrypted, truncated and corrupt entries clearly', async () => {
    const encrypted = await zip([{ name: 'score.musicxml', text: SCORE, flags: 1 }])
    await expect(unzipMxl(encrypted)).rejects.toThrow(/encrypted/)

    const corrupt = await zip([{ name: 'score.musicxml', text: SCORE, data: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x13]) }])
    await expect(unzipMxl(corrupt)).rejects.toThrow(/Corrupt ZIP entry score\.musicxml/)

    const whole = await zip([{ name: 'score.musicxml', text: SCORE, store: true }])
    const entry = zipEntries(whole)[0]!
    await expect(readZipEntry(whole.subarray(0, entry.offset + 40), entry)).rejects.toThrow(/truncated|Corrupt/)
  })

  it('refuses to inflate an entry beyond the size limit', async () => {
    const bytes = await zip([{ name: 'big.xml', text: 'x'.repeat(100_000) }])
    const entry = zipEntries(bytes)[0]!
    await expect(readZipEntry(bytes, entry, 1000)).rejects.toThrow(/too large/)
    expect((await readZipEntry(bytes, entry)).length).toBe(100_000)
  })
})
