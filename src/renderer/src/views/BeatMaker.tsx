import { ChevronDown, ChevronLeft, ChevronUp, FileAudio, FileMusic, Link2, Play, Repeat, Square, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { BeatSequencer, patternMidi, renderPatternWav, type SequencerSnapshot } from '@renderer/audio/beat-sequencer'
import { engine } from '@renderer/audio/engine'
import { whenOfflineIdle } from '@renderer/audio/offline'
import { Select } from '@renderer/components/controls'
import { InstrumentView } from '@renderer/components/InstrumentView'
import { Knob } from '@renderer/components/Knob'
import { Oscilloscope, VuMeter } from '@renderer/components/Meters'
import { DEFAULT_TUNING } from '@renderer/core/instrument'
import { PADS, padInfo, type PadId } from '@renderer/core/kit'
import {
  BANK_IDS,
  chainOrder,
  exportParts,
  exportRepeats,
  GROOVES,
  getGroove,
  isEmptyPattern,
  MAX_BARS,
  patternBars,
  PITCH_RANGE,
  PRESET_PATTERNS,
  STEPS_PER_BAR,
  type BankId,
  type Cursor,
  type Groove
} from '@renderer/core/sequencer'
import { useKeyboard } from '@renderer/hooks'
import { saveFile } from '@renderer/platform'
import { useBeat } from '@renderer/state/beat'
import { useSettings } from '@renderer/state/settings'

const sequencer = new BeatSequencer()
/** Bumped by every stop and every new playback: one still waiting for other views' renders is dropped when it changes. */
let run = 0
const nextRun = () => ++run
const TONE_COLOR = { amber: 'var(--color-bilag)', teal: 'var(--color-teal)' }
const LABEL_WIDTH = 110
/** Frame shared by the velocity / pitch lane and its label so both columns stay the same height. */
const LANE_FRAME = 'mt-2 border-t border-line pt-2'
/** Cell margin, with a wider gap in front of bar 2. */
const cellMargin = (step: number, barSize: number) => (step > 0 && step % barSize === 0 ? 'ml-[5px] mr-[1.5px]' : 'mx-[1.5px]')
const cellShade = (step: number, groupSize: number) => (Math.floor(step / groupSize) % 2 === 0 ? '#1d1915' : '#231e19')

type LaneMode = 'velocity' | 'pitch'

export function BeatMaker() {
  const beat = useBeat()
  const { roomId, masterDb, setMasterDb } = useSettings()
  const current = beat.banks[beat.bank]
  const pattern = current.pattern
  const groove = getGroove(current.grooveId)
  const [playing, setPlaying] = useState(false)
  const [recording, setRecording] = useState(false)
  /** Bank and step under the playhead. */
  const [pos, setPos] = useState<Cursor | null>(null)
  /** Bank picked while playing, waiting for the next bar line. */
  const [cued, setCued] = useState<BankId | null>(null)
  const [laneMode, setLaneMode] = useState<LaneMode>('velocity')
  const [busy, setBusy] = useState<string | null>(null)
  const padEls = useRef<Partial<Record<PadId, HTMLButtonElement | null>>>({})
  const gridScroll = useRef<HTMLDivElement>(null)
  const step = pos && pos.bank === beat.bank ? pos.step : null

  // Push per-pad knob settings into the kit.
  useEffect(() => {
    const kit = engine.beatKit()
    for (const p of PADS) kit.setParams(p.id, beat.padParams[p.id])
  }, [beat.padParams])

  useEffect(
    () => () => {
      nextRun()
      sequencer.stop()
    },
    []
  )

  // When the grid is wider than the panel, scroll the playhead back into view as it moves on.
  useEffect(() => {
    const el = gridScroll.current
    if (step === null || !el || el.scrollWidth <= el.clientWidth) return
    const cell = el.querySelector<HTMLElement>(`[data-step="${step}"]`)
    if (!cell) return
    const visible = cell.offsetLeft >= el.scrollLeft && cell.offsetLeft + cell.offsetWidth <= el.scrollLeft + el.clientWidth
    if (!visible) el.scrollLeft = cell.offsetLeft
  }, [step])

  const flash = (pad: PadId) => {
    const el = padEls.current[pad]
    if (!el) return
    el.dataset.hit = 'true'
    window.setTimeout(() => delete el.dataset.hit, 110)
  }

  const snapshot = (): SequencerSnapshot => {
    const { banks, bank, chain, bpm, loop } = useBeat.getState()
    return { banks, bank, chain, bpm, loop }
  }

  const play = async () => {
    const token = nextRun()
    setPlaying(true)
    await engine.resume()
    // While another view's offline render builds, Tone's global transport is the render's:
    // nothing is scheduled until it has finished.
    await whenOfflineIdle()
    if (token !== run) return
    // The grid follows the playhead; when a pass without loop runs out it returns here, so Play replays the whole chain.
    const from = useBeat.getState().bank
    sequencer.start(
      snapshot,
      (bank, st) => {
        setPos({ bank, step: st })
        setCued((c) => (c === bank ? null : c))
        const s = useBeat.getState()
        // The grid follows the playing bank (chain steps and cued switches).
        if (s.bank !== bank) s.selectBank(bank)
        const { cells } = s.banks[bank].pattern
        for (const p of PADS) if (cells[p.id][st]! > 0) flash(p.id)
      },
      () => {
        stop()
        useBeat.getState().selectBank(from)
      }
    )
  }

  function stop() {
    nextRun()
    sequencer.stop()
    setPlaying(false)
    setPos(null)
    setCued(null)
  }

  /** Stopped: show the bank. Playing: switch to it at the next bar line. */
  const chooseBank = (id: BankId) => {
    if (sequencer.playing && pos) {
      sequencer.cue(id)
      setCued(sequencer.cuedBank)
    } else beat.selectBank(id)
  }

  const hit = (pad: PadId) => {
    void engine.resume()
    engine.beatKit().trigger(pad)
    flash(pad)
    beat.selectPad(pad)
    const at = recording && sequencer.playing ? sequencer.position() : null
    if (at) beat.record(pad, at.step, 0.9, at.bank)
  }

  useKeyboard({
    down: (e) => {
      if (e.code === 'Space') {
        if (playing) stop()
        else void play()
        return true
      }
      const pad = PADS.find((p) => p.key === e.key.toLowerCase())
      if (pad) {
        hit(pad.id)
        return true
      }
      return false
    }
  })

  const order = chainOrder(beat.banks)
  const exported = exportParts(beat.banks, beat.bank, beat.chain)
  const exportBars = exported.reduce((n, p) => n + patternBars(p.pattern), 0) * exportRepeats(exported)
  const exportWhat = beat.chain && order.length ? `chain ${order.join('→')}` : `bank ${beat.bank}`
  const exportName = `morin-khuur-beat-${beat.chain && order.length ? 'chain' : `bank-${beat.bank.toLowerCase()}`}-${beat.bpm}bpm`

  const exportWav = async () => {
    setBusy('Rendering…')
    try {
      const wav = await renderPatternWav(snapshot(), beat.padParams, roomId)
      await saveFile({ title: 'Export loop', defaultName: `${exportName}.wav`, filters: [{ name: 'WAV audio', extensions: ['wav'] }], data: wav })
    } finally {
      setBusy(null)
    }
  }

  const exportMidi = async () => {
    await saveFile({ title: 'Export MIDI', defaultName: `${exportName}.mid`, filters: [{ name: 'MIDI file', extensions: ['mid'] }], data: patternMidi(snapshot()) })
  }

  const selected = padInfo(beat.selectedPad)
  const params = beat.padParams[beat.selectedPad]
  const groupSize = pattern.meter === '6/8' ? 6 : 4
  const barSize = STEPS_PER_BAR[pattern.meter]
  const bars = patternBars(pattern)

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Transport bar */}
      <div className="panel flex items-center gap-3 px-4 py-2.5">
        <div className="lcd flex h-12 items-center">
          <button type="button" className="px-2 text-muted hover:text-text" onClick={() => beat.setBpm(beat.bpm - 1)} aria-label="Slower">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="w-24 text-center text-xl font-semibold tabular-nums">{beat.bpm} BPM</span>
          <div className="flex flex-col px-1">
            <button type="button" className="text-muted hover:text-text" onClick={() => beat.setBpm(beat.bpm + 1)} aria-label="Faster">
              <ChevronUp className="h-4 w-4" />
            </button>
            <button type="button" className="text-muted hover:text-text" onClick={() => beat.setBpm(beat.bpm - 1)} aria-label="Slower">
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        </div>
        <GrooveCard groove={groove} onChange={beat.setGroove} />
        <button
          type="button"
          className="btn h-12 w-36 text-base"
          data-on={recording}
          style={{ '--btn-accent': 'var(--color-rec)' } as React.CSSProperties}
          onClick={() => setRecording(!recording)}
          title="Arm live recording: pads you hit while playing are written into the pattern"
        >
          <span className={`h-3.5 w-3.5 rounded-full bg-rec ${recording ? 'animate-pulse' : ''}`} />
          RECORD
        </button>
        <button
          type="button"
          className="btn h-12 w-36 text-base"
          data-on={playing}
          style={{ '--btn-accent': 'var(--color-go)' } as React.CSSProperties}
          onClick={() => (playing ? stop() : void play())}
        >
          {playing ? <Square className="h-5 w-5 fill-go text-go" /> : <Play className="h-5 w-5 fill-go text-go" />}
          {playing ? 'STOP' : 'PLAY'}
        </button>
        <button
          type="button"
          className="btn h-12 w-36 text-base"
          data-on={beat.loop}
          style={{ '--btn-accent': 'var(--color-teal)' } as React.CSSProperties}
          onClick={() => beat.setLoop(!beat.loop)}
        >
          <Repeat className="h-5 w-5 text-teal" />
          LOOP
        </button>
        <div className="ml-auto flex items-center gap-2">
          <Select
            label={`Preset pattern for bank ${beat.bank}`}
            value={current.presetId ?? ''}
            options={[{ value: '', label: 'Custom pattern' }, ...PRESET_PATTERNS.map((p) => ({ value: p.id, label: p.name }))]}
            onChange={(id) => id && beat.loadPreset(id)}
            className="w-44"
          />
          <button type="button" className="btn btn-sm" onClick={() => void exportWav()} disabled={busy !== null} title={`Render ${exportWhat} to WAV (${exportBars} bars)`}>
            <FileAudio className="h-4 w-4" /> {busy ?? 'WAV'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void exportMidi()} title={`Export ${exportWhat} as MIDI (${exportBars} bars)`}>
            <FileMusic className="h-4 w-4" /> MIDI
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[400px_1fr_260px] gap-3">
        {/* Pads */}
        <div className="panel flex flex-col p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Mongolian Morin Khuur 2-string</h2>
          </div>
          <div className="grid flex-1 grid-cols-4 gap-2.5">
            {PADS.map((p, i) => (
              <div key={p.id} className="flex flex-col gap-0.5">
                <span className="text-[10px] text-faint">Row {Math.floor(i / 4) + 1}</span>
                <button
                  ref={(el) => void (padEls.current[p.id] = el)}
                  type="button"
                  onPointerDown={() => hit(p.id)}
                  className="group relative flex flex-1 flex-col items-center justify-center rounded-lg border-2 px-1 text-center transition-[box-shadow,background] duration-75 data-[hit=true]:brightness-150"
                  style={{
                    borderColor: TONE_COLOR[p.tone],
                    background: `linear-gradient(180deg, color-mix(in srgb, ${TONE_COLOR[p.tone]} 22%, #1a1612), #14110e)`,
                    boxShadow: beat.selectedPad === p.id ? `0 0 16px color-mix(in srgb, ${TONE_COLOR[p.tone]} 55%, transparent)` : undefined
                  }}
                  aria-label={`${p.label} ${p.sub} (key ${p.key.toUpperCase()})`}
                >
                  <span className="text-[13px] font-semibold leading-tight">{p.label}</span>
                  <span className="text-[10px] leading-tight text-muted">({p.sub})</span>
                  <span className="kbd absolute bottom-1 right-1 !h-4 !min-w-4 !text-[9px] opacity-60">{p.key}</span>
                </button>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-end justify-between border-t border-line pt-3">
            <div className="text-xs text-muted">
              <div className="font-semibold text-text">{selected.label}</div>
              <div>{selected.sub}</div>
            </div>
            <Knob label="Level" value={params.level} min={-24} max={6} step={0.5} defaultValue={0} onChange={(v) => beat.setPadParam(beat.selectedPad, 'level', v)} format={(v) => `${v.toFixed(1)} dB`} size={46} />
            <Knob label="Tune" value={params.tune} min={-12} max={12} step={1} defaultValue={0} onChange={(v) => beat.setPadParam(beat.selectedPad, 'tune', v)} format={(v) => `${v > 0 ? '+' : ''}${v} st`} size={46} />
            <Knob label="Freq" value={params.freq} min={80} max={16000} log defaultValue={16000} onChange={(v) => beat.setPadParam(beat.selectedPad, 'freq', v)} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v.toFixed(0)}`)} size={46} />
            <Knob label="Reso" value={params.reso} min={0.3} max={12} defaultValue={0.7} onChange={(v) => beat.setPadParam(beat.selectedPad, 'reso', v)} format={(v) => v.toFixed(1)} size={46} />
          </div>
        </div>

        {/* Step sequencer */}
        <div className="panel flex min-w-0 flex-col p-3">
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="lcd flex items-center gap-0.5 p-1" role="group" aria-label="Pattern banks">
              {BANK_IDS.map((id) => (
                <BankTab
                  key={id}
                  id={id}
                  selected={id === beat.bank}
                  playing={pos?.bank === id}
                  cued={cued === id}
                  empty={isEmptyPattern(beat.banks[id].pattern)}
                  chained={beat.chain && order.includes(id)}
                  onClick={() => chooseBank(id)}
                />
              ))}
            </div>
            <button
              type="button"
              className="btn btn-sm"
              data-on={beat.chain}
              aria-pressed={beat.chain}
              style={{ '--btn-accent': 'var(--color-teal)' } as React.CSSProperties}
              onClick={() => beat.setChain(!beat.chain)}
              title="Chain: play the banks that hold a pattern in turn, A→B→C→D"
            >
              <Link2 className="h-4 w-4 text-teal" /> Chain
            </button>
            <div className="lcd flex items-center gap-0.5 p-1" role="group" aria-label="Pattern length in steps">
              {Array.from({ length: MAX_BARS }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={n === bars}
                  onClick={() => beat.setBars(n)}
                  title={n === 1 ? '1 bar' : `${n} bars (new bars start as a copy of the first)`}
                  className={`h-7 rounded-md px-2 text-xs font-semibold tabular-nums transition-colors ${n === bars ? 'bg-panel-3 text-text' : 'text-muted hover:text-text'}`}
                >
                  {barSize * n}
                </button>
              ))}
            </div>
            <span className="text-sm font-semibold">{pattern.meter}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted" title={groove.description}>
              {groove.description}
            </span>
            <button type="button" className="btn btn-sm" onClick={beat.clear} title={`Clear bank ${beat.bank}`}>
              <Trash2 className="h-4 w-4" /> Clear
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div className="flex">
              {/* Row labels stay put while the steps scroll sideways. */}
              <div className="flex shrink-0 flex-col gap-[3px] pr-2" style={{ width: LABEL_WIDTH }}>
                <div className="h-[18px]" />
                {PADS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => beat.selectPad(p.id)}
                    className={`h-[22px] truncate text-left text-[11px] ${beat.selectedPad === p.id ? 'font-semibold text-text' : 'text-muted hover:text-text'}`}
                  >
                    {p.label}
                  </button>
                ))}
                <div className={LANE_FRAME}>
                  <div className="flex h-[64px] flex-col justify-center gap-1.5">
                    <span className="truncate text-[11px] font-semibold" style={{ color: TONE_COLOR[selected.tone] }}>
                      {selected.label}
                    </span>
                    <div className="flex overflow-hidden rounded-md border border-line-2 text-[10px] font-semibold" role="group" aria-label="Step lane">
                      {(['velocity', 'pitch'] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={laneMode === m}
                          onClick={() => setLaneMode(m)}
                          className={`flex-1 py-1 transition-colors ${laneMode === m ? 'bg-panel-3 text-text' : 'text-muted hover:text-text'}`}
                        >
                          {m === 'velocity' ? 'Velocity' : 'Pitch'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div ref={gridScroll} className="relative min-w-0 flex-1 overflow-x-auto">
                <div className="grid gap-y-[3px]" style={{ gridTemplateColumns: `repeat(${pattern.steps}, minmax(16px, 1fr))` }}>
                  {Array.from({ length: pattern.steps }, (_, i) => (
                    <div
                      key={i}
                      data-step={i}
                      className={`${cellMargin(i, barSize)} h-[18px] text-center text-[10px] leading-[18px] tabular-nums ${
                        step === i ? 'text-text' : bars > 1 && i % barSize === 0 ? 'text-bilag' : i % groupSize === 0 ? 'text-muted' : 'text-faint'
                      }`}
                    >
                      {i + 1}
                    </div>
                  ))}
                  {PADS.map((p) => (
                    <PatternCells
                      key={p.id}
                      label={p.label}
                      color={TONE_COLOR[p.tone]}
                      cells={pattern.cells[p.id]}
                      pitch={pattern.pitch[p.id]}
                      playhead={step}
                      groupSize={groupSize}
                      barSize={barSize}
                      onToggle={(i, accent) => (accent ? beat.record(p.id, i, pattern.cells[p.id][i]! > 0.8 ? 0.6 : 0.95) : beat.toggle(p.id, i))}
                    />
                  ))}
                  <StepLane
                    mode={laneMode}
                    label={selected.label}
                    color={TONE_COLOR[selected.tone]}
                    cells={pattern.cells[beat.selectedPad]}
                    pitch={pattern.pitch[beat.selectedPad]}
                    playhead={step}
                    groupSize={groupSize}
                    barSize={barSize}
                    onVelocity={(i, v) => beat.record(beat.selectedPad, i, v)}
                    onPitch={(i, semitones) => beat.setPitch(beat.selectedPad, i, semitones)}
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="mt-2 truncate px-1 text-[11px] text-faint">
            Click a step to toggle · Shift+click for accent · Drag lane bars for velocity / pitch (double-click resets) · Banks switch at the next bar · Space plays
          </div>
        </div>

        {/* Master */}
        <div className="panel flex flex-col p-4">
          <h2 className="text-lg font-semibold">Morin Khuur</h2>
          <div className="relative -mx-4 my-2 min-h-0 flex-1 overflow-hidden" aria-hidden>
            <div className="absolute left-1/2 top-1/2 w-[380px] -translate-x-1/2 -translate-y-1/2 -rotate-[62deg]">
              <InstrumentView tuning={DEFAULT_TUNING} />
            </div>
          </div>
          <Oscilloscope color="var(--color-bilag)" height={70} />
          <div className="flex items-end justify-center gap-5 pt-4">
            <label className="flex flex-col items-center gap-1">
              <input
                type="range"
                min={-40}
                max={6}
                value={masterDb}
                onChange={(e) => setMasterDb(Number(e.target.value))}
                aria-label="Master volume"
                className="h-28 w-5 accent-[var(--color-text)] [writing-mode:vertical-lr] [direction:rtl]"
              />
              <span className="text-[10px] tabular-nums text-muted">{masterDb} dB</span>
            </label>
            <div className="flex flex-col items-center gap-1">
              <VuMeter height={112} />
              <span className="text-[10px] text-muted">VU</span>
            </div>
          </div>
          <div className="mt-1 text-center text-xs text-muted">Master</div>
        </div>
      </div>
    </div>
  )
}

const semitoneLabel = (p: number) => `${p > 0 ? '+' : ''}${p} st`

function BankTab({
  id,
  selected,
  playing,
  cued,
  empty,
  chained,
  onClick
}: {
  id: BankId
  selected: boolean
  playing: boolean
  cued: boolean
  empty: boolean
  chained: boolean
  onClick(): void
}) {
  const state = [empty ? 'empty' : chained ? 'in the chain' : '', playing ? 'playing' : '', cued ? 'starts at the next bar' : ''].filter(Boolean).join(', ')
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`Bank ${id}${state ? ` (${state})` : ''}`}
      title={`Bank ${id}${state ? ` · ${state}` : ''} — while playing, switches at the next bar line`}
      className={`relative h-7 w-8 rounded-md border text-sm font-semibold transition-colors ${
        selected ? 'border-bilag bg-panel-3 text-text' : cued ? 'animate-pulse border-teal text-text' : `border-transparent hover:text-text ${empty ? 'text-faint' : 'text-muted'}`
      }`}
    >
      {id}
      {playing && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-go" />}
      {!empty && <span className={`absolute bottom-0.5 left-1/2 h-[2px] w-3 -translate-x-1/2 rounded-full ${chained ? 'bg-teal' : 'bg-muted/50'}`} />}
    </button>
  )
}

function PatternCells({
  label,
  color,
  cells,
  pitch,
  playhead,
  groupSize,
  barSize,
  onToggle
}: {
  label: string
  color: string
  cells: number[]
  pitch: number[]
  playhead: number | null
  groupSize: number
  barSize: number
  onToggle(step: number, accent: boolean): void
}) {
  return (
    <>
      {cells.map((v, i) => {
        const p = v > 0 ? (pitch[i] ?? 0) : 0
        return (
          <button
            key={i}
            type="button"
            onClick={(e) => onToggle(i, e.shiftKey)}
            aria-label={`${label} step ${i + 1}${v > 0 ? ` on, velocity ${Math.round(v * 100)}%` : ''}${p ? `, ${semitoneLabel(p)}` : ''}`}
            aria-pressed={v > 0}
            className={`${cellMargin(i, barSize)} relative h-[22px] rounded-[4px] border transition-colors`}
            style={{
              background: v > 0 ? color : cellShade(i, groupSize),
              opacity: v > 0 ? 0.45 + v * 0.55 : 1,
              borderColor: playhead === i ? '#f3ede4' : v > 0 ? color : '#2c2621',
              boxShadow: v > 0 && playhead === i ? `0 0 12px ${color}` : undefined
            }}
          >
            {/* Pitch offset marker: top edge = up, bottom edge = down. */}
            {p !== 0 && <span className={`absolute inset-x-[3px] h-[2px] rounded-full bg-ink/70 ${p > 0 ? 'top-[2px]' : 'bottom-[2px]'}`} />}
          </button>
        )
      })}
    </>
  )
}

/**
 * Velocity / pitch lane for the selected pad, one bar per step. Velocity: drag bars to the
 * height you want (drag sideways to paint). Pitch: drag a step up or down (6 px per semitone).
 * Double-click resets. Steps that are off can't be edited here.
 */
function StepLane({
  mode,
  label,
  color,
  cells,
  pitch,
  playhead,
  groupSize,
  barSize,
  onVelocity,
  onPitch
}: {
  mode: LaneMode
  label: string
  color: string
  cells: number[]
  pitch: number[]
  playhead: number | null
  groupSize: number
  barSize: number
  onVelocity(step: number, velocity: number): void
  onPitch(step: number, semitones: number): void
}) {
  const drag = useRef<{ step: number; y: number; pitch: number } | null>(null)

  const stepAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.floor(((e.clientX - r.left) / r.width) * cells.length)
    return i >= 0 && i < cells.length && cells[i]! > 0 ? i : null
  }
  const velocityAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.min(1, Math.max(0.05, Math.round((1 - (e.clientY - r.top) / r.height) * 100) / 100))
  }

  return (
    <div className={`col-span-full ${LANE_FRAME}`}>
      <div
        role="group"
        aria-label={`${label} ${mode} per step`}
        className="grid h-[64px] cursor-ns-resize touch-none"
        style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
        onPointerDown={(e) => {
          drag.current = null
          const i = e.button === 0 ? stepAt(e) : null
          if (i === null) return
          e.currentTarget.setPointerCapture(e.pointerId)
          if (mode === 'velocity') onVelocity(i, velocityAt(e))
          else drag.current = { step: i, y: e.clientY, pitch: pitch[i] ?? 0 }
        }}
        onPointerMove={(e) => {
          if (!(e.buttons & 1)) return
          if (mode === 'pitch') {
            if (drag.current) onPitch(drag.current.step, drag.current.pitch + Math.round((drag.current.y - e.clientY) / 6))
            return
          }
          const i = stepAt(e)
          if (i !== null) onVelocity(i, velocityAt(e))
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={(e) => {
          const i = stepAt(e)
          if (i === null) return
          if (mode === 'velocity') onVelocity(i, 0.9)
          else onPitch(i, 0)
        }}
      >
        {cells.map((v, i) => {
          const on = v > 0
          const p = on ? (pitch[i] ?? 0) : 0
          const size = (Math.abs(p) / PITCH_RANGE) * 50
          return (
            <div
              key={i}
              title={on ? `Step ${i + 1}: velocity ${Math.round(v * 100)}%, pitch ${semitoneLabel(p)}` : `Step ${i + 1} is off`}
              className={`${cellMargin(i, barSize)} relative overflow-hidden rounded-[3px] border`}
              style={{ background: cellShade(i, groupSize), borderColor: playhead === i ? '#f3ede4' : '#2c2621' }}
            >
              {mode === 'velocity' ? (
                on && <div className="absolute inset-x-0 bottom-0 rounded-t-[2px]" style={{ height: `${v * 100}%`, background: color, opacity: 0.85 }} />
              ) : (
                <>
                  <div className="absolute inset-x-0 top-1/2 h-px bg-line-2" />
                  {on && p === 0 && <div className="absolute inset-x-[2px] top-1/2 h-[3px] -translate-y-1/2 rounded-full" style={{ background: color }} />}
                  {on && p !== 0 && (
                    <div className="absolute inset-x-0" style={{ background: color, opacity: 0.85, top: p > 0 ? `${50 - size}%` : '50%', height: `${size}%` }} />
                  )}
                  {on && p !== 0 && (
                    <span className={`absolute inset-x-0 text-center text-[9px] leading-none tabular-nums text-text ${p > 0 ? 'top-[calc(50%+3px)]' : 'bottom-[calc(50%+3px)]'}`}>
                      {p > 0 ? `+${p}` : p}
                    </span>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function GrooveCard({ groove, onChange }: { groove: Groove; onChange(id: string): void }) {
  // Mini bar graph of the groove's accents, like the mockup's "Galloping Swing" display.
  return (
    <label className="lcd relative flex h-12 w-56 cursor-pointer flex-col items-center justify-end overflow-hidden px-2 pb-1">
      <div className="absolute inset-x-2 top-1.5 flex h-5 items-end gap-[2px]">
        {groove.accents.map((a, i) => (
          <div key={i} className="flex-1 rounded-t-[1px]" style={{ height: `${a * 100}%`, background: i % 2 ? 'var(--color-teal)' : 'var(--color-bilag)', opacity: 0.8 }} />
        ))}
      </div>
      <select
        aria-label="Groove"
        value={groove.id}
        onChange={(e) => onChange(e.target.value)}
        className="relative w-full cursor-pointer appearance-none bg-transparent text-center text-sm text-text outline-none"
      >
        {GROOVES.map((g) => (
          <option key={g.id} value={g.id} className="bg-panel">
            {g.name} · {g.meter}
          </option>
        ))}
      </select>
    </label>
  )
}
