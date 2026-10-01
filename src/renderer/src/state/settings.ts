import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ScaleId } from '@renderer/core/instrument'
import type { Soundboard } from '@renderer/audio/body'
import type { RoomId } from '@renderer/audio/room'

export type ViewId = 'playground' | 'beatmaker' | 'songs' | 'playlist' | 'studio'

interface SettingsState {
  view: ViewId
  tuningId: string
  soundboard: Soundboard
  roomId: RoomId
  masterDb: number
  scale: ScaleId
  vibratoDepth: number
  setView(view: ViewId): void
  setTuning(id: string): void
  setSoundboard(soundboard: Soundboard): void
  setRoom(id: RoomId): void
  setMasterDb(db: number): void
  setScale(scale: ScaleId): void
  setVibratoDepth(cents: number): void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      view: 'playground',
      tuningId: 'standard',
      soundboard: 'wood',
      roomId: 'steppe',
      masterDb: 0,
      scale: 'diatonic',
      vibratoDepth: 18,
      setView: (view) => set({ view }),
      setTuning: (tuningId) => set({ tuningId }),
      setSoundboard: (soundboard) => set({ soundboard }),
      setRoom: (roomId) => set({ roomId }),
      setMasterDb: (masterDb) => set({ masterDb }),
      setScale: (scale) => set({ scale }),
      setVibratoDepth: (vibratoDepth) => set({ vibratoDepth })
    }),
    { name: 'mkhuur.settings', version: 1 }
  )
)
