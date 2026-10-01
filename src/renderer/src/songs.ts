import { parseSong, verifySong, type Issue, type Song, type VerificationReport } from '@renderer/core/notation'

/** Every `/songs/*.mkhuur.json` is bundled into the app at build time. */
const modules = import.meta.glob('../../../songs/*.mkhuur.json', { eager: true, import: 'default' })

export interface LibraryEntry {
  id: string
  title: string
  builtIn: boolean
  raw: unknown
}

export const BUILT_IN_SONGS: LibraryEntry[] = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, raw]) => ({
    id: path.split('/').pop()!.replace('.mkhuur.json', ''),
    title: typeof (raw as { title?: unknown }).title === 'string' ? (raw as { title: string }).title : path,
    builtIn: true,
    raw
  }))

export interface LoadedSong {
  song: Song | null
  parseIssues: Issue[]
  report: VerificationReport | null
}

const cache = new WeakMap<object, LoadedSong>()

/** Parses and verifies a song. Results are cached per raw object, so identity is stable across renders. */
export function loadSong(raw: unknown): LoadedSong {
  const cached = typeof raw === 'object' && raw !== null ? cache.get(raw) : undefined
  if (cached) return cached
  const { song, issues } = parseSong(raw)
  const loaded = { song, parseIssues: issues, report: song ? verifySong(song) : null }
  if (typeof raw === 'object' && raw !== null) cache.set(raw, loaded)
  return loaded
}
