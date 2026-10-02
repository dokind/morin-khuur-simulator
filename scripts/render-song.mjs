// Renders a songs/*.mkhuur.json to a 48 kHz 16-bit mono WAV through the bowed-string worklet,
// in Node, with no browser: the string through the soundbox (--body=none for the dry string; no
// room or plucks — see src/renderer/src/audio/worklets/render-node.ts for what it leaves out).
//
//   node scripts/render-song.mjs songs/01-open-strings.mkhuur.json [out.wav] [--style=khalkh-stage] [--rate=48000] [--body=wood|hide|none]
//
// The TypeScript sources are loaded through Vite's SSR loader (already a dev dependency), with
// the same aliases vitest uses, so the script and the tests run the same code.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')))
const [input, output] = args.filter((a) => !a.startsWith('--'))
if (!input) {
  console.error('usage: node scripts/render-song.mjs <song.mkhuur.json> [out.wav] [--style=<id>] [--rate=<Hz>] [--body=wood|hide|none]')
  process.exit(2)
}
const outPath = resolve(output ?? `out/render/${basename(input).replace(/\.mkhuur\.json$/, '')}.wav`)

const server = await createServer({
  configFile: false,
  root,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: {
    alias: {
      '@renderer': resolve(root, 'src/renderer/src'),
      '@shared': resolve(root, 'src/shared')
    }
  }
})
let code = 0
try {
  const { parseSong, verifySong } = await server.ssrLoadModule('/src/renderer/src/core/notation/index.ts')
  const { encodeWav } = await server.ssrLoadModule('/src/renderer/src/core/wav.ts')
  const { detectPitch } = await server.ssrLoadModule('/src/renderer/src/core/pitch-detect.ts')
  const { centsBetween } = await server.ssrLoadModule('/src/renderer/src/core/pitch.ts')
  const { renderSongNode } = await server.ssrLoadModule('/src/renderer/src/audio/worklets/render-node.ts')

  const parsed = parseSong(JSON.parse(readFileSync(resolve(input), 'utf8')))
  if (!parsed.song) throw new Error(`parse failed: ${parsed.issues.map((i) => i.message).join('; ')}`)
  const report = verifySong(parsed.song)
  const sampleRate = Number(flags.rate ?? 48000)
  const r = renderSongNode(parsed.song, report, { sampleRate, ...(flags.style ? { style: flags.style } : {}), ...(flags.body ? { body: flags.body } : {}) })
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, encodeWav({ sampleRate, channels: [r.samples] }))

  let sumSq = 0
  for (const v of r.samples) sumSq += v * v
  const rmsDb = 10 * Math.log10(sumSq / r.samples.length)
  console.log(`${parsed.song.title}`)
  console.log(`  -> ${outPath}`)
  console.log(`  ${(r.samples.length / sampleRate).toFixed(2)} s at ${sampleRate} Hz, peak -1.0 dBFS, RMS ${rmsDb.toFixed(1)} dBFS, ${r.events.length} bowed events, ${r.skipped.length} skipped`)
  for (const e of r.events) {
    if (e.event.droneFreq) continue
    const from = e.start + Math.min(0.25, e.event.duration * 0.35)
    const to = e.start + e.event.duration * 0.85
    const est = to - from > 0.05 ? detectPitch(r.samples.subarray(Math.floor(from * sampleRate), Math.floor(to * sampleRate)), sampleRate, { maxFreq: 2500 }) : null
    const cents = est ? centsBetween(e.event.freq, est.freq) : NaN
    console.log(`  ${e.start.toFixed(2).padStart(7)} s  ${e.event.freq.toFixed(2).padStart(8)} Hz  ${Number.isNaN(cents) ? '   (too short)' : `${cents >= 0 ? '+' : ''}${cents.toFixed(2)} ct`}`)
  }
  for (const e of r.skipped) console.log(`  skipped ${e.event.technique} at ${e.start.toFixed(2)} s`)
} catch (err) {
  console.error(err instanceof Error ? err.stack : err)
  code = 1
} finally {
  await server.close()
}
process.exit(code)
