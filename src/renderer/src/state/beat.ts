import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { PAD_IDS, type PadId } from '@renderer/core/kit'
import {
  BANK_IDS,
  defaultBanks,
  emptyPattern,
  getGroove,
  isEmptyPattern,
  patternBars,
  PRESET_PATTERNS,
  reshapePattern,
  resizePattern,
  restoreBanks,
  setCell,
  setPitch,
  toggleCell,
  type Bank,
  type BankId,
  type Pattern
} from '@renderer/core/sequencer'
import { DEFAULT_PAD_PARAMS, type PadParams } from '@renderer/audio/beat-kit'

const defaultParams = () => Object.fromEntries(PAD_IDS.map((id) => [id, { ...DEFAULT_PAD_PARAMS }])) as Record<PadId, PadParams>
const firstPreset = PRESET_PATTERNS[0]!

/** The pad knobs' ranges (Level dB, Tune st, Freq Hz, Reso Q), as in the Beat Maker view. */
const PARAM_RANGE: Record<keyof PadParams, readonly [number, number]> = { level: [-24, 6], tune: [-12, 12], freq: [80, 16000], reso: [0.3, 12] }

/** Stored knob values that are missing, not numbers or out of range would make Tone throw: use defaults / clamp. */
function restoreParams(raw: unknown): PadParams {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof PadParams, unknown>>
  const out = { ...DEFAULT_PAD_PARAMS }
  for (const key of Object.keys(PARAM_RANGE) as (keyof PadParams)[]) {
    const v = stored[key]
    const [lo, hi] = PARAM_RANGE[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(hi, Math.max(lo, v))
  }
  return out
}

interface BeatState {
  banks: Record<BankId, Bank>
  /** The bank shown and edited. During playback the view keeps it on the playing bank. */
  bank: BankId
  /** Play the non-empty banks A→B→C→D in turn. */
  chain: boolean
  bpm: number
  loop: boolean
  selectedPad: PadId
  padParams: Record<PadId, PadParams>
  toggle(pad: PadId, step: number): void
  /** Sets a step's velocity (0 = off) in `bank`, by default the current one. */
  record(pad: PadId, step: number, velocity: number, bank?: BankId): void
  /** Sets the pitch offset (semitones) of a step that is on. */
  setPitch(pad: PadId, step: number, semitones: number): void
  clear(): void
  /** Pattern length of the current bank: 1 or 2 bars. */
  setBars(bars: number): void
  /** Loads a preset into the current bank. Its tempo applies only while the other banks are empty. */
  loadPreset(id: string): void
  setGroove(id: string): void
  selectBank(bank: BankId): void
  setChain(chain: boolean): void
  setBpm(bpm: number): void
  setLoop(loop: boolean): void
  selectPad(pad: PadId): void
  setPadParam(pad: PadId, key: keyof PadParams, value: number): void
}

type Persisted = Pick<BeatState, 'banks' | 'bank' | 'chain' | 'bpm' | 'loop' | 'selectedPad' | 'padParams'>

/** Replaces the pattern of bank `id` (default: the current bank); edits drop the preset label. */
const editPattern = (s: BeatState, edit: (p: Pattern) => Pattern, id: BankId = s.bank): Partial<BeatState> => ({
  banks: { ...s.banks, [id]: { ...s.banks[id], pattern: edit(s.banks[id].pattern), presetId: null } }
})

export const useBeat = create<BeatState>()(
  persist(
    (set) => ({
      banks: defaultBanks(),
      bank: 'A',
      chain: false,
      bpm: firstPreset.bpm,
      loop: true,
      selectedPad: 'colLegno',
      padParams: defaultParams(),
      toggle: (pad, step) => set((s) => editPattern(s, (p) => toggleCell(p, pad, step))),
      record: (pad, step, velocity, bank) => set((s) => editPattern(s, (p) => setCell(p, pad, step, velocity), bank)),
      setPitch: (pad, step, semitones) => set((s) => editPattern(s, (p) => setPitch(p, pad, step, semitones))),
      clear: () => set((s) => editPattern(s, (p) => emptyPattern(p.meter, patternBars(p)))),
      setBars: (bars) => set((s) => (bars === patternBars(s.banks[s.bank].pattern) ? {} : editPattern(s, (p) => resizePattern(p, bars)))),
      loadPreset: (id) =>
        set((s) => {
          const preset = PRESET_PATTERNS.find((p) => p.id === id)
          if (!preset) return {}
          const othersInUse = BANK_IDS.some((b) => b !== s.bank && !isEmptyPattern(s.banks[b].pattern))
          return {
            banks: { ...s.banks, [s.bank]: { pattern: preset.pattern, grooveId: preset.groove, presetId: id } },
            bpm: othersInUse ? s.bpm : preset.bpm
          }
        }),
      setGroove: (grooveId) =>
        set((s) => {
          const current = s.banks[s.bank]
          const meter = getGroove(grooveId).meter
          // Changing meter keeps, bar by bar, the steps that still fit.
          const pattern = meter === current.pattern.meter ? current.pattern : reshapePattern(current.pattern, meter, patternBars(current.pattern))
          const presetId = pattern === current.pattern && grooveId === current.grooveId ? current.presetId : null
          return { banks: { ...s.banks, [s.bank]: { pattern, grooveId, presetId } } }
        }),
      selectBank: (bank) => set({ bank }),
      setChain: (chain) => set({ chain }),
      setBpm: (bpm) => set({ bpm: Math.round(Math.min(220, Math.max(40, bpm))) }),
      setLoop: (loop) => set({ loop }),
      selectPad: (selectedPad) => set({ selectedPad }),
      setPadParam: (pad, key, value) => set((s) => ({ padParams: { ...s.padParams, [pad]: { ...s.padParams[pad], [key]: value } } }))
    }),
    {
      name: 'mkhuur.beat',
      // v2: pattern banks A–D with 1–2 bar patterns and a per-step pitch lane.
      version: 2,
      partialize: (s): Persisted => ({
        banks: s.banks,
        bank: s.bank,
        chain: s.chain,
        bpm: s.bpm,
        loop: s.loop,
        selectedPad: s.selectedPad,
        padParams: s.padParams
      }),
      // v1 kept one `pattern` (velocity rows only) with its `grooveId`: it becomes bank A.
      migrate: (persisted, version) => {
        if (version >= 2 || typeof persisted !== 'object' || persisted === null) return persisted as Persisted
        const { pattern: _pattern, grooveId: _grooveId, presetId: _presetId, ...rest } = persisted as Record<string, unknown>
        return { ...rest, ...restoreBanks(persisted, { banks: defaultBanks(), bank: 'A' }) } as Persisted
      },
      // Repairs whatever is stored so a corrupt or partial entry can't crash the view.
      merge: (persisted, current) => {
        const p = (typeof persisted === 'object' && persisted !== null ? persisted : {}) as Partial<Persisted>
        return {
          ...current,
          ...restoreBanks(p, current),
          chain: typeof p.chain === 'boolean' ? p.chain : current.chain,
          bpm: typeof p.bpm === 'number' && Number.isFinite(p.bpm) ? Math.round(Math.min(220, Math.max(40, p.bpm))) : current.bpm,
          loop: typeof p.loop === 'boolean' ? p.loop : current.loop,
          selectedPad: PAD_IDS.find((id) => id === p.selectedPad) ?? current.selectedPad,
          padParams: Object.fromEntries(PAD_IDS.map((id) => [id, restoreParams(p.padParams?.[id])])) as Record<PadId, PadParams>
        }
      }
    }
  )
)
