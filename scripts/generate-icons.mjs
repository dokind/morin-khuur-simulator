// Renders build/icon.svg to build/icon.png (512 px, macOS/Linux/window icon) and build/icon.ico
// (16–256 px PNG-compressed entries, Windows installer + taskbar). Run: npm run icons
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const svg = readFileSync(join(buildDir, 'icon.svg'), 'utf8')

const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()

writeFileSync(join(buildDir, 'icon.png'), render(512))

// ICO container: header, one directory entry per size, then the PNG payloads.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map(render)
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = 6 + 16 * sizes.length
const entries = sizes.map((size, i) => {
  const e = Buffer.alloc(16)
  e.writeUInt8(size === 256 ? 0 : size, 0)
  e.writeUInt8(size === 256 ? 0 : size, 1)
  e.writeUInt8(0, 2)
  e.writeUInt8(0, 3)
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(images[i].length, 8)
  e.writeUInt32LE(offset, 12)
  offset += images[i].length
  return e
})
writeFileSync(join(buildDir, 'icon.ico'), Buffer.concat([header, ...entries, ...images]))
console.log(`Wrote build/icon.png and build/icon.ico (${sizes.join(', ')} px)`)
