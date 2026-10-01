import { AlertTriangle, AudioWaveform, Circle, Download, Guitar, Loader2, Pause, Play, Repeat, Square, Undo2, Volume2, Waves } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import type * as Tone from 'tone'
import type { Soundboard } from '@renderer/audio/body'
import { engine } from '@renderer/audio/engine'
import { getPerformer } from '@renderer/audio/live'
import { whenOfflineIdle } from '@renderer/audio/offline'
import { leadEvents, peaks, projectLength, renderMixWav, renderStems, StudioMixer, TakeRecorder, TRACKS, type StudioProject, type TrackId } from '@renderer/audio/studio'
import { Select } from '@renderer/components/controls'
import { InstrumentView } from '@renderer/components/InstrumentView'
import { Knob } from '@renderer/components/Knob'
import { StereoMeter } from '@renderer/components/Meters'
import { barSeconds, type StudioMeter } from '@renderer/core/arrangement'
import { keyboardLayout, stopFraction, type Tuning } from '@renderer/core/instrument'
import { quartersPerBar, type Song } from '@renderer/core/notation'
import { resolveStyle, STYLES } from '@renderer/core/performance'
import { BOW_INFO, SCREEN_DIRECTION, type BowDirection } from '@renderer/core/techniques'
import { useAnimationFrame, useKeyboard } from '@renderer/hooks'
import { saveFile } from '@renderer/platform'
import { memoLast } from '@renderer/memo'
import { loadSong, type LoadedSong } from '@renderer/songs'
import { useSettings } from '@renderer/state/settings'
import { allSongs, isStyleChoice, ORNAMENT_AMOUNT, useSongs, type StyleChoice } from '@renderer/state/songs'
import { useStudio } from '@renderer/state/studio'

const mixer = new StudioMixer()
/** Bumped by every stop and every new playback: one still waiting for other views' renders is dropped when it changes. */
let run = 0
const nextRun = () => ++run

const projectFor = memoLast(
  (
    loaded: LoadedSong | null,
    meter: StudioMeter,
    bpm: number,
    minBars: number,
    vibratoCents: number,
    soundboard: Soundboard,
    leadStyle: StyleChoice,
    ornamentAmount: number
  ): StudioProject | null => {
    const song = loaded?.song
    if (!song || !loaded.report) return null
    const tuning: Tuning = { id: 'song', name: '', male: song.tuning.male, female: song.tuning.female, scaleTonic: song.tuning.male % 12 }
    const leadBars = Math.ceil(song.lengthBeats / (meter === '6/8' ? 3 : 4) - 1e-6)
    // Tonic: the song's key nearest below the female open string, else the female string itself.
    const tonic = song.keyPc === null ? tuning.female : tuning.female - ((((tuning.female - song.keyPc) % 12) + 12) % 12)
    return {
      song,
      report: loaded.report,
      tuning,
      vibratoCents,
      soundboard,
      leadStyle: leadStyle === 'auto' ? null : leadStyle,
      ornamentAmount,
      spec: { meter, bpm, bars: Math.max(minBars, leadBars), tonic }
    }
  }
)
const styleOptions = memoLast((song: Song | null): { value: StyleChoice; label: string }[] => [
  { value: 'auto', label: `Auto (${song ? (STYLES.find((s) => s.id === resolveStyle(song))?.name ?? '—') : '—'})` },
  ...STYLES.map((s) => ({ value: s.id, label: s.name }))
])
const eventsFor = memoLast((project: StudioProject | null) => (project ? leadEvents(project) : []))
/** Keyboard play-along uses the song's tuning with its key as the scale tonic. */
const playTuning = (p: StudioProject): Tuning => ({ ...p.tuning, scaleTonic: p.spec.tonic % 12 })
const layoutFor = memoLast((project: StudioProject | null) => (project ? keyboardLayout(playTuning(project), 'diatonic', NOTE_KEYS.length) : []))
const takeRecorder = new TakeRecorder()
const ICONS: Record<TrackId, ComponentType<{ className?: string }>> = { lead: Volume2, rhythm: Waves, tovshuur: Guitar, khoomii: AudioWaveform }
const NOTE_KEYS = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote']
const LEAD_IN = 0.05
// Bow track halves follow the on-screen stroke direction (mockup colours: pull blue, push green).
const LEFT_STROKE: BowDirection = SCREEN_DIRECTION.tatakh < 0 ? 'tatakh' : 'tülekhe'
const RIGHT_STROKE: BowDirection = LEFT_STROKE === 'tatakh' ? 'tülekhe' : 'tatakh'
const BOW_TRACK: Record<BowDirection, { bg: string; fg: string }> = { tatakh: { bg: '#1d4f86', fg: 'var(--color-arga)' }, tülekhe: { bg: '#2f7d3f', fg: 'var(--color-go)' } }

const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s))
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, '0')).join(':')
}

export function Studio() {
  const st = useStudio()
  const { roomId, masterDb, setMasterDb, soundboard } = useSettings()
  const { imported } = useSongs()
  const entries = allSongs(imported)
  const entry = entries.find((e) => e.id === st.songId) ?? entries[0]
  const loaded = entry ? loadSong(entry.raw) : null

  const leadStyle = isStyleChoice(st.leadStyle) ? st.leadStyle : 'auto'
  // As written adds no ornaments, so its amount does nothing.
  const leadAsWritten = (leadStyle === 'auto' ? (loaded?.song ? resolveStyle(loaded.song) : null) : leadStyle) === 'as-written'
  const project = projectFor(loaded, st.meter, st.bpm, st.bars, st.vibrato, soundboard, leadStyle, st.ornamentAmount)
  const length = project ? projectLength(project) : 0

  const [stems, setStems] = useState<Record<TrackId, Tone.ToneAudioBuffer> | null>(null)
  const [take, setTake] = useState<Tone.ToneAudioBuffer | null>(null)
  const [rendering, setRendering] = useState<number | null>(0)
  const [playState, setPlayState] = useState<'stopped' | 'started' | 'paused'>('stopped')
  const [recArmed, setRecArmed] = useState(false)
  const [recording, setRecording] = useState(false)
  const [exporting, setExporting] = useState(false)
  const zeroAt = useRef(0)
  const clockRef = useRef<HTMLSpanElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const bowRef = useRef<HTMLDivElement>(null)
  const dotRefs = useRef<Record<'male' | 'female', HTMLDivElement | null>>({ male: null, female: null })

  // Re-render stems (debounced) whenever the arrangement changes.
  useEffect(() => {
    if (!project) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setRendering(0)
      const rendered = await renderStems(project, (n) => !cancelled && setRendering(n))
      if (cancelled) return
      setStems(rendered)
      setRendering(null)
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [project])

  const activeStems = useMemo(() => (stems ? { ...stems, ...(take ? { lead: take } : {}) } : null), [stems, take])

  useEffect(() => {
    if (!activeStems) return
    let cancelled = false
    // The players are created in Tone's global context, which another view's offline render holds
    // while it builds.
    void whenOfflineIdle().then(() => {
      if (cancelled) return
      mixer.stop()
      mixer.load(activeStems, useStudio.getState().mix)
    })
    return () => {
      cancelled = true
    }
  }, [activeStems])

  useEffect(() => {
    for (const t of TRACKS) mixer.setMix(t.id, st.mix[t.id])
  }, [st.mix])

  // The Studio's reverb knobs override the room's sends; restore the room on the way out.
  useEffect(() => engine.setRoomSends({ long: st.steppeReverb * 0.6, short: st.gerAmbience }), [st.steppeReverb, st.gerAmbience])
  useEffect(
    () => () => {
      nextRun()
      mixer.stop()
      mixer.unload()
      engine.setRoom(useSettings.getState().roomId)
    },
    []
  )

  const events = eventsFor(project)

  useAnimationFrame(() => {
    const pos = mixer.position
    if (clockRef.current) clockRef.current.textContent = clock(pos)
    if (playheadRef.current && length > 0) playheadRef.current.style.left = `${(Math.min(pos, length) / length) * 100}%`
    // Bottom visualisers follow the lead part.
    const t = pos - LEAD_IN
    const e = events.findLast((ev) => ev.start <= t && t < ev.start + ev.event.duration)
    const check = e ? project?.report.checks[e.order] : undefined
    if (bowRef.current) {
      const dir = e?.event.bow ? SCREEN_DIRECTION[e.event.bow] : 0
      const progress = e ? (t - e.start) / e.event.duration : 0.5
      const x = dir === 0 ? 0 : dir * (progress - 0.5) * 70
      bowRef.current.style.transform = `translateX(${x}%)`
    }
    for (const s of ['male', 'female'] as const) {
      const dot = dotRefs.current[s]
      if (!dot) continue
      const stop = check?.note.string === s ? check.stop : null
      dot.style.opacity = stop !== null && playState === 'started' ? '1' : '0.25'
      dot.style.top = `${8 + stopFraction(stop ?? 0) * 150}%`
    }
  })

  const play = async () => {
    const token = nextRun()
    await engine.resume()
    // After any other view's render (and the stems' loading, queued before this).
    await whenOfflineIdle()
    if (token !== run) return
    zeroAt.current = mixer.play(length + 0.5, st.loop && !recording)
    setPlayState('started')
  }
  const pause = () => {
    nextRun()
    mixer.pause()
    setPlayState('paused')
  }
  const stop = async () => {
    nextRun()
    mixer.stop()
    setPlayState('stopped')
    if (recording) {
      setRecording(false)
      const recorded = await takeRecorder.stop(zeroAt.current)
      if (recorded) setTake(recorded)
    }
  }
  const record = async () => {
    if (!recArmed || !activeStems) return
    const token = nextRun()
    await engine.resume()
    // The take recorder is a node in the global context: wait for other views' renders.
    await whenOfflineIdle()
    if (token !== run) return
    mixer.stop()
    mixer.setMix('lead', { ...st.mix.lead, mute: true })
    await takeRecorder.start()
    setRecording(true)
    zeroAt.current = mixer.play(length + 0.5, false)
    setPlayState('started')
  }
  useEffect(() => {
    if (!recording) mixer.setMix('lead', st.mix.lead)
  }, [recording, st.mix.lead])

  // Keyboard performance for recording a lead take (same layout as the Playground).
  const performer = getPerformer()
  const layout = layoutFor(project)
  useEffect(() => {
    if (project) performer.setTuning(playTuning(project))
  }, [performer, project])
  useKeyboard({
    down: (e) => {
      if (e.code === 'Space') {
        if (playState === 'started') void stop()
        else void play()
        return true
      }
      const i = NOTE_KEYS.indexOf(e.code)
      if (i >= 0 && layout[i]) {
        void engine.resume()
        performer.noteOn(e.code, layout[i]!.string, layout[i]!.stop, { harmonic: e.shiftKey })
        return true
      }
      return false
    },
    up: (e) => {
      if (NOTE_KEYS.includes(e.code)) {
        performer.noteOff(e.code)
        return true
      }
      return false
    }
  })

  const exportMix = async () => {
    if (!activeStems) return
    setExporting(true)
    try {
      const wav = await renderMixWav(activeStems, st.mix, roomId, length)
      await saveFile({ title: 'Export mix', defaultName: `morin-khuur-studio-${st.bpm}bpm.wav`, filters: [{ name: 'WAV audio', extensions: ['wav'] }], data: wav })
    } finally {
      setExporting(false)
    }
  }

  const bars = project ? project.spec.bars : 0
  const bar = project ? barSeconds(project.spec) : 1
  const songMeterMismatch = loaded?.song && quartersPerBar(loaded.song.timeSignature) !== (st.meter === '6/8' ? 3 : 4)

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Transport & project bar */}
      <div className="panel flex items-center gap-5 px-5 py-2.5 narrow:gap-3">
        <div className="flex flex-col items-center gap-1">
          <span className="text-[11px] text-muted">Transport Controls</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="btn h-11 w-12 px-0 narrow:w-10"
              data-on={recording}
              style={{ '--btn-accent': 'var(--color-rec)' } as React.CSSProperties}
              onClick={() => void (recording ? stop() : record())}
              disabled={!recArmed || rendering !== null}
              title={recArmed ? 'Record a lead take from the keyboard' : 'Arm the Lead track (●) to record'}
              aria-label="Record"
            >
              <Circle className="h-5 w-5 fill-rec text-rec" />
            </button>
            <button type="button" className="btn h-11 w-12 px-0" onClick={() => void play()} disabled={rendering !== null || playState === 'started'} aria-label="Play">
              <Play className="h-5 w-5 fill-go text-go" />
            </button>
            <button type="button" className="btn h-11 w-12 px-0" onClick={pause} disabled={playState !== 'started' || recording} aria-label="Pause">
              <Pause className="h-5 w-5" />
            </button>
            <button type="button" className="btn h-11 w-12 px-0" onClick={() => void stop()} aria-label="Stop">
              <Square className="h-4 w-4 fill-current" />
            </button>
            <button
              type="button"
              className="btn h-11 w-12 px-0 narrow:w-10"
              data-on={st.loop}
              style={{ '--btn-accent': 'var(--color-go)' } as React.CSSProperties}
              onClick={() => st.set({ loop: !st.loop })}
              aria-label="Loop"
            >
              <Repeat className="h-5 w-5 text-go" />
            </button>
          </div>
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-[11px] text-muted">Master Volume</span>
          <div className="flex items-center gap-2">
            <input type="range" min={-40} max={6} value={masterDb} onChange={(e) => setMasterDb(Number(e.target.value))} aria-label="Master volume" className="w-36 accent-[var(--color-bilag)] narrow:w-24" />
            <StereoMeter className="origin-left scale-75 narrow:hidden" />
          </div>
        </div>
        <div className="lcd flex flex-col items-center px-4 py-1">
          <span className="text-[10px] text-muted">BPM</span>
          <input
            type="number"
            min={40}
            max={220}
            value={st.bpm}
            onChange={(e) => st.set({ bpm: Math.min(220, Math.max(40, Number(e.target.value) || 96)) })}
            className="w-16 bg-transparent text-center text-2xl font-semibold tabular-nums outline-none"
            aria-label="Tempo"
          />
        </div>
        <label className="lcd flex flex-col items-center px-3 py-1">
          <span className="text-[10px] text-muted">Time Signature</span>
          <select
            value={st.meter}
            onChange={(e) => st.set({ meter: e.target.value as StudioMeter })}
            className="bg-transparent text-xl font-semibold outline-none"
            aria-label="Time signature"
          >
            <option value="6/8">6/8 Gallop</option>
            <option value="4/4">4/4 Töwöö</option>
          </select>
        </label>
        <div className="narrow:hidden">
          <Knob label="Steppe Reverb" value={st.steppeReverb} min={0} max={1} defaultValue={0.45} onChange={(v) => st.set({ steppeReverb: v })} format={(v) => `${Math.round(v * 100)}%`} size={44} />
        </div>
        <div className="lcd ml-auto flex flex-col items-center px-5 py-1">
          <span className="text-[10px] text-muted">Project</span>
          <span ref={clockRef} className="text-2xl font-light tabular-nums">
            00:00:00
          </span>
        </div>
      </div>

      {/* Arrangement */}
      <div className="panel flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2 narrow:gap-2">
          {/* Only the title gives way; what depends on the song or a take lives below (ruler, lead lane), so this row never changes. */}
          <span className="min-w-0 truncate text-sm text-muted narrow:hidden">Multi-Track Arrangement</span>
          <span className="shrink-0 whitespace-nowrap text-xs text-faint narrow:hidden">Lead from</span>
          <Select
            label="Lead song"
            value={entry?.id ?? ''}
            options={entries.map((e) => ({ value: e.id, label: e.title }))}
            onChange={(id) => {
              setTake(null)
              st.set({ songId: id })
            }}
            className="w-60"
          />
          <Select label="Lead playing style" value={leadStyle} options={styleOptions(loaded?.song ?? null)} onChange={(v) => st.set({ leadStyle: v })} className="w-44 narrow:w-40" />
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted" title="How often the lead's playing style adds ornaments (1× = the style's own density)">
            Ornaments
            <input
              type="range"
              min={ORNAMENT_AMOUNT.min}
              max={ORNAMENT_AMOUNT.max}
              step={ORNAMENT_AMOUNT.step}
              value={st.ornamentAmount}
              onChange={(e) => st.set({ ornamentAmount: Number(e.target.value) })}
              disabled={leadAsWritten}
              aria-label="Lead ornament amount"
              className="w-16 accent-[var(--color-bilag)] disabled:opacity-40"
            />
            <span className="w-8 text-right tabular-nums">{st.ornamentAmount.toFixed(1)}×</span>
          </label>
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
            Min. bars
            <input
              type="number"
              min={1}
              max={64}
              value={st.bars}
              onChange={(e) => st.set({ bars: Math.min(64, Math.max(1, Number(e.target.value) || 8)) })}
              className="field h-8 w-16"
            />
          </label>
          <button type="button" className="btn btn-sm ml-auto" onClick={() => void exportMix()} disabled={!activeStems || exporting}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export mix (WAV)
          </button>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col overflow-auto">
          {/* Ruler */}
          <div className="sticky top-0 z-10 flex h-6 border-b border-line bg-panel-2">
            {/* Above the track names, beside the bar numbers it is about: the same fixed width at any window size. */}
            <div className="flex w-[300px] shrink-0 items-center border-r border-line px-3">
              {songMeterMismatch && loaded?.song && (
                <span
                  className="flex min-w-0 items-center gap-1 text-[11px] text-[#f6c945]"
                  title={`The lead song is in ${loaded.song.timeSignature.beats}/${loaded.song.timeSignature.unit}; the accompaniment and the bars follow ${st.meter}.`}
                >
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    Lead song in {loaded.song.timeSignature.beats}/{loaded.song.timeSignature.unit} · accompaniment in {st.meter}
                  </span>
                </span>
              )}
            </div>
            <div
              className="relative flex-1 cursor-pointer"
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                mixer.seek(((e.clientX - r.left) / r.width) * length)
              }}
            >
              {Array.from({ length: bars }, (_, i) => (
                <span key={i} className="absolute top-1 text-[10px] tabular-nums text-faint" style={{ left: `${((i * bar) / Math.max(length, 1e-6)) * 100}%` }}>
                  {i + 1}
                </span>
              ))}
            </div>
          </div>
          <div className="relative flex flex-1 flex-col">
            {TRACKS.map((t) => (
              <TrackLane
                key={t.id}
                id={t.id}
                name={t.name}
                color={t.color}
                stem={activeStems?.[t.id] ?? null}
                length={length}
                mix={st.mix[t.id]}
                isTake={t.id === 'lead' && take !== null}
                onUseSong={t.id === 'lead' ? () => setTake(null) : undefined}
                armed={t.id === 'lead' && recArmed}
                onArm={t.id === 'lead' ? () => setRecArmed(!recArmed) : undefined}
                onMix={(patch) => st.setMix(t.id, patch)}
              />
            ))}
            <div className="pointer-events-none absolute inset-y-0 left-[300px] right-0">
              <div ref={playheadRef} className="absolute inset-y-0 w-0.5 bg-white/90 shadow-[0_0_8px_white]" style={{ left: 0 }} />
            </div>
            {rendering !== null && (
              <div className="absolute inset-0 left-[300px] flex items-center justify-center bg-black/40 text-sm text-muted">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Rendering stems {rendering}/4…
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Studio instrument */}
      <div className="panel grid h-56 shrink-0 grid-cols-[1.1fr_1.3fr_0.8fr_auto] items-center gap-6 px-6 py-3 short:h-44 narrow:gap-4">
        <div className="flex h-full min-w-0 flex-col">
          <div className="text-2xl font-bold leading-tight">Morin Khuur</div>
          <div className="text-xs text-muted">studio instrument · keys A–' play along, ● arms a take</div>
          <div className="min-h-0 flex-1">{project && <InstrumentView className="h-full" tuning={project.tuning} levels={() => engine.morinKhuur().levels()} />}</div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">Bow track</span>
          <div className="relative h-24 overflow-hidden rounded-lg border border-line-2">
            <div className="absolute inset-y-0 left-0 w-1/2" style={{ background: BOW_TRACK[LEFT_STROKE].bg }} />
            <div className="absolute inset-y-0 right-0 w-1/2" style={{ background: BOW_TRACK[RIGHT_STROKE].bg }} />
            <span className="absolute left-[25%] top-2 -translate-x-1/2 text-sm font-semibold">{BOW_INFO[LEFT_STROKE].name}</span>
            <span className="absolute left-[75%] top-2 -translate-x-1/2 text-sm font-semibold">{BOW_INFO[RIGHT_STROKE].name}</span>
            <div ref={bowRef} className="absolute inset-x-[10%] top-12 transition-transform duration-75">
              <div className="h-1.5 rounded-full bg-[#6b3a1c]" />
              <div className="mx-2 mt-1 h-[2px] bg-[#f3ead8]" />
            </div>
            <div className="absolute inset-y-0 left-1/2 w-px bg-white/30" />
          </div>
          <div className="flex justify-between text-[11px]">
            <span style={{ color: BOW_TRACK[LEFT_STROKE].fg }}>{BOW_INFO[LEFT_STROKE].english.toLowerCase()}</span>
            <span className="text-faint">0</span>
            <span style={{ color: BOW_TRACK[RIGHT_STROKE].fg }}>{BOW_INFO[RIGHT_STROKE].english.toLowerCase()}</span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">Fingernail side-stopping</span>
          <div className="relative h-28 rounded-lg border border-line-2 bg-[#15120f]">
            {(['male', 'female'] as const).map((s, i) => (
              <div key={s} className="absolute inset-y-2" style={{ left: `${35 + i * 30}%` }}>
                <div className="absolute inset-y-0 w-px bg-[#efe6d2]/70" />
                <div
                  ref={(el) => void (dotRefs.current[s] = el)}
                  className="absolute -left-2 h-4 w-4 rounded-full border-2 transition-[top] duration-100"
                  style={{ borderColor: s === 'male' ? 'var(--color-arga)' : 'var(--color-bilag)', background: '#2a2520', top: '8%', opacity: 0.25 }}
                />
              </div>
            ))}
            <span className="absolute bottom-1 left-2 text-[9px] text-faint">nut ↑</span>
          </div>
        </div>
        <div className="flex gap-4">
          <Knob label="Steppe Reverb" value={st.steppeReverb} min={0} max={1} defaultValue={0.45} onChange={(v) => st.set({ steppeReverb: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Knob label="Ger Ambience" value={st.gerAmbience} min={0} max={1} defaultValue={0.15} onChange={(v) => st.set({ gerAmbience: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Knob label="Vibrato Depth" value={st.vibrato} min={0} max={60} step={1} defaultValue={22} onChange={(v) => st.set({ vibrato: v })} format={(v) => `${v}¢`} />
        </div>
      </div>
    </div>
  )
}

function TrackLane({
  id,
  name,
  color,
  stem,
  length,
  mix,
  isTake,
  onUseSong,
  armed,
  onArm,
  onMix
}: {
  id: TrackId
  name: string
  color: string
  stem: Tone.ToneAudioBuffer | null
  length: number
  mix: { volume: number; mute: boolean; solo: boolean }
  isTake: boolean
  /** Discards the recorded take (offered while the lane plays one). */
  onUseSong?: () => void
  armed: boolean
  onArm?: () => void
  onMix(patch: Partial<{ volume: number; mute: boolean; solo: boolean }>): void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const Icon = ICONS[id]

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = w * devicePixelRatio
      canvas.height = h * devicePixelRatio
      const ctx = canvas.getContext('2d')!
      ctx.scale(devicePixelRatio, devicePixelRatio)
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = `${color}22`
      ctx.fillRect(0, 0, w, h)
      if (!stem || length <= 0) return
      const visible = Math.min(1, stem.duration / length)
      const cols = Math.max(1, Math.floor(w * visible))
      const p = peaks(stem, cols)
      let max = 0.001
      for (const v of p) max = Math.max(max, Math.abs(v))
      ctx.fillStyle = color
      for (let x = 0; x < cols; x++) {
        const lo = (p[x * 2]! / max) * (h / 2 - 3)
        const hi = (p[x * 2 + 1]! / max) * (h / 2 - 3)
        ctx.fillRect(x, h / 2 - hi, 1, Math.max(1, hi - lo))
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [stem, length, color])

  return (
    <div className="flex min-h-16 flex-1 border-b border-line">
      <div className="flex w-[300px] shrink-0 items-center gap-3 border-r border-line pl-0 pr-3" style={{ boxShadow: `inset 6px 0 0 ${color}` }}>
        <Icon className="ml-5 h-6 w-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">
            {name}
            {isTake && <span className="ml-1 text-[10px] text-rec">(take)</span>}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button type="button" className="btn h-6 w-7 px-0 text-[11px]" data-on={mix.mute} onClick={() => onMix({ mute: !mix.mute })} aria-label={`Mute ${name}`}>
              M
            </button>
            <button
              type="button"
              className="btn h-6 w-7 px-0 text-[11px]"
              data-on={mix.solo}
              style={{ '--btn-accent': '#f6c945' } as React.CSSProperties}
              onClick={() => onMix({ solo: !mix.solo })}
              aria-label={`Solo ${name}`}
            >
              S
            </button>
            <button
              type="button"
              className="btn h-6 w-7 px-0"
              data-on={armed}
              disabled={!onArm}
              style={{ '--btn-accent': 'var(--color-rec)' } as React.CSSProperties}
              onClick={onArm}
              aria-label={`Arm ${name} for recording`}
              title={onArm ? 'Arm to record a take from the keyboard' : 'Generated track'}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${onArm ? 'bg-rec' : 'bg-faint'}`} />
            </button>
            <input
              type="range"
              min={-30}
              max={6}
              step={0.5}
              value={mix.volume}
              onChange={(e) => onMix({ volume: Number(e.target.value) })}
              aria-label={`${name} volume`}
              className="ml-1 w-24"
              style={{ accentColor: color }}
            />
          </div>
        </div>
      </div>
      {/* Absolutely positioned so the canvas's pixel size never feeds back into the layout. */}
      <div className="relative min-w-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {isTake && onUseSong && (
          <button type="button" className="btn btn-sm absolute right-2 top-2" onClick={onUseSong} title="Discard the recorded take and use the song again">
            <Undo2 className="h-4 w-4" /> Use song
          </button>
        )}
      </div>
    </div>
  )
}
