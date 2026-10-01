import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import type { CompareUrlOptions, DevPiece } from '@renderer/audio/reference'
import type { StyleId } from '@renderer/core/performance/types'
import {
  clampRating,
  EMPTY_FEEDBACK,
  feedbackData,
  feedbackMarkdown,
  isStyleId,
  MAX_BLIND_ANSWERS,
  normalizeFeedback,
  PLAYLIST,
  resolveSong,
  type BlindAnswer,
  type CompareRoom,
  type ComparisonSummary,
  type EntryFeedback,
  type PlaylistEntry,
  type ReferenceKind,
  type SongLink,
  type SongSource
} from '@renderer/core/playlist'
import { saveFile } from '@renderer/platform'
import { loadSong } from '@renderer/songs'
import { useSettings } from './settings'
import { allSongs, useSongs } from './songs'

interface PlaylistState {
  /** Per playlist entry: linked score, rating, notes, the last comparison and blind-test answers. */
  feedback: Record<string, EntryFeedback>
  selectedId: string
  /** How our version is rendered for comparisons. */
  compareRoom: CompareRoom
  /** Play all also plays each piece's original recording (when one is loaded) before ours. */
  withOriginals: boolean
  /** The two styles a style-vs-style blind trial compares. */
  blindStyles: [StyleId, StyleId]
  select(id: string): void
  /** Links an entry to a song id; `false` unlinks it (no title matching), null restores automatic matching. */
  link(entryId: string, link: SongLink): void
  setRating(entryId: string, rating: number | null): void
  setNotes(entryId: string, notes: string): void
  saveComparison(entryId: string, summary: ComparisonSummary): void
  setOriginalStart(entryId: string, seconds: number): void
  /** Seconds of the original to compare; null = automatic. */
  setExcerptLength(entryId: string, seconds: number | null): void
  /** What the loaded original is; null = the entry's default. */
  setReferenceKind(entryId: string, kind: ReferenceKind | null): void
  /** Playing style of our version; null = the entry's default. */
  setStyle(entryId: string, style: StyleId | null): void
  addBlindAnswer(entryId: string, answer: BlindAnswer): void
  clearBlindAnswers(entryId: string): void
  setCompareRoom(room: CompareRoom): void
  setWithOriginals(on: boolean): void
  setBlindStyles(styles: [StyleId, StyleId]): void
}

type Persisted = Pick<PlaylistState, 'feedback' | 'selectedId' | 'compareRoom' | 'withOriginals' | 'blindStyles'>

/** Whether the last write to localStorage failed (it is shared with the imported songs, ~5 MB in all). */
let saveFailed = false
const saveListeners = new Set<() => void>()

/**
 * localStorage that never throws. zustand writes inside every action, so a quota error would
 * escape from actions that already took effect: a finished comparison would be reported as failed
 * and every keystroke in the notes would throw.
 */
const storage: PersistStorage<Persisted> = {
  getItem: (name) => {
    try {
      const text = localStorage.getItem(name)
      return text === null ? null : (JSON.parse(text) as StorageValue<Persisted>)
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    let failed = false
    try {
      localStorage.setItem(name, JSON.stringify(value))
    } catch {
      failed = true
    }
    if (failed === saveFailed) return
    saveFailed = failed
    for (const l of saveListeners) l()
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name)
    } catch {
      // Nothing stored to remove.
    }
  }
}

/** True while the feedback cannot be saved for later sessions (it is kept in memory; Export feedback still works). */
export const feedbackSaveFailed = (): boolean => saveFailed

export function onFeedbackSaveChange(listener: () => void): () => void {
  saveListeners.add(listener)
  return () => saveListeners.delete(listener)
}

const update = (s: PlaylistState, id: string, patch: Partial<EntryFeedback>): Pick<PlaylistState, 'feedback'> => ({
  feedback: { ...s.feedback, [id]: { ...(s.feedback[id] ?? EMPTY_FEEDBACK), ...patch } }
})

const DEFAULT_BLIND_STYLES: [StyleId, StyleId] = ['as-written', 'khalkh-stage']

export const usePlaylist = create<PlaylistState>()(
  persist(
    (set) => ({
      feedback: {},
      selectedId: PLAYLIST[0]?.id ?? '',
      compareRoom: 'dry',
      withOriginals: true,
      blindStyles: DEFAULT_BLIND_STYLES,
      select: (selectedId) => set({ selectedId }),
      link: (entryId, link) => set((s) => update(s, entryId, { link })),
      setRating: (entryId, rating) => set((s) => update(s, entryId, { rating: clampRating(rating) })),
      setNotes: (entryId, notes) => set((s) => update(s, entryId, { notes })),
      saveComparison: (entryId, comparison) => set((s) => update(s, entryId, { comparison })),
      setOriginalStart: (entryId, seconds) => set((s) => update(s, entryId, { originalStart: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 })),
      setExcerptLength: (entryId, seconds) => set((s) => update(s, entryId, { excerptLength: seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null })),
      setReferenceKind: (entryId, referenceKind) => set((s) => update(s, entryId, { referenceKind })),
      setStyle: (entryId, style) => set((s) => update(s, entryId, { style })),
      addBlindAnswer: (entryId, answer) => set((s) => update(s, entryId, { blind: [...(s.feedback[entryId]?.blind ?? []), answer].slice(-MAX_BLIND_ANSWERS) })),
      clearBlindAnswers: (entryId) => set((s) => update(s, entryId, { blind: [] })),
      setCompareRoom: (compareRoom) => set({ compareRoom }),
      setWithOriginals: (withOriginals) => set({ withOriginals }),
      setBlindStyles: (blindStyles) => set({ blindStyles })
    }),
    {
      name: 'mkhuur.playlist',
      version: 1,
      storage,
      partialize: (s): Persisted => ({ feedback: s.feedback, selectedId: s.selectedId, compareRoom: s.compareRoom, withOriginals: s.withOriginals, blindStyles: s.blindStyles }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Persisted>
        const feedback: Record<string, EntryFeedback> = {}
        for (const [id, f] of Object.entries(p.feedback ?? {})) feedback[id] = normalizeFeedback(f)
        const styles = Array.isArray(p.blindStyles) && p.blindStyles.length === 2 && p.blindStyles.every(isStyleId) ? p.blindStyles : current.blindStyles
        return {
          ...current,
          feedback,
          selectedId: PLAYLIST.some((e) => e.id === p.selectedId) ? p.selectedId! : current.selectedId,
          compareRoom: p.compareRoom === 'steppe' ? 'steppe' : 'dry',
          withOriginals: typeof p.withOriginals === 'boolean' ? p.withOriginals : current.withOriginals,
          blindStyles: styles
        }
      }
    }
  )
)

/** Where an entry's score comes from, given the current links and the Song Tester's imports. */
export function entrySource(entry: PlaylistEntry, feedback = usePlaylist.getState().feedback, imported = useSongs.getState().imported): SongSource {
  return resolveSong(entry, feedback[entry.id]?.link, allSongs(imported))
}

/**
 * Saves every rating, note, last comparison and blind-test answer as a Markdown report (with the
 * same data as JSON at the end) or as JSON, for the user to send to the developer. `settings` adds
 * playback details the store does not know (e.g. the instrument's vibrato). Resolves to the saved
 * path, or null.
 */
export async function exportFeedback({ format = 'md', settings = {} }: { format?: 'md' | 'json'; settings?: Record<string, string | number> } = {}): Promise<string | null> {
  const { feedback, compareRoom } = usePlaylist.getState()
  const { imported } = useSongs.getState()
  const { soundboard, roomId } = useSettings.getState()
  const library = allSongs(imported)
  const generatedAt = new Date().toISOString()
  const ctx = {
    generatedAt,
    settings: { soundboard, 'listening room': roomId, 'compare room': compareRoom, ...settings },
    songTitle: (id: string) => library.find((s) => s.id === id)?.title ?? null
  }
  const sourceOf = (e: PlaylistEntry) => resolveSong(e, feedback[e.id]?.link, library)
  const date = generatedAt.slice(0, 10)
  return format === 'json'
    ? saveFile({
        title: 'Export playlist feedback',
        defaultName: `morin-khuur-feedback-${date}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
        data: JSON.stringify(feedbackData(PLAYLIST, feedback, sourceOf, ctx), null, 2)
      })
    : saveFile({
        title: 'Export playlist feedback',
        defaultName: `morin-khuur-feedback-${date}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        data: feedbackMarkdown(PLAYLIST, feedback, sourceOf, ctx)
      })
}

/** What the dev hook `window.__mkhuur.compareReference` accepts (see main.tsx). */
export interface DevCompareRequest {
  /** Audio file to fetch, e.g. a Vite `/@fs/C:/…/references/x.mp3` URL. */
  url: string
  /** A song in the library (bundled id or an import's id)… */
  songId?: string
  /** …or a playlist entry, whose linked score and saved settings are used. */
  entryId?: string
  /** Seconds into the file where the compared section starts (default: the entry's melody start, else 0). */
  start?: number
  /** Seconds to compare (default: the entry's choice, else a little longer than ours). */
  length?: number
  referenceKind?: ReferenceKind
  room?: CompareRoom
  style?: StyleId
}

/**
 * A dev comparison request filled in from the store: the song to render (from `songId`, or the
 * entry's score) and the entry's saved start, length, reference kind and style as defaults.
 */
export function devCompareTarget(req: DevCompareRequest): CompareUrlOptions {
  const { feedback, compareRoom } = usePlaylist.getState()
  const library = allSongs(useSongs.getState().imported)
  const entry = req.entryId === undefined ? undefined : PLAYLIST.find((e) => e.id === req.entryId)
  if (req.entryId !== undefined && !entry) throw new Error(`No playlist entry “${req.entryId}”.`)
  const f = entry ? { ...EMPTY_FEEDBACK, ...feedback[entry.id] } : EMPTY_FEEDBACK
  const source: SongSource = req.songId !== undefined ? { kind: 'linked', songId: req.songId } : entry ? resolveSong(entry, f.link, library) : { kind: 'missing' }
  let piece: DevPiece | null = null
  if (source.kind !== 'missing') {
    const found = library.find((s) => s.id === source.songId)
    if (!found) throw new Error(`No song “${source.songId}” in the library.`)
    const { song, report } = loadSong(found.raw)
    if (!song || !report) throw new Error(`The song “${source.songId}” does not parse.`)
    piece = { id: found.id, title: found.title, song, report }
  }
  return {
    url: req.url,
    piece,
    start: req.start ?? f.originalStart,
    length: req.length ?? f.excerptLength,
    referenceKind: req.referenceKind ?? f.referenceKind ?? entry?.referenceKind ?? 'fiddle',
    room: req.room ?? compareRoom,
    style: req.style ?? f.style ?? entry?.style ?? null,
    soundboard: useSettings.getState().soundboard
  }
}
