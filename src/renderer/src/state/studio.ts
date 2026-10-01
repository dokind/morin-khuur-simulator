import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { StudioMeter } from '@renderer/core/arrangement'
import { TRACKS, type TrackId, type TrackMix } from '@renderer/audio/studio'
import { BUILT_IN_SONGS } from '@renderer/songs'
import { isStyleChoice, ORNAMENT_AMOUNT, type StyleChoice } from './songs'

const defaultMix = (): Record<TrackId, TrackMix> => ({
  lead: { volume: 0, mute: false, solo: false },
  rhythm: { volume: -6, mute: false, solo: false },
  tovshuur: { volume: -4, mute: false, solo: false },
  khoomii: { volume: -8, mute: false, solo: false }
})

interface StudioState {
  songId: string
  bpm: number
  meter: StudioMeter
  /** Extra bars of accompaniment beyond the lead song (min length). */
  bars: number
  loop: boolean
  mix: Record<TrackId, TrackMix>
  steppeReverb: number
  gerAmbience: number
  vibrato: number
  /** How the lead song is played: a style, or 'auto' for the song's own. */
  leadStyle: StyleChoice
  /** Ornament density of the lead's style, 0–2 (1 = the style's own). */
  ornamentAmount: number
  set(patch: Partial<Omit<StudioState, 'set' | 'setMix'>>): void
  setMix(track: TrackId, patch: Partial<TrackMix>): void
}

export const useStudio = create<StudioState>()(
  persist(
    (set) => ({
      songId: BUILT_IN_SONGS.find((s) => s.id.includes('long-song'))?.id ?? BUILT_IN_SONGS[0]?.id ?? '',
      bpm: 96,
      meter: '4/4',
      bars: 8,
      loop: true,
      mix: defaultMix(),
      steppeReverb: 0.45,
      gerAmbience: 0.15,
      vibrato: 22,
      leadStyle: 'auto',
      ornamentAmount: 1,
      set: (patch) => set(patch.ornamentAmount === undefined ? patch : { ...patch, ornamentAmount: clampAmount(patch.ornamentAmount) }),
      setMix: (track, patch) => set((s) => ({ mix: { ...s.mix, [track]: { ...s.mix[track], ...patch } } }))
    }),
    {
      name: 'mkhuur.studio',
      version: 1,
      merge: (persisted, current) => {
        // Nothing stored yet (first run): zustand passes undefined.
        const p = (persisted ?? {}) as Partial<StudioState>
        return {
          ...current,
          ...p,
          mix: { ...defaultMix(), ...(p.mix ?? {}) },
          leadStyle: isStyleChoice(p.leadStyle) ? p.leadStyle : current.leadStyle,
          // Saves from before the slider have none.
          ornamentAmount: typeof p.ornamentAmount === 'number' ? clampAmount(p.ornamentAmount) : current.ornamentAmount
        }
      }
    }
  )
)

/** On the slider's range and steps; anything unusable is the style's own density. */
function clampAmount(amount: number): number {
  const { min, max, step } = ORNAMENT_AMOUNT
  return Number.isFinite(amount) ? Math.round(Math.min(max, Math.max(min, amount)) / step) * step : 1
}

export const TRACK_IDS: readonly TrackId[] = TRACKS.map((t) => t.id)
