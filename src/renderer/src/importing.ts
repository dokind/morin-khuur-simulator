import type { OpenedFile } from '@shared/ipc'
import type { Tuning } from '@renderer/core/instrument'
import { detectScoreFormat, importScoreFile, readSongJson } from '@renderer/core/notation'
import type { LibraryEntry } from '@renderer/songs'

/** File types the Song Tester can open. */
export const SONG_FILE_FILTERS = [
  { name: 'Songs and scores', extensions: ['json', 'mid', 'midi', 'kar', 'rmi', 'musicxml', 'xml', 'mxl'] },
  { name: 'Morin Khuur song', extensions: ['json'] },
  { name: 'MIDI', extensions: ['mid', 'midi', 'kar', 'rmi'] },
  { name: 'MusicXML', extensions: ['musicxml', 'xml', 'mxl'] }
]

export interface ImportedSong {
  entry: Omit<LibraryEntry, 'builtIn'>
  /** Notes about what the arranger changed (octave shifts, dropped chord notes…). */
  messages: string[]
}

/**
 * Turns an opened file into a library entry: `.mkhuur.json` is used as is; MIDI, MusicXML and
 * .mxl scores are arranged for the morin khuur (string, finger and bow chosen automatically).
 */
export async function importSongFile(file: OpenedFile, tuning?: Pick<Tuning, 'male' | 'female'>): Promise<ImportedSong> {
  const bytes = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data
  const format = detectScoreFormat(file.name, bytes)
  const id = `import:${file.name}`
  if (!format) {
    const { title, raw } = readSongJson(file.name, bytes)
    return { entry: { id, title, raw }, messages: [] }
  }
  const result = await importScoreFile(file.name, bytes, { tuning })
  return { entry: { id, title: result.raw.title, raw: result.raw }, messages: result.messages }
}
