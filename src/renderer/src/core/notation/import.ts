/** Song import: MIDI / MusicXML / .mxl file → arranged `.mkhuur.json` song, or a `.mkhuur.json` file as is. */

import type { Tuning } from '../instrument'
import { midiToMelody } from './import-midi'
import { musicXmlToMelody } from './import-musicxml'
import { arrangeMelody, type ArrangeResult, type MelodyInput } from './melody'
import { unzipMxl } from './unzip'
import { decodeXmlBytes } from './xml'

export * from './melody'
export * from './import-midi'
export * from './import-musicxml'
export * from './unzip'
export * from './xml'

export type ScoreFormat = 'midi' | 'musicxml' | 'mxl'

const FORMAT_LABEL: Record<ScoreFormat, string> = { midi: 'MIDI', musicxml: 'MusicXML', mxl: 'compressed MusicXML' }

/** Recognises a score by its magic bytes, falling back to the file extension. */
export function detectScoreFormat(fileName: string, bytes: Uint8Array): ScoreFormat | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  const magic = ascii(0, 4)
  // RIFF is also WAV/AVI; only the RMID form wraps a MIDI file.
  if (magic === 'MThd' || (magic === 'RIFF' && ascii(8, 12) === 'RMID')) return 'midi'
  if (magic === 'PK\u0003\u0004') return 'mxl'
  const head = decodeXmlBytes(bytes.subarray(0, 512)).trimStart()
  if (head.startsWith('<')) return 'musicxml'
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase()
  if (ext === 'mid' || ext === 'midi' || ext === 'kar' || ext === 'rmi') return 'midi'
  if (ext === 'mxl') return 'mxl'
  if (ext === 'musicxml' || ext === 'xml') return 'musicxml'
  return null
}

export interface ImportOptions {
  tuning?: Pick<Tuning, 'male' | 'female'>
  /** MIDI track index. */
  track?: number
  /** MusicXML part index. */
  part?: number
}

export interface ImportResult extends ArrangeResult {
  format: ScoreFormat
  melody: MelodyInput
}

/**
 * Reads a `.mkhuur.json` file: its JSON (checked later by parseSong) and a title for the library.
 * Throws a readable error when the file is not JSON or does not hold a song object.
 */
export function readSongJson(fileName: string, bytes: Uint8Array): { title: string; raw: unknown } {
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error(`${fileName} is neither a .mkhuur.json song nor a MIDI / MusicXML score.`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const held = raw === null ? 'null' : Array.isArray(raw) ? 'a list' : `a ${typeof raw}`
    throw new Error(`${fileName} is not a .mkhuur.json song: it holds ${held} instead of a song object.`)
  }
  const title = (raw as { title?: unknown }).title
  return { title: typeof title === 'string' && title.trim() ? title : fileName, raw }
}

/** Reads a MIDI, MusicXML or .mxl file and arranges its melody for the morin khuur. */
export async function importScoreFile(fileName: string, bytes: Uint8Array, options: ImportOptions = {}): Promise<ImportResult> {
  const format = detectScoreFormat(fileName, bytes)
  if (!format) throw new Error(`${fileName}: not a MIDI or MusicXML file.`)
  let melody: MelodyInput
  if (format === 'midi') melody = midiToMelody(bytes, { track: options.track })
  else {
    const xml = format === 'mxl' ? await unzipMxl(bytes) : decodeXmlBytes(bytes)
    melody = musicXmlToMelody(xml, { part: options.part })
  }
  const baseName = fileName.split(/[\\/]/).pop() ?? fileName
  if (!melody.title.trim()) melody = { ...melody, title: baseName.replace(/\.[^.]+$/, '') }
  const result = arrangeMelody(melody, { tuning: options.tuning, source: `${baseName} (${FORMAT_LABEL[format]})` })
  return { ...result, format, melody }
}
