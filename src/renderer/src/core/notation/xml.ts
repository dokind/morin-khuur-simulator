/**
 * Tiny non-validating XML parser, enough for MusicXML: elements, attributes, text and CDATA.
 * Declarations, processing instructions, DOCTYPE and comments are skipped; whitespace-only text
 * between elements is dropped. Namespaces are not resolved (prefixed names are kept verbatim).
 */

export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
}

export type XmlNode = XmlElement | string

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[ref] ?? whole
  })
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const NAME_RE = /^[^\s/>]+/

/** Parses a document and returns its root element. Throws when there is no element at all. */
export function parseXml(source: string): XmlElement {
  const src = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const doc: XmlElement = { name: '#document', attrs: {}, children: [] }
  const stack: XmlElement[] = [doc]
  // How many elements of each name are open, so a stray closing tag is ignored without scanning
  // the whole stack (which made crafted input quadratic).
  const openCount = new Map<string, number>()
  const top = () => stack[stack.length - 1]!
  const addText = (text: string) => {
    if (text.trim()) top().children.push(text)
  }

  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      addText(decodeEntities(src.slice(i)))
      break
    }
    if (lt > i) addText(decodeEntities(src.slice(i, lt)))

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end === -1 ? src.length : end + 3
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      addText(src.slice(lt + 9, end === -1 ? src.length : end))
      i = end === -1 ? src.length : end + 3
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      i = end === -1 ? src.length : end + 2
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in [...].
      let depth = 0
      let j = lt + 2
      for (; j < src.length; j++) {
        const c = src[j]
        if (c === '[') depth++
        else if (c === ']') depth--
        else if (c === '>' && depth <= 0) break
      }
      i = j + 1
    } else {
      const end = tagEnd(src, lt + 1)
      const body = src.slice(lt + 1, end)
      i = end + 1
      if (body.startsWith('/')) {
        const name = body.slice(1).trim()
        if (!openCount.get(name)) continue
        // Close the innermost open element of that name, and any left unclosed inside it.
        for (;;) {
          const closed = stack.pop()!
          openCount.set(closed.name, openCount.get(closed.name)! - 1)
          if (closed.name === name) break
        }
        continue
      }
      const selfClosing = body.endsWith('/')
      const inner = selfClosing ? body.slice(0, -1) : body
      const name = NAME_RE.exec(inner)?.[0]
      if (!name) continue
      const attrs: Record<string, string> = {}
      for (const m of inner.slice(name.length).matchAll(ATTR_RE)) attrs[m[1]!] = decodeEntities(m[2] ?? m[3] ?? '')
      const element: XmlElement = { name, attrs, children: [] }
      top().children.push(element)
      if (!selfClosing) {
        stack.push(element)
        openCount.set(name, (openCount.get(name) ?? 0) + 1)
      }
    }
  }

  const root = doc.children.find((c): c is XmlElement => typeof c !== 'string')
  if (!root) throw new Error('Not an XML document (no root element).')
  return root
}

/** Index of the `>` closing a tag, skipping quoted attribute values. */
function tagEnd(src: string, from: number): number {
  let quote = ''
  for (let j = from; j < src.length; j++) {
    const c = src[j]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return j
  }
  return src.length
}

export function xmlChildren(el: XmlElement | undefined, name?: string): XmlElement[] {
  if (!el) return []
  return el.children.filter((c): c is XmlElement => typeof c !== 'string' && (name === undefined || c.name === name))
}

export function xmlChild(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c): c is XmlElement => typeof c !== 'string' && c.name === name)
}

/** Follows a path of child names, e.g. xmlPath(score, 'work', 'work-title'). */
export function xmlPath(el: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
  return names.reduce<XmlElement | undefined>((cur, n) => xmlChild(cur, n), el)
}

/** Trimmed text content of an element and its descendants (iterative: deep nesting cannot overflow the stack). */
export function xmlText(el: XmlElement | undefined): string {
  if (!el) return ''
  const parts: string[] = []
  const pending: XmlNode[] = [el]
  while (pending.length) {
    const node = pending.pop()!
    if (typeof node === 'string') parts.push(node)
    else for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]!)
  }
  return parts.join('').trim()
}

/**
 * Decodes XML bytes: a byte-order mark wins, then UTF-16 detected from the leading "<", then the
 * `encoding` of the XML declaration (e.g. ISO-8859-1 from older exporters); UTF-8 otherwise.
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  if (bytes[0] === 0x3c && bytes[1] === 0x00) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0x00 && bytes[1] === 0x3c) return new TextDecoder('utf-16be').decode(bytes)
  let head = ''
  for (let i = 0; i < Math.min(bytes.length, 256); i++) head += String.fromCharCode(bytes[i]!)
  const declared = /^\s*<\?xml[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head)?.[1]
  // A UTF-16 label on bytes that are not UTF-16 (checked above) is stale, e.g. after re-saving.
  if (declared && !/^utf-?(8|16)/i.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes)
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}
