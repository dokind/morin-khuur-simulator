/** Minimal ZIP reader for compressed MusicXML (.mxl): stored and deflated entries, no ZIP64. */

import { decodeXmlBytes, parseXml, xmlChildren, xmlPath } from './xml'

export interface ZipEntry {
  name: string
  method: number
  /** General-purpose flags (bit 0: encrypted, bit 3: sizes in a trailing data descriptor). */
  flags: number
  compressedSize: number
  size: number
  /** Offset of the entry's local file header. */
  offset: number
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
/** Refuse to inflate more than this per entry (a "zip bomb" would otherwise exhaust memory). */
export const MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024

/** Lists the entries of a ZIP archive from its central directory. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32At = (p: number) => (p >= 0 && p + 4 <= bytes.length ? view.getUint32(p, true) : -1)

  // The end record sits at the very end unless the archive has a comment; a signature inside the
  // comment is only a fallback, so prefer the record whose comment length reaches the end exactly.
  let eocd = -1
  let fallback = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) !== EOCD) continue
    if (i + 22 + view.getUint16(i + 20, true) === bytes.length) {
      eocd = i
      break
    }
    if (fallback < 0) fallback = i
  }
  if (eocd < 0) eocd = fallback
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).')

  const count = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  let p = view.getUint32(eocd + 16, true)
  if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 archives are not supported.')
  // Data prepended to the archive (self-extractors, some uploaders) shifts every stored offset.
  let shift = 0
  if (count > 0 && u32At(p) !== CENTRAL && u32At(eocd - cdSize) === CENTRAL) {
    shift = eocd - cdSize - p
    p = eocd - cdSize
  }

  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL) throw new Error('Corrupt ZIP central directory.')
    const nameLength = view.getUint16(p + 28, true)
    const extraLength = view.getUint16(p + 30, true)
    const commentLength = view.getUint16(p + 32, true)
    const entry: ZipEntry = {
      name: new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      method: view.getUint16(p + 10, true),
      flags: view.getUint16(p + 8, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true)
    }
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) throw new Error('ZIP64 archives are not supported.')
    entry.offset += shift
    entries.push(entry)
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Uncompressed bytes of one entry (method 0 = stored, 8 = deflate), refusing to inflate past `maxBytes`. */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes = MAX_ZIP_ENTRY_BYTES): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (entry.flags & 1) throw new Error(`ZIP entry ${entry.name} is encrypted.`)
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== LOCAL) throw new Error(`Corrupt ZIP entry ${entry.name}.`)
  // Sizes come from the central directory, so entries written with data descriptors work too.
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  if (start + entry.compressedSize > bytes.length) throw new Error(`ZIP entry ${entry.name} is truncated.`)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method !== 8) throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}.`)
  return inflateRaw(data, entry.name, maxBytes)
}

async function inflateRaw(data: Uint8Array, name: string, maxBytes: number): Promise<Uint8Array> {
  const reader = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) break
      chunks.push(value)
    }
  } catch {
    throw new Error(`Corrupt ZIP entry ${name} (the compressed data is damaged).`)
  }
  if (total > maxBytes) {
    await reader.cancel().catch(() => undefined)
    throw new Error(`ZIP entry ${name} is too large (over ${maxBytes} bytes uncompressed).`)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** Archive paths compared the way writers actually store them ("./a", "a\\b" on Windows). */
const normalizePath = (path: string) => path.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '')

/** Extracts the score document from a compressed MusicXML (.mxl) archive. */
export async function unzipMxl(bytes: Uint8Array): Promise<string> {
  const entries = zipEntries(bytes)
  const byName = new Map(entries.map((e) => [normalizePath(e.name), e]))

  const container = byName.get('META-INF/container.xml')
  if (container) {
    let fullPath: string | undefined
    try {
      const rootfiles = xmlChildren(xmlPath(parseXml(decodeXmlBytes(await readZipEntry(bytes, container))), 'rootfiles'), 'rootfile')
      // The first rootfile is the score; later ones may be PDFs or other renderings.
      const preferred = rootfiles.find((r) => !r.attrs['media-type'] || r.attrs['media-type'].includes('musicxml')) ?? rootfiles[0]
      fullPath = preferred?.attrs['full-path']
    } catch {
      // A damaged container.xml: fall back to searching the archive.
    }
    const score = fullPath === undefined ? undefined : byName.get(normalizePath(fullPath))
    if (score) return decodeXmlBytes(await readZipEntry(bytes, score))
  }

  // No usable container: look for the score among the XML files, skipping metadata and the
  // "__MACOSX/._name" resource forks that macOS adds to archives.
  const candidates = entries
    .filter((e) => {
      const path = normalizePath(e.name)
      const base = path.slice(path.lastIndexOf('/') + 1)
      return !path.startsWith('META-INF/') && !path.startsWith('__MACOSX/') && !base.startsWith('._') && /\.(musicxml|xml)$/i.test(path)
    })
    .sort((a, b) => Number(/\.xml$/i.test(a.name)) - Number(/\.xml$/i.test(b.name)))
  if (candidates.length === 0) throw new Error('No MusicXML score found in the .mxl archive.')
  let first: string | null = null
  for (const entry of candidates) {
    const text = decodeXmlBytes(await readZipEntry(bytes, entry))
    if (/<score-(partwise|timewise)[\s>/]/.test(text)) return text
    first ??= text
  }
  return first!
}
