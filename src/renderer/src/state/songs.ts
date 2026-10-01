import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import { STYLES, type StyleId } from '@renderer/core/performance'
import { BUILT_IN_SONGS, type LibraryEntry } from '@renderer/songs'

/** Which notation the Song Tester shows. */
export type NotationMode = 'jianpu' | 'staff' | 'both'

/** A playing style, or 'auto' for each song's own (its `style`, else from its genre). */
export type StyleChoice = StyleId | 'auto'

export const isStyleChoice = (v: unknown): v is StyleChoice => v === 'auto' || STYLES.some((s) => s.id === v)

/** Ornament density range for the Song Tester's slider (1 = the style's own). */
export const ORNAMENT_AMOUNT = { min: 0, max: 2, step: 0.1 }

interface SongsState {
  /** Songs the user imported from `.mkhuur.json` files (kept across restarts). */
  imported: LibraryEntry[]
  /** Imported songs that did not fit in storage: kept for this session only (not persisted). */
  unsaved: string[]
  selectedId: string
  /** Playback tempo override; null plays at the song's own tempo. */
  bpm: number | null
  notation: NotationMode
  /** Playing style for listening (the auto-test always plays as written). */
  style: StyleChoice
  /** Ornament density multiplier, 0–2. */
  ornamentAmount: number
  select(id: string): void
  /** Adds and selects the song; false when it could not be saved for later (it stays for this session). */
  importSong(entry: Omit<LibraryEntry, 'builtIn'>): boolean
  removeImported(id: string): void
  setBpm(bpm: number | null): void
  setNotation(notation: NotationMode): void
  setStyle(style: StyleChoice): void
  setOrnamentAmount(amount: number): void
}

type Persisted = Pick<SongsState, 'imported' | 'selectedId' | 'bpm' | 'notation' | 'style' | 'ornamentAmount'>

/** Whether the last write to localStorage failed (quota exceeded, storage disabled). */
let saveFailed = false

/**
 * localStorage that never throws. zustand writes right after the state has changed, so a quota
 * error (a few large imports fill the ~5 MB) would otherwise escape from the action that already
 * took effect, and from every later one.
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
    try {
      localStorage.setItem(name, JSON.stringify(value))
      saveFailed = false
    } catch {
      saveFailed = true
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name)
    } catch {
      // Nothing stored to remove.
    }
  }
}

export const useSongs = create<SongsState>()(
  persist(
    (set) => ({
      imported: [],
      unsaved: [],
      selectedId: BUILT_IN_SONGS[0]?.id ?? '',
      bpm: null,
      notation: 'both',
      style: 'auto',
      ornamentAmount: 1,
      select: (selectedId) => set({ selectedId, bpm: null }),
      importSong: (entry) => {
        set((s) => ({
          imported: [...s.imported.filter((e) => e.id !== entry.id), { ...entry, builtIn: false }],
          unsaved: s.unsaved.filter((id) => id !== entry.id),
          selectedId: entry.id,
          bpm: null
        }))
        if (!saveFailed) return true
        // Too large to store: keep it in memory only, so the rest of the library still saves.
        set((s) => ({ unsaved: [...s.unsaved, entry.id] }))
        return false
      },
      removeImported: (id) =>
        set((s) => ({
          imported: s.imported.filter((e) => e.id !== id),
          unsaved: s.unsaved.filter((u) => u !== id),
          selectedId: s.selectedId === id ? (BUILT_IN_SONGS[0]?.id ?? '') : s.selectedId
        })),
      setBpm: (bpm) => set({ bpm: bpm === null ? null : Math.round(Math.min(240, Math.max(30, bpm))) }),
      setNotation: (notation) => set({ notation }),
      setStyle: (style) => set({ style: isStyleChoice(style) ? style : 'auto' }),
      setOrnamentAmount: (amount) => set({ ornamentAmount: clampAmount(amount) })
    }),
    {
      name: 'mkhuur.songs',
      version: 1,
      storage,
      partialize: (s): Persisted => ({
        imported: s.unsaved.length ? s.imported.filter((e) => !s.unsaved.includes(e.id)) : s.imported,
        selectedId: s.unsaved.includes(s.selectedId) ? (BUILT_IN_SONGS[0]?.id ?? '') : s.selectedId,
        bpm: s.bpm,
        notation: s.notation,
        style: s.style,
        ornamentAmount: s.ornamentAmount
      }),
      // Older saves have no style fields; unknown values (a style that no longer exists) fall back.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Persisted>
        return {
          ...current,
          ...p,
          style: isStyleChoice(p.style) ? p.style : current.style,
          ornamentAmount: typeof p.ornamentAmount === 'number' ? clampAmount(p.ornamentAmount) : current.ornamentAmount
        }
      }
    }
  )
)

function clampAmount(amount: number): number {
  const { min, max, step } = ORNAMENT_AMOUNT
  return Number.isFinite(amount) ? Math.round(Math.min(max, Math.max(min, amount)) / step) * step : 1
}

export function allSongs(imported: LibraryEntry[]): LibraryEntry[] {
  return [...BUILT_IN_SONGS, ...imported]
}
